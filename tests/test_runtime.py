"""Exercise privileged worker boundaries without WSL, Docker or real database changes."""
import importlib.util
import json
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
        self.patches = [patch.object(worker, 'ROOT', self.root), patch.object(worker, 'APP', self.root / 'application'), patch.object(worker, 'STATE', self.root / 'state.json'), patch.object(worker, 'COMPOSE', self.root / 'compose.json')]
        for item in self.patches:
            item.start()
        worker.APP.mkdir()
        self.state = {'version': '1.3.0', 'phase': 'ready', 'access': worker.access_settings({'mode': 'local'}), 'environment': {'APP_KEY': 'original-key', 'APP_ENV': 'production', 'DB_DATABASE': 'Web', 'GAME_DB_MUONLINE': 'Game'}}
        worker.save_state(self.state)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

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

    def test_zip_rejects_traversal_symlinks_and_mutable_runtime_files(self):
        for name in ['../escape', '/etc/passwd', '.env', 'storage/app/public/upload', 'vendor/autoload.php', 'a\\b', 'C:/escape']:
            archive = self.root / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr(name, 'evil')
            with self.assertRaises(ValueError):
                worker.safe_extract(archive, self.root / 'extracted', 'application')
        with zipfile.ZipFile(self.root / 'link.zip', 'w') as bundle:
            entry = zipfile.ZipInfo('link')
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(entry, '/etc/passwd')
        with self.assertRaises(ValueError):
            worker.safe_extract(self.root / 'link.zip', self.root / 'extracted', 'application')

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
        with patch.object(worker, 'stage_release', return_value=staging), patch.object(worker, 'backup', return_value='/private/backup'), patch.object(worker, 'compose', side_effect=compose), patch.object(worker, 'initialize_storage'), patch.object(worker, 'write_configuration'):
            with self.assertRaisesRegex(RuntimeError, 'Do not automatically roll back SQL'):
                worker.update(request)
        record = json.loads(worker.STATE.read_text())
        self.assertEqual(record['phase'], 'migration-recovery-required')
        self.assertFalse(any('rollback' in arg for call in calls for arg in call))
        self.assertFalse(any(call[-2:] == ('up', '--no-interaction') for call in calls))

    def test_backup_credentials_only_cross_stdin_and_are_not_archived(self):
        requests = []
        worker.COMPOSE.write_text('{}')
        (self.root / 'nginx.conf').write_text('server {}')
        (self.root / 'certificates').mkdir()
        with patch.object(worker, 'compose', side_effect=lambda *args, **kwargs: requests.append((args, kwargs)) or ''):
            destination = worker.backup(self.state, {'username': 'backupadmin', 'password': 'temporary-secret', 'directory': 'D:\\Backups'})
        args, kwargs = requests[0]
        self.assertNotIn('temporary-secret', ' '.join(args))
        self.assertIn('temporary-secret', kwargs['data'])
        self.assertNotIn('temporary-secret', (Path(destination) / 'backup.json').read_text())
        self.assertTrue((Path(destination) / 'site.tar.gz').is_file())

    def test_production_package_separates_vendor_and_excludes_secrets(self):
        runtime = self.root / 'runtime'
        for relative, contents in {'artisan': '<?php', 'vendor/autoload.php': '<?php', 'vendor/composer/installed.json': '{"dev":false,"packages":[]}', 'public/build/manifest.json': '{}', 'docker/php/Dockerfile': 'FROM php', 'config/game.php': "return ['version_profiles' => ['from_real_registry' => Foo::class]];", '.env': 'SECRET', 'storage/app/public/upload': 'user-data', 'node_modules/evil/index.js': 'no', '.aws/credentials': 'SECRET', 'resources/views/themes/custom/index.blade.php': 'theme'}.items():
            file = runtime / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(contents)
        output = self.root / 'release'
        manifest = packager.package(runtime, output, '1.3.0', 'https://cdn.interweb.bg')
        self.assertEqual(manifest['profiles'], ['from_real_registry'])
        self.assertEqual(manifest['artifacts']['application']['url'], 'https://cdn.interweb.bg/muonline-web/releases/v1.3.0/application.zip')
        with zipfile.ZipFile(output / 'application.zip') as bundle:
            self.assertNotIn('.env', bundle.namelist())
            self.assertNotIn('vendor/autoload.php', bundle.namelist())
            self.assertFalse(any(name.startswith(('node_modules/', 'storage/', '.aws/')) for name in bundle.namelist()))
        with zipfile.ZipFile(output / 'vendor.zip') as bundle:
            self.assertIn('vendor/autoload.php', bundle.namelist())
            self.assertTrue(all(name.startswith('vendor/') for name in bundle.namelist()))
        (runtime / 'vendor/composer/installed.json').write_text('{"dev":true}')
        with self.assertRaises(ValueError):
            packager.package(runtime, output, '1.3.0', 'https://cdn.interweb.bg')


if __name__ == '__main__':
    unittest.main()
