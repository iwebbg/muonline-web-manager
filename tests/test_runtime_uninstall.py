"""Test SQL decommissioning without connecting to Docker, WSL or SQL Server."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_runtime import module

worker = module('uninstall_worker', 'runtime/worker.py')


class RuntimeUninstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        for key, value in {'ROOT': root, 'APP': root / 'application', 'STATE': root / 'state.json', 'COMPOSE': root / 'compose.json'}.items():
            patcher = patch.object(worker, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        worker.APP.mkdir()
        self.state = {'phase': 'ready', 'version': '1.4.0', 'environment': {
            'DB_HOST': 'sql.example', 'DB_PORT': '1433', 'DB_CONNECTION': 'sqlsrv',
            'DB_DATABASE': 'MuOnline_Web', 'DB_USERNAME': 'web_app',
            'GAME_DB_MUONLINE': 'MuOnline', 'GAME_DB_USERNAME': 'game_app'}}
        worker.save_state(self.state)
        self.details = {'confirmed': True, 'target': worker.uninstall_target(self.state),
                        'admin_username': 'temporary_admin', 'admin_password': 'Private-Password/42!'}
        self.response = {'ok': True, 'code': 'uninstalled', 'database': 'removed', 'login': 'removed', 'retryable': False}
        self.exit_code = 0
        self.stdout = None
        self.calls = []

    def compose(self, *arguments, **kwargs):
        self.calls.append((arguments, kwargs))
        if arguments[0] == 'config':
            return json.dumps({'services': {'app': {'environment': self.state['environment']}}})
        if arguments[0] == 'run':
            return subprocess.CompletedProcess(['docker'], self.exit_code,
                self.stdout if self.stdout is not None else json.dumps(self.response), 'withheld private failure')
        return ''

    def test_stops_services_before_one_shot_command_and_keeps_credentials_only_on_stdin(self):
        with patch.object(worker, 'compose', side_effect=self.compose):
            self.assertEqual(worker.dispatch({'action': 'uninstallDatabase', 'sqlRemoval': self.details}), self.response)
        operations = [args[0] for args, _ in self.calls]
        self.assertLess(operations.index('stop'), operations.index('run'))
        stop = next(args for args, _ in self.calls if args[0] == 'stop')
        self.assertEqual(stop, ('stop', 'nginx', 'queue', 'scheduler', 'app'))
        arguments, options = next(call for call in self.calls if call[0][0] == 'run')
        self.assertEqual(arguments, ('run', '--rm', '--no-deps', '-T', '--entrypoint', 'php', 'app',
                                    'artisan', 'app:database:uninstall', '--force', '--no-interaction'))
        payload = json.loads(options['data'])
        self.assertEqual(payload, dict(self.details['target'], confirmed=True,
            admin_username='temporary_admin', admin_password='Private-Password/42!'))
        serialized = worker.STATE.read_text()
        self.assertNotIn('Private-Password', serialized)
        self.assertNotIn('temporary_admin', serialized)
        self.assertEqual(worker.load_state()['phase'], 'uninstall-sql-complete')
        with patch.object(worker, 'compose') as compose:
            self.assertEqual(worker.uninstall_database(self.details), self.response)
        compose.assert_not_called()

    def test_stale_targets_and_missing_confirmation_never_stop_services(self):
        for details in [None, {}, dict(self.details, confirmed=False),
                        dict(self.details, target=dict(self.details['target'], database='MuOnline')),
                        dict(self.details, admin_password='')]:
            with self.subTest(details=details), patch.object(worker, 'compose') as compose:
                with self.assertRaises(ValueError):
                    worker.uninstall_database(details)
                compose.assert_not_called()
        self.assertEqual(worker.load_state()['phase'], 'ready')

    def test_login_drift_stops_before_destructive_work(self):
        with patch.object(worker, 'validate_backup_configuration'), patch.object(worker, 'compose',
                return_value=json.dumps({'services': {'app': {'environment': {'DB_USERNAME': 'another_login'}}}})):
            with self.assertRaisesRegex(ValueError, 'login differs'):
                worker.uninstall_database(self.details)
        self.assertEqual(worker.load_state()['phase'], 'ready')

    def test_refusals_and_partial_sql_failures_preserve_progress_and_retry_command(self):
        self.exit_code = 1
        self.response = {'ok': False, 'code': 'sql_operation_failed', 'database': 'removed', 'login': 'retained', 'retryable': True}
        with patch.object(worker, 'compose', side_effect=self.compose):
            self.assertEqual(worker.uninstall_database(self.details), self.response)
            self.assertEqual(worker.load_state()['sqlRemoval']['database'], 'removed')
            self.assertEqual(worker.load_state()['phase'], 'uninstall-sql-pending')
            self.exit_code = 0
            self.response = {'ok': True, 'code': 'uninstalled', 'database': 'already_absent', 'login': 'removed', 'retryable': False}
            self.assertTrue(worker.uninstall_database(self.details)['ok'])
        self.assertEqual(sum(args[0] == 'run' for args, _ in self.calls), 2)
        with self.assertRaisesRegex(ValueError, 'manual recovery'):
            worker.dispatch({'action': 'start'})

    def test_malformed_json_uncertain_success_and_nonzero_exit_never_complete_cleanup(self):
        scenarios = [(0, 'Laravel failed before command startup'), (0, '{}'), (1, json.dumps(self.response)),
                     (0, json.dumps(dict(self.response, login='unknown'))),
                     (0, json.dumps(dict(self.response, code='Private-Password/42!')))]
        for code, output in scenarios:
            with self.subTest(code=code, output=output):
                worker.save_state(self.state)
                self.exit_code, self.stdout = code, output
                with patch.object(worker, 'compose', side_effect=self.compose):
                    response = worker.uninstall_database(self.details)
                self.assertFalse(response['ok'])
                self.assertEqual(worker.load_state()['phase'], 'uninstall-sql-pending')
                self.assertNotIn('Private-Password', json.dumps(response))

    def test_untracked_application_cannot_bypass_cleanup_but_empty_runtime_can_be_removed(self):
        worker.STATE.unlink()
        with self.assertRaisesRegex(ValueError, 'Untracked'):
            worker.uninstall_database(None)
        worker.APP.rmdir()
        self.assertEqual(worker.uninstall_database(None), {'ok': True, 'code': 'not_installed'})

    def test_docker_failure_leaves_checkpoint_and_does_not_claim_sql_success(self):
        def failing_compose(*args, **kwargs):
            if args[0] == 'stop':
                raise RuntimeError('Docker unavailable')
            return self.compose(*args, **kwargs)
        with patch.object(worker, 'compose', side_effect=failing_compose):
            with self.assertRaisesRegex(RuntimeError, 'Docker unavailable'):
                worker.uninstall_database(self.details)
        self.assertEqual(worker.load_state()['phase'], 'uninstall-sql-pending')
        self.assertFalse(any(args[0] == 'run' for args, _ in self.calls))


    def test_returned_process_keeps_nonzero_exit_and_diagnostic_redaction_masks_temporary_identity(self):
        process = subprocess.CompletedProcess(['docker'], 1, '{"ok":true}', '')
        with patch.object(worker.subprocess, 'run', return_value=process):
            result = worker.compose('run', '--rm', '--no-deps', '-T', '--entrypoint', 'php', 'app',
                'artisan', 'app:database:uninstall', '--force', '--no-interaction',
                data=json.dumps(self.details), allow_failure=True, return_process=True)
        self.assertEqual(result.returncode, 1)
        with patch.object(worker, 'DIAGNOSTIC_SECRETS', set()):
            worker.diagnostic_secrets(self.details)
            output = worker.redact_development_output('temporary_admin Private-Password/42!')
        self.assertNotIn('temporary_admin', output)
        self.assertNotIn('Private-Password', output)
