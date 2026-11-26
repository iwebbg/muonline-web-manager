"""Website configuration boundaries using disposable files; no SQL, Docker or providers."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_runtime import module

worker = module('site_settings_worker', 'runtime/worker.py')


class SiteSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(worker, key, self.root / value) for key, value in
                        [('ROOT', '.'), ('APP', 'application'), ('STATE', 'state.json'), ('COMPOSE', 'compose.json')]]
        for item in self.patches:
            item.start()
        worker.APP.mkdir()
        (worker.APP / 'config').mkdir()
        (worker.APP / 'config/services.php').write_text('\n'.join("env('" + field['key'] + "')" for field in worker.SITE_FIELDS))
        self.state = {'phase': 'ready', 'version': '1.4.0', 'access': worker.access_settings({'mode': 'local'}),
                      'environment': {'APP_KEY': 'private-app-key', 'DB_PASSWORD': 'private-db-password'}}
        worker.save_state(self.state)
        self.original = ('# preserve comments\nAPP_KEY=actual-rotated-key\nAPP_URL=https://mu.example.test\n'
                         'STRIPE_ENABLED="true"\nSTRIPE_SECRET_KEY="old-private-api"\nSTRIPE_WEBHOOK_SECRET="old-private-webhook"\n'
                         'MAIL_MAILER=log\nMAIL_USERNAME="old-smtp-user"\nMAIL_PASSWORD="old-smtp-password"\n'
                         'APP_NAME="Original"\nCUSTOM="first\nAPP_NAME=literal\nlast"\n')
        worker.atomic(worker.APP / '.env', self.original)
        worker.DIAGNOSTIC_SECRETS.clear()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def request(self, changes):
        return {'confirmed': True, 'revision': worker.site_settings(self.state)['revision'], 'changes': changes}

    def apply(self, changes, compose=None):
        with patch.object(worker, 'compose', side_effect=compose) as mock, patch.object(worker.os, 'chown', create=True):
            result = worker.apply_site_settings(self.state, self.request(changes))
        return result, mock

    def test_snapshot_has_actual_public_values_but_never_private_values(self):
        result = worker.site_settings(self.state)
        self.assertEqual(result['values']['APP_NAME'], 'Original')
        self.assertTrue(result['configured']['STRIPE_SECRET_KEY'])
        for secret in ['old-private-api', 'old-private-webhook', 'old-smtp-user', 'old-smtp-password', 'actual-rotated-key', 'private-db-password']:
            self.assertNotIn(secret, json.dumps(result))
        self.assertFalse(result['s3DriverInstalled'])

    def test_apply_preserves_unrelated_multiline_values_actual_key_and_secrets(self):
        result, compose = self.apply({'APP_NAME': 'Changed $literal "quoted" \\ name'})
        content, values = worker.site_environment()
        self.assertEqual(values['APP_NAME'], 'Changed $literal "quoted" \\ name')
        self.assertEqual(values['APP_KEY'], 'actual-rotated-key')
        self.assertIn('CUSTOM="first\nAPP_NAME=literal\nlast"\n', content)
        self.assertEqual(values['STRIPE_SECRET_KEY'], 'old-private-api')
        self.assertEqual(result['values']['APP_NAME'], values['APP_NAME'])
        self.assertEqual(worker.load_state()['environment']['APP_NAME'], values['APP_NAME'])
        calls = [call.args for call in compose.call_args_list]
        self.assertEqual(calls[0], ('stop', 'queue', 'scheduler'))
        self.assertIn(('run', '--rm', '--no-deps', '--entrypoint', 'php', 'app', 'artisan', 'config:clear', '--no-interaction'), calls)
        self.assertIn(('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300'), calls)
        self.assertFalse(any('migrate' in call for call in calls))
        self.assertEqual(next((self.root / 'backups').glob('*/.env')).read_text(), self.original)

    def test_disable_provider_and_clear_secret_without_changing_other_provider_keys(self):
        result, _ = self.apply({'STRIPE_ENABLED': 'false', 'STRIPE_SECRET_KEY': {'operation': 'clear'}})
        self.assertFalse(result['configured']['STRIPE_SECRET_KEY'])
        self.assertTrue(result['configured']['STRIPE_WEBHOOK_SECRET'])

    def test_replace_secret_round_trips_literal_metacharacters_only_through_env(self):
        secret = 'new-$KEY-${APP_KEY}-"quote"-\\-`$(command)`'
        _, compose = self.apply({'STRIPE_SECRET_KEY': {'operation': 'replace', 'value': secret}})
        self.assertEqual(worker.site_environment()[1]['STRIPE_SECRET_KEY'], secret)
        self.assertNotIn(secret, str(compose.call_args_list))
        self.assertIn(secret, worker.DIAGNOSTIC_SECRETS)
        self.assertNotIn(secret, worker.redact_development_output(secret))

    def test_cannot_enable_incomplete_provider_clear_active_credentials_or_send_injections(self):
        bad = [
            {'PAYPAL_ENABLED': 'true'},
            {'STRIPE_SECRET_KEY': {'operation': 'clear'}},
            {'APP_KEY': 'replace'}, {'DB_PASSWORD': 'replace'}, {'FILESYSTEM_DISK': 's3'},
            {'APP_NAME': 'injected\nAPP_DEBUG=true'},
            {'AWS_ENDPOINT': 'https://user:pass@storage.test'},
            {'MAIL_PORT': '0'}, {'SESSION_LIFETIME': '1.5'},
            {'RECAPTCHA_ENABLED': 'true'}, {'GAME_EVENT_TIMEZONE': '../bad'},
            {'STRIPE_SECRET_KEY': {'operation': 'replace', 'value': ''}},
            {'STRIPE_SECRET_KEY': {'operation': 'keep', 'value': 'bad'}},
            {'MAIL_URL': {'operation': 'replace', 'value': 'smtp://user:pass@host'}},
        ]
        for changes in bad:
            with self.subTest(changes=list(changes)), patch.object(worker, 'compose') as compose:
                with self.assertRaises(ValueError):
                    worker.apply_site_settings(self.state, self.request(changes))
                compose.assert_not_called()
                self.assertEqual((worker.APP / '.env').read_text(), self.original)

    def test_effective_smtp_url_must_be_explicitly_cleared(self):
        worker.atomic(worker.APP / '.env', self.original + 'MAIL_URL="smtp://hidden-user:hidden-password@host"\n')
        with self.assertRaisesRegex(ValueError, 'SMTP URL'):
            self.apply({'MAIL_HOST': 'smtp.example.test'})
        result, _ = self.apply({'MAIL_URL': {'operation': 'clear'}, 'MAIL_HOST': 'smtp.example.test'})
        self.assertFalse(result['configured']['MAIL_URL'])
        self.assertEqual(result['values']['MAIL_HOST'], 'smtp.example.test')

    def test_stale_revision_unconfirmed_and_not_ready_are_refused_without_effects(self):
        request = self.request({'APP_NAME': 'New'})
        worker.atomic(worker.APP / '.env', self.original + '# changed elsewhere\n')
        with patch.object(worker, 'compose') as compose:
            with self.assertRaisesRegex(ValueError, 'changed'):
                worker.apply_site_settings(self.state, request)
            request = self.request({'APP_NAME': 'New'})
            request['confirmed'] = False
            with self.assertRaises(ValueError):
                worker.apply_site_settings(self.state, request)
            self.state['phase'] = 'site-settings-changing'
            with self.assertRaises(ValueError):
                worker.site_settings(self.state)
            compose.assert_not_called()

    def test_failed_health_check_restores_exact_env_and_state_then_recreates(self):
        original_state = worker.STATE.read_bytes()
        calls = []
        def fail_once(*args, **kwargs):
            calls.append(args)
            if args[0] == 'up' and sum(call[0] == 'up' for call in calls) == 1:
                raise RuntimeError('mock health failure with private output')
        with self.assertRaisesRegex(RuntimeError, 'previous configuration restored'):
            self.apply({'APP_NAME': 'New'}, fail_once)
        self.assertEqual((worker.APP / '.env').read_text(), self.original)
        self.assertEqual(worker.STATE.read_bytes(), original_state)
        self.assertEqual(sum(call[0] == 'up' for call in calls), 2)

    def test_failed_recovery_checkpoints_and_blocks_normal_start(self):
        def fail(*args, **kwargs):
            if args[0] == 'up':
                raise RuntimeError('mock failure')
        with self.assertRaisesRegex(RuntimeError, 'Recover configuration manually'):
            self.apply({'APP_NAME': 'New'}, fail)
        self.assertEqual(worker.load_state()['phase'], 'site-settings-recovery-required')
        with patch.object(worker, 'compose') as compose:
            with self.assertRaises(ValueError):
                worker.dispatch({'action': 'start'})
            compose.assert_not_called()

    def test_older_release_capabilities_are_detected_and_not_editable(self):
        (worker.APP / 'config/services.php').write_text("env('APP_NAME');")
        result = worker.site_settings(self.state)
        self.assertFalse(next(f for f in result['fields'] if f['key'] == 'REVOLUT_TAG')['supported'])
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            self.apply({'REVOLUT_TAG': 'tag'})

    def test_dotenv_expansion_comments_and_duplicate_keys(self):
        worker.atomic(worker.APP / '.env', self.original + 'MAIL_FROM_NAME="${APP_NAME}"\nMAIL_PORT=587 # comment\n')
        values = worker.site_environment()[1]
        self.assertEqual(values['MAIL_FROM_NAME'], 'Original')
        self.assertEqual(values['MAIL_PORT'], '587')
        worker.atomic(worker.APP / '.env', self.original + 'APP_NAME=duplicate\n')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            worker.site_settings(self.state)

    def test_s3_driver_detection_preparation_and_saved_settings_survive_access_config(self):
        metadata = worker.APP / 'vendor/composer/installed.json'
        metadata.parent.mkdir(parents=True)
        metadata.write_text(json.dumps({'packages': [{'name': 'league/flysystem-aws-s3-v3'}]}))
        result, _ = self.apply({'AWS_SECRET_ACCESS_KEY': {'operation': 'replace', 'value': 's3-private'}, 'AWS_ENDPOINT': 'https://r2.example.test'})
        self.assertTrue(result['s3DriverInstalled'])
        self.assertNotIn('s3-private', json.dumps(result))
        self.assertEqual(result['webhooks']['stripe'], 'http://localhost/payments/webhooks/stripe')
        with patch.object(worker.os, 'chown', create=True):
            worker.write_configuration(self.state)
        self.assertEqual(worker.site_environment()[1]['AWS_SECRET_ACCESS_KEY'], 's3-private')
        self.assertNotIn('FILESYSTEM_DISK=', (worker.APP / '.env').read_text())

    def test_public_http_cannot_enable_an_automated_payment_provider(self):
        worker.atomic(worker.APP / '.env', self.original.replace('https://mu.example.test', 'http://localhost'))
        with self.assertRaisesRegex(ValueError, r'Domain \+ SSL'):
            self.apply({'STRIPE_ENABLED': 'true'})

    def test_schema_only_references_real_laravel_config_and_keeps_dangerous_keys_out(self):
        # Local read-only contract reference is optional in standalone CI checkouts.
        reference = Path(__file__).resolve().parents[2] / 'muonline-web-laravel/config'
        if not reference.exists():
            self.skipTest('Sibling Laravel reference is unavailable.')
        with patch.object(worker, 'APP', reference.parent):
            supported = worker.site_supported_fields()
        keys = {field['key'] for field in worker.SITE_FIELDS}
        self.assertFalse(keys - supported)
        self.assertFalse(keys & {'APP_KEY', 'APP_DEBUG', 'APP_ENV', 'APP_URL', 'DB_PASSWORD', 'GAME_WRITES_ENABLED', 'FILESYSTEM_DISK', 'MAIL_SENDMAIL_PATH', 'RECAPTCHA_VERIFY_URL', 'STRIPE_BASE_URL'})
