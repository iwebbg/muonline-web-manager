"""Validate unattended Linux preparation using disposable files and stubbed processes only."""
import configparser
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('setup_worker', Path(__file__).resolve().parents[1] / 'runtime/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SetupTests(unittest.TestCase):
    def test_preparation_preserves_options_and_existing_backup_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'wsl.conf'
            release = root / 'os-release'
            pid = root / 'pid'
            original = '# custom settings\n[automount]\nroot=/custom/\n[boot]\ncommand=echo trusted\n'
            config.write_text(original)
            release.write_text('ID=ubuntu\nVERSION_ID="24.04"\n')
            pid.write_text('init\n')
            with patch.object(worker, 'ROOT', root), patch.object(worker, 'WSL_CONFIG', config), patch.object(worker, 'OS_RELEASE', release), patch.object(worker, 'PID_ONE', pid), patch.object(worker, 'ensure_linux_user', return_value='muonline'), patch.object(worker, 'run', return_value='x86_64\n'):
                self.assertEqual(worker.dispatch({'action': 'prepareWsl', 'username': 'ignored'}), {'linuxUser': 'muonline', 'restartRequired': True})
                parsed = configparser.RawConfigParser()
                parsed.read(config)
                self.assertEqual(parsed.get('boot', 'systemd'), 'true')
                self.assertEqual(parsed.get('boot', 'command'), 'echo trusted')
                self.assertEqual(parsed.get('automount', 'root'), '/custom/')
                self.assertEqual((root / 'wsl.conf.before-manager').read_text(), original)
                before = config.read_bytes()
                pid.write_text('systemd\n')
                self.assertFalse(worker.prepare_wsl()['restartRequired'])
                self.assertEqual(config.read_bytes(), before)
                self.assertEqual(worker.dispatch({'action': 'linuxStatus'}), {'systemd': True})

    def test_wrong_distribution_fails_before_creating_an_account(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / 'os-release'
            release.write_text('ID=debian\nVERSION_ID="12"\n')
            with patch.object(worker, 'OS_RELEASE', release), patch.object(worker, 'ensure_linux_user') as account:
                with self.assertRaisesRegex(ValueError, 'Ubuntu 24.04'):
                    worker.prepare_wsl()
                account.assert_not_called()

    def test_linux_account_creation_has_no_password_and_preserves_existing_accounts(self):
        account = SimpleNamespace(pw_uid=1000, pw_name='muonline')
        lookup = Mock(side_effect=[KeyError('missing'), account, account])
        with patch.dict(sys.modules, {'pwd': SimpleNamespace(getpwnam=lookup)}), patch.object(worker, 'run') as run:
            self.assertEqual(worker.ensure_linux_user(), 'muonline')
            self.assertEqual(worker.ensure_linux_user(), 'muonline')
            run.assert_called_once_with(['useradd', '--create-home', '--user-group', '--shell', '/bin/bash', 'muonline'])


if __name__ == '__main__':
    unittest.main()
