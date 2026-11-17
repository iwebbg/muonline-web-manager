"""Exercise privileged worker boundaries without WSL, Docker or real database changes."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import stat


def module(name, relative):
    """Load runtime scripts as modules without executing their command entrypoints."""
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / relative)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


worker = module('worker', 'runtime/worker.py')
packager = module('packager', 'scripts/package-release.py')


class RuntimeTests(unittest.TestCase):
    """Check secrets, access changes, staging and recovery decisions using disposable files."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.patches = [patch.object(worker, 'ROOT', self.root), patch.object(worker, 'APP', self.root / 'application'), patch.object(worker, 'STATE', self.root / 'state.json'), patch.object(worker, 'COMPOSE', self.root / 'compose.json'), patch.object(worker, 'RENEWAL_TIMER', self.root / 'renewal.timer')]
        for item in self.patches:
            item.start()
        worker.APP.mkdir()
        self.state = {'version': '1.3.0', 'phase': 'ready', 'access': worker.access_settings({'mode': 'local'}), 'environment': {'APP_KEY': 'original-key', 'APP_ENV': 'production', 'DB_HOST': 'sql.example', 'DB_PORT': '1433', 'DB_USERNAME': 'web_app', 'DB_DATABASE': 'Web', 'GAME_DB_MUONLINE': 'Game'}}
        worker.save_state(self.state)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def test_storage_parents_belong_to_runtime_identity_without_changing_code_owner(self):
        (worker.APP / 'public').mkdir()
        (worker.APP / 'public/storage').mkdir()  # Ownership test does not require Windows symlink privileges.
        (worker.APP / 'bootstrap').mkdir()
        upload = worker.APP / 'storage/app/public/existing.txt'
        upload.parent.mkdir(parents=True)
        upload.write_text('keep existing upload')
        with patch.object(worker, 'run'), patch.object(worker.os, 'chown', create=True) as chown:
            worker.initialize_storage()
        owned = {call.args[0] for call in chown.call_args_list}
        for relative in ('storage', 'storage/app', 'storage/framework', 'storage/framework/cache'):
            self.assertIn(worker.APP / relative, owned)
        self.assertNotIn(worker.APP, owned)
        self.assertNotIn(worker.APP / 'bootstrap', owned)
        self.assertEqual(upload.read_text(), 'keep existing upload')

    def test_resume_repairs_storage_before_entering_bootstrap(self):
        order = []
        with patch.object(worker, 'initialize_storage', side_effect=lambda: order.append('storage')), patch.object(worker, 'finish_install', side_effect=lambda *args: order.append('bootstrap')):
            worker.dispatch({'action': 'resumeInstall', 'settings': {}})
        self.assertEqual(order, ['storage', 'bootstrap'])

    def test_game_write_change_preserves_environment_and_recreates_project(self):
        original = b'APP_KEY=keep-key\nCUSTOM="first\nlast"\nGAME_DB_READONLY="true"\nGAME_WRITES_ENABLED="false"\n'
        (worker.APP / '.env').write_bytes(original)
        with patch.object(worker, 'compose', return_value='') as compose, patch.object(worker.os, 'chown', create=True):
            result = worker.apply_game_writes(self.state, {'enabled': True, 'confirmed': True, 'expectedMode': 'disabled'})
        self.assertEqual(result, {'gameWrites': 'enabled', 'restarted': True})
        self.assertEqual(worker.game_write_mode(), 'enabled')
        self.assertEqual(worker.load_state()['environment']['GAME_DB_READONLY'], 'false')
        content = (worker.APP / '.env').read_text()
        self.assertIn('APP_KEY=keep-key\n', content)
        self.assertIn('CUSTOM="first\nlast"\n', content)
        self.assertIn(('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300'), [call.args for call in compose.call_args_list])
        self.assertTrue(any('--entrypoint' in call.args and 'config:clear' in call.args for call in compose.call_args_list))
        self.assertFalse(any('migrate' in call.args or 'restart' in call.args for call in compose.call_args_list))

    def test_game_write_change_requires_confirmation_and_fresh_status(self):
        (worker.APP / '.env').write_text('GAME_DB_READONLY=true\nGAME_WRITES_ENABLED=false\n')
        with patch.object(worker, 'compose') as compose:
            for settings in [{'enabled': True, 'confirmed': False}, {'enabled': 'true', 'confirmed': True}, {'enabled': True, 'confirmed': True, 'expectedMode': 'enabled'}]:
                with self.assertRaises(ValueError):
                    worker.apply_game_writes(self.state, settings)
            result = worker.apply_game_writes(self.state, {'enabled': False, 'confirmed': True, 'expectedMode': 'disabled'})
        compose.assert_not_called()
        self.assertFalse(result['restarted'])

    def test_game_write_failure_restores_exact_files_and_blocks_start_if_recovery_fails(self):
        for recovery_fails in (False, True):
            original = b'APP_KEY=keep\r\nGAME_DB_READONLY="true"\r\nGAME_WRITES_ENABLED="false"\r\n'
            (worker.APP / '.env').write_bytes(original)
            worker.save_state(self.state)
            state_bytes = worker.STATE.read_bytes()
            attempts = []
            def restart(*args, **kwargs):
                if args[0] == 'up':
                    attempts.append(1)
                    if recovery_fails or len(attempts) == 1:
                        raise RuntimeError('restart failure')
                return ''
            with patch.object(worker, 'compose', side_effect=restart), patch.object(worker.os, 'chown', create=True):
                with self.assertRaisesRegex(RuntimeError, 'recovery failed' if recovery_fails else 'previous configuration restored'):
                    worker.apply_game_writes(self.state, {'enabled': True, 'confirmed': True, 'expectedMode': 'disabled'})
            self.assertEqual((worker.APP / '.env').read_bytes(), original)
            if recovery_fails:
                self.assertEqual(worker.load_state()['phase'], 'game-writes-recovery-required')
                with self.assertRaisesRegex(ValueError, 'manual recovery'):
                    worker.dispatch({'action': 'start'})
            else:
                self.assertEqual(worker.STATE.read_bytes(), state_bytes)

    def test_password_policy_has_32_bytes_and_suffix(self):
        values = {worker.password() for _ in range(100)}
        self.assertEqual(len(values), 100)
        for value in values:
            self.assertRegex(value, r'^[a-f0-9]{64}Ss@$')

    def test_sql_identifier_and_dotenv_injection_boundaries(self):
        for value in ['sa', 'Master', 'web; DROP DATABASE x', 'A\nB', '../db']:
            with self.assertRaises(ValueError):
                worker.identifier(value)
        with self.assertRaises(ValueError):
            worker.env_text({'DB_HOST': 'abc\nAPP_DEBUG=true'})
        self.assertIn(r'\$(', worker.env_text({'PASSWORD': '$(touch /tmp/x)"\\Ss@'}))

    def test_access_is_separate_from_app_env_and_local_binds_loopback(self):
        config = worker.compose_config(worker.access_settings({'mode': 'local'}))
        self.assertEqual(config['services']['nginx']['ports'], ['127.0.0.1:80:80'])
        self.assertNotIn('APP_ENV', config['services']['app']['environment'])
        for mode, host in [('domain', 'example.com; evil'), ('ip', '1.2.3.4; evil')]:
            with self.assertRaises(ValueError):
                worker.access_settings({'mode': mode, 'host': host})
        with self.assertRaises(ValueError):
            worker.access_settings({'mode': 'ip', 'host': '192.0.2.1'})
        access = worker.access_settings({'mode': 'ip', 'host': '2001:db8::1', 'httpAcknowledged': True})
        self.assertEqual(access['url'], 'http://[2001:db8::1]')

    def test_domain_does_not_serve_the_site_before_certificate_is_ready(self):
        access = worker.access_settings({'mode': 'domain', 'host': 'mu.example.com', 'email': 'owner@example.com'})
        challenge_config = worker.nginx_config(access, tls=False)
        self.assertIn('return 503', challenge_config)
        self.assertNotIn('fastcgi_pass', challenge_config)
        tls_config = worker.nginx_config(access, tls=True)
        self.assertIn('/live/mu.example.com/fullchain.pem', tls_config)
        self.assertIn('fastcgi_param HTTPS on', tls_config)

    def test_zip_rejects_traversal_symlinks_and_mutable_runtime_files(self):
        for name in ['../escape', '/etc/passwd', '.env', 'storage/app/public/upload', 'vendor/autoload.php', 'a\\b', 'C:/escape', 'public/file\x00suffix']:
            archive = self.root / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                # ZipInfo normalizes backslashes on Windows; preserve the deliberately unsafe fixture.
                entry = zipfile.ZipInfo()
                entry.filename = name
                entry.orig_filename = name
                bundle.writestr(entry, 'evil')
            # ZIP reading also normalizes separators on Windows; the worker runs on Linux.
            with self.assertRaises(ValueError), patch.object(zipfile.os, 'sep', '/'):
                worker.safe_extract(archive, self.root / 'extracted', 'application')
        with zipfile.ZipFile(self.root / 'link.zip', 'w') as bundle:
            entry = zipfile.ZipInfo('link')
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(entry, '/etc/passwd')
        with self.assertRaises(ValueError):
            worker.safe_extract(self.root / 'link.zip', self.root / 'extracted', 'application')

    def test_raw_zip_backslash_is_rejected_before_windows_filename_normalization(self):
        archive = self.root / 'raw-path.zip'
        entry = zipfile.ZipInfo()
        entry.filename = entry.orig_filename = 'public\\file.txt'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr(entry, 'unsafe')
        with patch.object(zipfile.os, 'sep', '\\'):
            with zipfile.ZipFile(archive) as bundle:
                self.assertEqual(bundle.infolist()[0].filename, 'public/file.txt')
                self.assertEqual(bundle.infolist()[0].orig_filename, 'public\\file.txt')
            with self.assertRaises(ValueError):
                worker.safe_extract(archive, self.root / 'extracted', 'application')
        self.assertFalse((self.root / 'extracted').exists())

    def test_atomic_text_preserves_crlf_without_platform_newline_expansion(self):
        content = 'APP_KEY=unchanged\r\nCUSTOM="Първи\r\nВтори"\r\n'
        real_fdopen = os.fdopen

        def windows_fdopen(descriptor, mode, *args, **kwargs):
            if mode == 'w':
                kwargs.update(newline='\r\n', encoding='utf-8')
            return real_fdopen(descriptor, mode, *args, **kwargs)

        destination = self.root / 'windows.env'
        with patch.object(worker.os, 'fdopen', side_effect=windows_fdopen):
            worker.atomic(destination, content)
        self.assertEqual(destination.read_bytes(), content.encode('utf-8'))

    def test_access_failure_restores_previous_config_and_key(self):
        calls = []
        failed = False

        def compose(*args, **kwargs):
            nonlocal failed
            calls.append(args)
            if args[:2] == ('up', '-d') and not failed:
                failed = True
                raise RuntimeError('simulated nginx failure')
            return ''

        with patch.object(worker, 'compose', side_effect=compose), patch.object(worker.os, 'chown', create=True):
            worker.write_configuration(self.state)
            with self.assertRaisesRegex(RuntimeError, 'previous configuration restored'):
                worker.apply_access(self.state, {'mode': 'ip', 'host': '192.0.2.10', 'httpAcknowledged': True})
        self.assertEqual(self.state['access']['mode'], 'local')
        self.assertIn('original-key', (worker.APP / '.env').read_text())
        self.assertEqual(json.loads(worker.STATE.read_text())['access']['mode'], 'local')
        self.assertTrue(list((self.root / 'backups').glob('access-*')))

    def test_no_automatic_database_rollback_after_migration_failure(self):
        staging = self.root / 'staging/version'
        staging.mkdir(parents=True)
        (worker.APP / '.env').write_text('APP_KEY=unchanged')
        calls = []

        def compose(*args, **kwargs):
            calls.append(args)
            if 'migrate' in args:
                raise RuntimeError('migration failure')
            return ''

        request = {'release': {'version': '1.4.0', 'profiles': ['test']}, 'backup': {}}
        self.state['environment']['GAME_SERVER_PROFILE'] = 'test'
        worker.save_state(self.state)
        with patch.object(worker, 'validate_backup_configuration'), patch.object(worker, 'stage_release', return_value=staging), patch.object(worker, 'backup', return_value='/private/backup'), patch.object(worker, 'compose', side_effect=compose), patch.object(worker, 'initialize_storage'), patch.object(worker, 'write_configuration'):
            with self.assertRaisesRegex(RuntimeError, 'Do not automatically roll back SQL'):
                worker.update(request)
        record = json.loads(worker.STATE.read_text())
        self.assertEqual(record['phase'], 'migration-recovery-required')
        self.assertFalse(any('rollback' in arg for call in calls for arg in call))
        self.assertFalse(any(call[-2:] == ('up', '--no-interaction') for call in calls))

    def test_successful_update_records_version_only_after_migrations_and_preserves_app_key(self):
        staging = self.root / 'staging/version'
        staging.mkdir(parents=True)
        (worker.APP / '.env').write_text('APP_KEY=original-key')
        self.state['environment']['GAME_SERVER_PROFILE'] = 'test'
        worker.save_state(self.state)
        observed_versions = []

        def compose(*args, **kwargs):
            if 'migrate' in args:
                observed_versions.append(json.loads(worker.STATE.read_text())['version'])
            return ''

        request = {'release': {'version': '1.4.0', 'profiles': ['test']}, 'backup': {}}
        with patch.object(worker, 'validate_backup_configuration'), patch.object(worker, 'stage_release', return_value=staging), patch.object(worker, 'backup', return_value='/private/backup'), patch.object(worker, 'compose', side_effect=compose), patch.object(worker, 'initialize_storage'), patch.object(worker, 'write_configuration'):
            worker.update(request)
        record = json.loads(worker.STATE.read_text())
        self.assertEqual(observed_versions, ['1.3.0'])
        self.assertEqual(record['version'], '1.4.0')
        self.assertEqual(record['phase'], 'ready')
        self.assertEqual(record['environment']['APP_KEY'], 'original-key')
        self.assertIn('original-key', (worker.APP / '.env').read_text())

    def test_update_preserves_actual_env_bytes_including_rotated_key_and_custom_values(self):
        staging = self.root / 'staging/version'
        staging.mkdir(parents=True)
        original = b'# owner settings\r\nAPP_KEY=rotated-key\r\nCUSTOM_ENDPOINT="https://custom.example"\r\n'
        (worker.APP / '.env').write_bytes(original)
        self.state['environment']['GAME_SERVER_PROFILE'] = 'test'
        worker.save_state(self.state)
        request = {'release': {'version': '1.4.0', 'profiles': ['test']}, 'backup': {}}
        with patch.object(worker, 'validate_backup_configuration'), patch.object(worker, 'stage_release', return_value=staging), patch.object(worker, 'backup', return_value='/private/backup'), patch.object(worker, 'compose', return_value=''), patch.object(worker, 'initialize_storage'), patch.object(worker.os, 'chown', create=True):
            worker.update(request)
        self.assertEqual((worker.APP / '.env').read_bytes(), original)

    def test_access_change_preserves_custom_multiline_values_and_actual_app_key(self):
        original = '# keep comments\nAPP_KEY=rotated-key\nCUSTOM="first\nAPP_URL=literal content\nlast"\nAPP_URL=http://localhost\n'
        # Match Linux runtime bytes without Windows text-mode newline translation.
        (worker.APP / '.env').write_bytes(original.encode())
        with patch.object(worker.os, 'chown', create=True):
            self.state['access'] = worker.access_settings({'mode': 'ip', 'host': '192.0.2.10', 'httpAcknowledged': True})
            worker.write_configuration(self.state)
        result = (worker.APP / '.env').read_text()
        self.assertIn('APP_KEY=rotated-key\n', result)
        self.assertIn('CUSTOM="first\nAPP_URL=literal content\nlast"\n', result)
        self.assertIn('APP_URL="http://192.0.2.10"', result)

    def test_failed_access_change_restores_exact_config_files_instead_of_regenerating(self):
        with patch.object(worker.os, 'chown', create=True):
            worker.write_configuration(self.state)
        originals = {worker.STATE: json.dumps(self.state, separators=(',', ':')).encode() + b'\n', worker.COMPOSE: b'{"services": {}}\n', worker.APP / '.env': b'APP_KEY=rotated-key\r\nCUSTOM=keep\r\n', self.root / 'nginx.conf': b'# private custom proxy settings\n'}
        for file, content in originals.items():
            file.write_bytes(content)
        calls = 0

        def compose(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError('changed proxy failed')
            return ''

        with patch.object(worker, 'compose', side_effect=compose), patch.object(worker.os, 'chown', create=True):
            with self.assertRaisesRegex(RuntimeError, 'previous configuration restored'):
                worker.apply_access(self.state, {'mode': 'ip', 'host': '192.0.2.10', 'httpAcknowledged': True})
        for file, content in originals.items():
            self.assertEqual(file.read_bytes(), content)

    def test_ip_install_finishes_with_previously_confirmed_http_access(self):
        self.state['access'] = worker.access_settings({'mode': 'ip', 'host': '192.0.2.5', 'httpAcknowledged': True})
        self.state['phase'] = 'administrator-created'
        worker.save_state(self.state)
        with patch.object(worker, 'compose', return_value=''), patch.object(worker, 'diagnose_sql', return_value={'passed': True}), patch.object(worker.os, 'chown', create=True):
            worker.finish_install(self.state, {})
        self.assertEqual(worker.load_state()['phase'], 'ready')
        self.assertEqual(worker.load_state()['access']['mode'], 'ip')

    def test_failed_initial_domain_access_disables_newly_enabled_renewal_timer(self):
        self.state['access'] = worker.access_settings({'mode': 'domain', 'host': 'mu.example.com', 'email': 'owner@example.com'})
        worker.save_state(self.state)
        with patch.object(worker.os, 'chown', create=True):
            worker.write_configuration(self.state)
        original = (worker.APP / '.env').read_bytes()
        changes = []

        def timer(enabled):
            changes.append(enabled)
            worker.RENEWAL_TIMER.write_text('test unit')

        def compose(*args, **kwargs):
            if '--wait-timeout' in args:
                raise RuntimeError('new runtime unhealthy')
            return ''

        with patch.object(worker, 'compose', side_effect=compose), patch.object(worker, 'issue_certificate'), patch.object(worker, 'renewal_timer', side_effect=timer), patch.object(worker.os, 'chown', create=True):
            with self.assertRaisesRegex(RuntimeError, 'Initial access setup failed'):
                worker.apply_access(self.state, self.state['access'], initial=True)
        self.assertEqual(changes, [True, False])
        self.assertEqual((worker.APP / '.env').read_bytes(), original)

    def test_access_recovery_failure_blocks_start_and_preserves_backup_reference(self):
        with patch.object(worker.os, 'chown', create=True):
            worker.write_configuration(self.state)
            with patch.object(worker, 'compose', side_effect=RuntimeError('services failed')):
                with self.assertRaisesRegex(RuntimeError, 'Access change and recovery failed'):
                    worker.apply_access(self.state, {'mode': 'ip', 'host': '192.0.2.10', 'httpAcknowledged': True})
        record = worker.load_state()
        self.assertEqual(record['phase'], 'access-recovery-required')
        self.assertTrue(Path(record['backup']).is_dir())
        with self.assertRaisesRegex(ValueError, 'manual recovery'):
            worker.dispatch({'action': 'start'})

    def test_stale_sql_configuration_is_rejected_before_update_staging_or_maintenance(self):
        current = {**self.state['environment'], 'DB_DATABASE': 'DifferentDatabase'}
        response = json.dumps({'services': {'app': {'environment': current}}})
        with patch.object(worker, 'compose', return_value=response) as compose, patch.object(worker, 'stage_release') as stage:
            with self.assertRaisesRegex(ValueError, 'SQL targets or game profile differ'):
                worker.update({'release': {'version': '1.4.0', 'profiles': []}})
            stage.assert_not_called()
            self.assertEqual(compose.call_args_list[0].args, ('config', '--format', 'json'))
        self.assertEqual(worker.load_state()['phase'], 'ready')

    def test_backup_configuration_allows_password_rotation_but_rejects_url_overrides(self):
        current = {**self.state['environment'], 'DB_PASSWORD': 'rotated runtime password'}
        with patch.object(worker, 'compose', return_value=json.dumps({'services': {'app': {'environment': current}}})):
            worker.validate_backup_configuration(self.state)
        current['DB_URL'] = 'sqlsrv://unrelated-target'
        with patch.object(worker, 'compose', return_value=json.dumps({'services': {'app': {'environment': current}}})):
            with self.assertRaisesRegex(ValueError, 'SQL targets or game profile differ'):
                worker.validate_backup_configuration(self.state)

    def test_backup_credentials_only_cross_stdin_and_are_not_archived(self):
        requests = []
        worker.COMPOSE.write_text('{}')
        (self.root / 'nginx.conf').write_text('server {}')
        (self.root / 'certificates').mkdir()
        with patch.object(worker, 'compose', side_effect=lambda *args, **kwargs: json.dumps({'services': {'app': {'environment': self.state['environment']}}}) if args[:1] == ('config',) else requests.append((args, kwargs)) or ''):
            destination = worker.backup(self.state, {'username': 'backupadmin', 'password': 'temporary-secret', 'directory': 'D:\\Backups'})
        args, kwargs = requests[0]
        self.assertNotIn('temporary-secret', ' '.join(args))
        self.assertIn('temporary-secret', kwargs['data'])
        self.assertNotIn('temporary-secret', (Path(destination) / 'backup.json').read_text())
        self.assertTrue((Path(destination) / 'site.tar.gz').is_file())

    @unittest.skipUnless(os.name == 'posix', 'Unix file permission boundary')
    def test_extracted_runtime_is_readable_by_container_users(self):
        archive = self.root / 'release.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('public/build/app.js', 'runtime')
        previous = os.umask(0o077)
        try:
            worker.safe_extract(archive, self.root / 'extracted', 'application')
        finally:
            os.umask(previous)
        self.assertEqual((self.root / 'extracted/public').stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.root / 'extracted/public/build/app.js').stat().st_mode & 0o777, 0o644)

    def test_update_preserves_custom_themes_and_accepts_stock_theme_fixes(self):
        themes = worker.APP / 'resources/views/themes'
        themes.mkdir(parents=True)
        (themes / 'stock.blade.php').write_text('original')
        (themes / 'modified.blade.php').write_text('original')
        shipped = worker.theme_hashes(worker.APP)
        (themes / 'modified.blade.php').write_text('customized')
        (themes / 'new.blade.php').write_text('user theme')
        staging = self.root / 'new-version'
        target = staging / 'resources/views/themes'
        target.mkdir(parents=True)
        (target / 'stock.blade.php').write_text('security fix')
        worker.preserve_custom_themes(staging, shipped)
        self.assertEqual((target / 'stock.blade.php').read_text(), 'security fix')
        self.assertEqual((target / 'modified.blade.php').read_text(), 'customized')
        self.assertEqual((target / 'new.blade.php').read_text(), 'user theme')

    def test_bootstrap_secret_is_removed_after_provisioning_failure(self):
        self.state['phase'] = 'bootstrap-pending'
        original_mkstemp = worker.tempfile.mkstemp

        def private_temp(*args, **kwargs):
            if kwargs.get('dir') == '/dev/shm':
                kwargs['dir'] = self.root
            return original_mkstemp(*args, **kwargs)

        def fail_bootstrap(*args, **kwargs):
            if '--env-from-file' in args:
                file = Path(args[args.index('--env-from-file') + 1])
                self.assertIn('temporary-bootstrap-secret', file.read_text())
                raise RuntimeError('bootstrap failure')
            return ''

        with patch.object(worker, 'compose', side_effect=fail_bootstrap), patch.object(worker, 'write_configuration'), patch.object(worker.tempfile, 'mkstemp', side_effect=private_temp):
            with self.assertRaisesRegex(RuntimeError, 'bootstrap failure'):
                worker.finish_install(self.state, {'sqlAdmin': 'sa', 'sqlPassword': 'temporary-bootstrap-secret'})
        self.assertFalse(list(self.root.glob('muonline-bootstrap-*')))
        self.assertNotIn('temporary-bootstrap-secret', worker.STATE.read_text())
        self.assertEqual(self.state['environment']['APP_KEY'], 'original-key')

    def test_resume_after_admin_creation_skips_bootstrap_and_duplicate_admin(self):
        self.state['phase'] = 'administrator-created'
        with patch.object(worker, 'compose') as compose, patch.object(worker, 'write_configuration'), patch.object(worker, 'create_admin') as admin, patch.object(worker, 'diagnose_sql', return_value={'passed': True}), patch.object(worker, 'apply_access'):
            worker.finish_install(self.state, {})
        admin.assert_not_called()
        self.assertFalse(any('--env-from-file' in call.args for call in compose.call_args_list))
        self.assertEqual(json.loads(worker.STATE.read_text())['phase'], 'ready')
        self.assertEqual(self.state['environment']['APP_KEY'], 'original-key')

    def test_sql_diagnostics_returns_checked_messages_without_raw_exception_output(self):
        with patch.object(worker, 'compose', return_value='password=never-show\nERROR Missing required game table: Character\nERROR Game database diagnostics failed.\nPDO exception containing secret'):
            result = worker.diagnose_sql()
        self.assertFalse(result['passed'])
        self.assertEqual(len(result['messages']), 2)
        self.assertNotIn('never-show', str(result))
        self.assertNotIn('PDO', str(result))

    def test_logs_remove_runtime_credentials_and_authorization_header(self):
        self.state['environment']['DB_PASSWORD'] = 'runtime-secret'
        worker.save_state(self.state)
        with patch.object(worker, 'compose', return_value='DB_PASSWORD=runtime-secret\nAuthorization: Bearer unknown-token\npassword=another-secret'):
            result = worker.dispatch({'action': 'logs'})
        for secret in ('runtime-secret', 'unknown-token', 'another-secret'):
            self.assertNotIn(secret, result)

    def test_archive_error_identifies_protected_root_without_contents_or_private_paths(self):
        archive = self.root / 'protected.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('storage/private-database-backup.sql', 'SECRET-CONTENTS')
        with self.assertRaisesRegex(ValueError, r'Archive contains protected runtime data \(application: storage\)\.') as error:
            worker.safe_extract(archive, self.root / 'extracted', 'application')
        self.assertNotIn('private-database-backup', str(error.exception))
        self.assertNotIn('SECRET-CONTENTS', str(error.exception))

    def test_production_package_separates_vendor_and_excludes_secrets(self):
        runtime = self.root / 'runtime'
        for relative, contents in {'artisan': '<?php', 'vendor/autoload.php': '<?php', 'vendor/composer/installed.json': '{"dev":false,"packages":[]}', 'public/build/manifest.json': '{}', 'docker/php/Dockerfile': 'FROM php', 'config/game.php': "return ['version_profiles' => ['from_real_registry' => Foo::class]];", '.env': 'SECRET', 'storage/app/public/upload': 'user-data', 'node_modules/evil/index.js': 'no', '.aws/credentials': 'SECRET', 'resources/views/themes/custom/index.blade.php': 'theme'}.items():
            file = runtime / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(contents)
        output = self.root / 'release'
        (runtime / '.git').write_text('gitdir: private-worktree-metadata')
        manifest = packager.package(runtime, output, '1.3.0', 'https://cdn.interweb.bg')
        self.assertEqual(manifest['profiles'], ['from_real_registry'])
        self.assertEqual(manifest['artifacts']['application']['url'], 'https://cdn.interweb.bg/muonline-web/releases/v1.3.0/application.zip')
        with zipfile.ZipFile(output / 'application.zip') as bundle:
            self.assertNotIn('.git', bundle.namelist())
            self.assertNotIn('.env', bundle.namelist())
            self.assertNotIn('vendor/autoload.php', bundle.namelist())
            self.assertFalse(any(name.startswith(('node_modules/', 'storage/', '.aws/')) for name in bundle.namelist()))
        # Both actual packager outputs must satisfy the runtime extraction policy.
        worker.safe_extract(output / 'application.zip', self.root / 'release-check', 'application')
        worker.safe_extract(output / 'vendor.zip', self.root / 'release-check', 'vendor')
        with zipfile.ZipFile(output / 'vendor.zip') as bundle:
            self.assertIn('vendor/autoload.php', bundle.namelist())
            self.assertTrue(all(name.startswith('vendor/') for name in bundle.namelist()))
        (runtime / 'vendor/composer/installed.json').write_text('{"dev":true}')
        with self.assertRaises(ValueError):
            packager.package(runtime, output, '1.3.0', 'https://cdn.interweb.bg')


if __name__ == '__main__':
    unittest.main()
