"""Confirm endpoint repair and current temporary credentials without real SQL access."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_runtime import module

worker = module('endpoint_worker', 'runtime/worker.py')


class BootstrapEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        for name, path in {'ROOT': root, 'APP': root / 'application', 'STATE': root / 'state.json', 'COMPOSE': root / 'compose.json'}.items():
            patcher = patch.object(worker, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(worker.os, 'chown', create=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        worker.APP.mkdir()
        self.state = {'phase': 'bootstrap-pending', 'version': '1.3.0', 'access': worker.access_settings({'mode': 'local'}), 'environment': {
            'DB_HOST': '127.0.0.1', 'DB_PORT': '1433', 'GAME_DB_HOST': '127.0.0.1', 'GAME_DB_PORT': '1433',
            'DB_DATABASE': 'Web', 'GAME_DB_MUONLINE': 'Game', 'DB_USERNAME': 'web_app', 'GAME_DB_USERNAME': 'game_app',
            'DB_PASSWORD': 'keep-runtime-password', 'GAME_DB_PASSWORD': 'keep-game-password', 'APP_KEY': 'keep-key', 'GAME_SERVER_PROFILE': 'registry_profile'}}
        worker.save_state(self.state)
        self.original = b'APP_KEY=keep-key\r\nDB_HOST="127.0.0.1"\r\nDB_PORT=1433\r\nGAME_DB_HOST="127.0.0.1"\r\nGAME_DB_PORT=1433\r\nCUSTOM="first\r\nlast"\r\n'
        (worker.APP / '.env').write_bytes(self.original)
        worker.COMPOSE.write_text('{}')
        self.settings = {'sqlHost': '172.20.48.1', 'sqlPort': '1433', 'sqlAdmin': 'new-admin', 'sqlPassword': 'new-private-secret',
                         'sqlEndpointChange': {'confirmed': True, 'expected': worker.bootstrap_sql_endpoint(self.state)}}

    def compose(self, *args, **kwargs):
        if args[0] == 'config':
            return json.dumps({'services': {'app': {'environment': self.state['environment']}}})
        self.assertEqual(args[:6], ('run', '--rm', '--no-deps', '-T', '--entrypoint', 'php'))
        self.assertEqual(json.loads(kwargs['data']), {'host': '172.20.48.1', 'port': 1433})
        self.assertNotIn('new-private-secret', kwargs['data'])
        return subprocess.CompletedProcess([], 0, 'TCP OK', '')

    def test_repair_preserves_keys_passwords_custom_env_and_private_exact_backup(self):
        with patch.object(worker, 'compose', side_effect=self.compose):
            worker.repair_bootstrap_endpoint(self.state, self.settings)
        saved = worker.load_state()
        self.assertEqual(saved['environment']['DB_HOST'], '172.20.48.1')
        self.assertEqual(saved['environment']['GAME_DB_HOST'], '172.20.48.1')
        self.assertEqual(saved['environment']['APP_KEY'], 'keep-key')
        self.assertEqual(saved['environment']['DB_PASSWORD'], 'keep-runtime-password')
        self.assertEqual(saved['environment']['GAME_DB_PASSWORD'], 'keep-game-password')
        self.assertNotIn('new-private-secret', worker.STATE.read_text())
        self.assertNotIn('new-admin', worker.STATE.read_text())
        self.assertIn(b'CUSTOM="first\r\nlast"\r\n', (worker.APP / '.env').read_bytes())
        self.assertEqual((Path(saved['bootstrapEndpointBackup']) / '.env').read_bytes(), self.original)

    def test_missing_confirmation_stale_target_and_identity_changes_never_run_commands(self):
        for settings in [dict(self.settings, sqlEndpointChange={}),
                         dict(self.settings, sqlEndpointChange={'confirmed': True, 'expected': {}}),
                         dict(self.settings, webDatabase='Other'), dict(self.settings, appLogin='Other'),
                         dict(self.settings, profile='Other')]:
            with self.subTest(settings=settings), patch.object(worker, 'compose') as compose:
                with self.assertRaises(ValueError):
                    worker.repair_bootstrap_endpoint(self.state, settings)
                compose.assert_not_called()
        self.assertEqual((worker.APP / '.env').read_bytes(), self.original)

    def test_unreachable_docker_target_keeps_original_state_and_env(self):
        before = worker.STATE.read_bytes()
        with patch.object(worker, 'validate_backup_configuration'), patch.object(worker, 'compose',
                return_value=subprocess.CompletedProcess([], 1, '', '')):
            with self.assertRaisesRegex(ValueError, 'not reachable from Docker'):
                worker.repair_bootstrap_endpoint(self.state, self.settings)
        self.assertEqual(worker.STATE.read_bytes(), before)
        self.assertEqual((worker.APP / '.env').read_bytes(), self.original)

    def test_configuration_failure_restores_exact_previous_files(self):
        before = worker.STATE.read_bytes()
        with patch.object(worker, 'compose', side_effect=self.compose), patch.object(worker, 'write_configuration', side_effect=RuntimeError('write failed')):
            with self.assertRaisesRegex(RuntimeError, 'previous configuration restored'):
                worker.repair_bootstrap_endpoint(self.state, self.settings)
        self.assertEqual(worker.STATE.read_bytes(), before)
        self.assertEqual((worker.APP / '.env').read_bytes(), self.original)

    def test_failed_restore_blocks_start_and_resume(self):
        with patch.object(worker, 'compose', side_effect=self.compose), patch.object(worker, 'write_configuration', side_effect=RuntimeError()), patch.object(worker, 'restore_access_configuration', side_effect=RuntimeError()):
            with self.assertRaisesRegex(RuntimeError, 'recovery failed'):
                worker.repair_bootstrap_endpoint(self.state, self.settings)
        self.assertEqual(worker.load_state()['phase'], 'bootstrap-endpoint-recovery-required')
        with self.assertRaises(ValueError):
            worker.dispatch({'action': 'start'})

    def test_completed_bootstrap_cannot_retarget_sql(self):
        self.state['phase'] = 'runtime-bootstrapped'
        with patch.object(worker, 'compose') as compose:
            with self.assertRaisesRegex(ValueError, 'only before bootstrap'):
                worker.repair_bootstrap_endpoint(self.state, self.settings)
        compose.assert_not_called()

    def test_fresh_install_rejects_container_loopback(self):
        for host in ('127.0.0.1', '127.2.3.4', 'localhost', '::1'):
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, 'web container'):
                worker.sql_endpoint(host, 1433)

    def test_every_bootstrap_attempt_uses_current_admin_credentials_and_deletes_temp_file(self):
        mkstemp = worker.tempfile.mkstemp
        observed = []
        def private_temp(*args, **kwargs):
            if kwargs.get('dir') == '/dev/shm':
                kwargs['dir'] = worker.ROOT
            return mkstemp(*args, **kwargs)
        def bootstrap(*args, **kwargs):
            if '--env-from-file' in args:
                filename = Path(args[args.index('--env-from-file') + 1])
                observed.append(filename.read_text())
                raise RuntimeError('SQL bootstrap rejected')
            return ''
        with patch.object(worker, 'write_configuration'), patch.object(worker, 'compose', side_effect=bootstrap), patch.object(worker.tempfile, 'mkstemp', side_effect=private_temp):
            for admin, secret in [('wrong-admin', 'wrong-private-password'), ('correct-admin', 'correct-private-password')]:
                with self.assertRaisesRegex(RuntimeError, 'SQL bootstrap rejected'):
                    worker.finish_install(self.state, {'sqlAdmin': admin, 'sqlPassword': secret})
                self.assertFalse(list(worker.ROOT.glob('muonline-bootstrap-*')))
        self.assertIn('correct-admin', observed[1])
        self.assertIn('correct-private-password', observed[1])
        self.assertNotIn('wrong-private-password', observed[1])
        self.assertNotIn('correct-private-password', worker.STATE.read_text())
