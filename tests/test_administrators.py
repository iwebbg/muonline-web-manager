"""Verify the administrator CLI boundary without invoking a database or live container."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('admin_worker', Path(__file__).resolve().parents[1] / 'runtime/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
ROW = {'id': 2, 'name': 'Game Master', 'email': 'gm@example.test', 'role': 'game_master', 'is_active': True}


class AdministratorCommandsTests(unittest.TestCase):
    """Assert exact command arguments, exit handling, redaction and protected account refusals."""

    def response(self, payload, code=0):
        return subprocess.CompletedProcess([], code, json.dumps(payload), '')

    def test_list_includes_game_masters_but_never_hashes_or_tokens(self):
        with patch.object(worker.subprocess, 'run', return_value=self.response({'administrators': [{**ROW, 'password': 'HASH', 'remember_token': 'TOKEN'}]})) as run:
            result = worker.manage_administrators('list')
        self.assertEqual(result, {'administrators': [ROW]})
        self.assertEqual(run.call_args.args[0][-3:], ['admin:list', '--json', '--no-interaction'])
        self.assertIsNone(run.call_args.kwargs['input'])
        self.assertNotIn('shell', run.call_args.kwargs)

    def test_update_arguments_are_literals_and_password_only_crosses_stdin(self):
        secret = 'A strong `$(literal)` 123!'
        details = {'id': 2, 'name': "Name'; $(literal)", 'email': 'gm@example.test', 'password': secret}
        with patch.object(worker.subprocess, 'run', return_value=self.response({'administrator': ROW})) as run:
            self.assertEqual(worker.manage_administrators('update', details), {'administrator': ROW})
        argv = run.call_args.args[0]
        self.assertIn('--name=' + details['name'], argv)
        self.assertIn('--password-stdin', argv)
        self.assertNotIn(secret, str(argv))
        self.assertEqual(run.call_args.kwargs['input'], secret + '\n')
        self.assertNotIn('env', run.call_args.kwargs)

    def test_missing_changes_bad_ids_weak_passwords_and_unconfirmed_mutations_never_execute(self):
        invalid = [('update', {'id': 2}), ('update', {'id': True, 'name': 'x'}), ('update', {'id': 2, 'is_active': False}), ('delete', {'id': 2}), ('update', {'id': 2, 'role': 'administrator'}), ('update', {'id': 2, 'name': 'x\ny'})]
        with patch.object(worker.subprocess, 'run') as run:
            for operation, details in invalid:
                with self.subTest(operation=operation, details=details), self.assertRaises(ValueError):
                    worker.manage_administrators(operation, details)
            weak = worker.manage_administrators('update', {'id': 2, 'password': 'lowercaseonly'})
            self.assertEqual(weak['code'], 'validation')
            self.assertIn('password', weak['errors'])
            run.assert_not_called()

    def test_last_active_administrator_refusal_survives_exit_one(self):
        errors = {'administrator': ['The last active administrator cannot be deleted or deactivated.']}
        with patch.object(worker.subprocess, 'run', return_value=self.response({'errors': errors}, 1)) as run:
            result = worker.manage_administrators('update', {'id': 2, 'is_active': False, 'confirmed': True})
        self.assertEqual(result, {'code': 'validation', 'errors': errors})
        self.assertIn('--active=0', run.call_args.args[0])

    def test_delete_requires_force_and_preserves_history_failure_guidance(self):
        with patch.object(worker.subprocess, 'run', return_value=self.response({'administrator': {'id': 2, 'deleted': True}})) as run:
            self.assertEqual(worker.manage_administrators('delete', {'id': 2, 'confirmed': True}), {'administrator': {'id': 2, 'deleted': True}})
        self.assertIn('--force', run.call_args.args[0])
        errors = {'database': ['Deletion failed. Identities referenced by history must be deactivated instead.']}
        with patch.object(worker.subprocess, 'run', return_value=self.response({'errors': errors}, 1)):
            self.assertEqual(worker.manage_administrators('delete', {'id': 2, 'confirmed': True})['errors'], errors)

    def test_invalid_json_old_releases_startup_errors_and_timeouts_are_safe(self):
        samples = [('Command "admin:list" is not defined.', 'releaseRequired'), ('SQL failed password=SECRET', 'invalidResponse'), ('{}', 'commandUnavailable')]
        for output, code in samples:
            with patch.object(worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, output, 'PRIVATE DSN')):
                self.assertEqual(worker.manage_administrators('list'), {'code': code})
        with patch.object(worker.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['SECRET'], 90, output='PRIVATE')):
            self.assertEqual(worker.manage_administrators('list'), {'code': 'commandUnavailable'})

    def test_json_field_errors_are_allowlisted_and_submitted_password_is_redacted(self):
        secret = 'Never echo this123!'
        payload = {'errors': {'password': ['Rejected ' + secret], 'connection_string': ['DSN private'], 'email': ['Already taken']}}
        with patch.object(worker.subprocess, 'run', return_value=self.response(payload, 1)):
            result = worker.manage_administrators('update', {'id': 2, 'password': secret})
        self.assertNotIn(secret, str(result))
        self.assertNotIn('DSN private', str(result))
        self.assertEqual(result['errors']['email'], ['Already taken'])


if __name__ == '__main__':
    unittest.main()
