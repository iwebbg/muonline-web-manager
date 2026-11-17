"""Docker errors expose fixed categories, never dependency output or private argv/stdin."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('docker_error_worker', Path(__file__).resolve().parents[1] / 'runtime/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class DockerErrorTests(unittest.TestCase):
    def test_dev_logs_capture_bootstrap_failure_with_known_secrets_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'state.json'
            state.write_text(json.dumps({'environment': {'APP_KEY': 'private-runtime-key', 'DB_PASSWORD': 'runtime-password'}}))
            result = SimpleNamespace(returncode=1, stdout='Connecting to test SQL server\nbootstrap-password', stderr='SQLSTATE[08001]: TCP Provider: connection refused\nprivate-runtime-key runtime-password')
            with patch.object(worker, 'ROOT', root), patch.object(worker, 'STATE', state), patch.object(worker, 'DEVELOPMENT_DIAGNOSTICS', True), patch.object(worker, 'DIAGNOSTIC_ACTION', 'resumeInstall'), patch.object(worker, 'DIAGNOSTIC_SECRETS', set()), patch.object(worker.subprocess, 'run', return_value=result):
                worker.diagnostic_secrets({'settings': {'sqlPassword': 'bootstrap-password', 'sqlAdmin': 'test-admin'}})
                with self.assertRaises(RuntimeError):
                    worker.compose('run', '--env-from-file', '/dev/shm/secret-path', 'app', 'true', data='private-stdin')
                log = worker.development_logs()
                self.assertIn('SQLSTATE[08001]', log)
                self.assertIn('connection refused', log)
                self.assertIn('bootstrap / finish / exit 1', log)
                self.assertIn('[REDACTED]', log)
                for secret in ('bootstrap-password', 'private-runtime-key', 'runtime-password', 'private-stdin', '/dev/shm/secret-path'):
                    self.assertNotIn(secret, log)

    def test_production_does_not_record_or_expose_development_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(worker, 'ROOT', root), patch.object(worker, 'DEVELOPMENT_DIAGNOSTICS', False):
                worker.development_log('finish', ['docker'], stdout='must-not-be-recorded', stderr='SECRET')
                self.assertFalse((root / 'diagnostics').exists())
                with self.assertRaisesRegex(ValueError, 'disabled'):
                    worker.development_logs()

    def test_normal_runtime_support_recording_is_redacted_without_enabling_dev_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(worker, 'ROOT', root), patch.object(worker, 'STATE', root / 'state.json'), patch.object(worker, 'DEVELOPMENT_DIAGNOSTICS', False), patch.object(worker, 'RECORD_DIAGNOSTICS', True), patch.object(worker, 'DIAGNOSTIC_SECRETS', {'test-bootstrap-password'}):
                worker.development_log('finish', ['docker'], exitCode=1, stderr='connection refused test-bootstrap-password')
                log = worker.runtime_logs()
                self.assertIn('connection refused', log)
                self.assertNotIn('test-bootstrap-password', log)
                with self.assertRaisesRegex(ValueError, 'disabled'):
                    worker.development_logs()

    def test_build_failure_reports_operation_category_and_line_only(self):
        result = SimpleNamespace(returncode=1, stdout='private-output', stderr='Dockerfile:28\nfailed to solve: SECRET\nno space left on device')
        with patch.object(worker.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, r'build \(exit 1; reason diskSpace; Dockerfile line 28\)') as error:
                worker.compose('build', 'app')
        self.assertNotIn('SECRET', str(error.exception))
        self.assertNotIn('private-output', str(error.exception))

    def test_bootstrap_error_does_not_echo_sql_login_or_secret_file(self):
        result = SimpleNamespace(returncode=1, stdout='', stderr='Login failed for user PRIVATE-LOGIN; password=SECRET')
        with patch.object(worker.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, r'bootstrap \(exit 1; reason sqlLogin\)') as error:
                worker.compose('run', '--env-from-file', '/dev/shm/private-file', 'app', 'true', data='PRIVATE-STDIN')
        for secret in ['PRIVATE-LOGIN', 'SECRET', '/dev/shm/private-file', 'PRIVATE-STDIN']:
            self.assertNotIn(secret, str(error.exception))

    def test_timeout_and_unknown_output_remain_safe(self):
        with patch.object(worker.subprocess, 'run', side_effect=subprocess.TimeoutExpired('SECRET', 1, output='SECRET')):
            with self.assertRaisesRegex(RuntimeError, 'reason timeout'):
                worker.compose('up', '-d')
        self.assertIn('reason unknown', worker.docker_failure(['docker', 'compose', 'build'], 1, 'SECRET'))
        self.assertNotIn('SECRET', worker.docker_failure(['docker', 'compose', 'build'], 1, 'SECRET'))
