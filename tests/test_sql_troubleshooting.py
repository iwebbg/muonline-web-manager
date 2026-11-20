"""Exercise address discovery, independent PDO inputs and safe diagnostic container arguments."""
import importlib.util
from pathlib import Path
import socket
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sql_diagnostics', Path(__file__).resolve().parents[1] / 'runtime/sql-troubleshooting.py')
sql = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sql)


class SqlTroubleshootingTests(unittest.TestCase):
    """Use measured fixtures; no Windows/SQL/Docker process is invoked by unit tests."""

    def environment(self):
        return {'DB_HOST': 'app-sql', 'DB_PORT': '1433', 'DB_DATABASE': 'AppDb', 'DB_USERNAME': 'app_user', 'DB_PASSWORD': 'app-secret', 'DB_ENCRYPT': 'true', 'DB_TRUST_SERVER_CERTIFICATE': 'false', 'GAME_DB_HOST': 'game-sql', 'GAME_DB_PORT': '55477', 'GAME_DB_MUONLINE': 'GameDb', 'GAME_DB_RANKING': 'RankDb', 'GAME_RANKING_CONNECTION': 'ranking', 'GAME_DB_BATTLE_CORE': 'BattleCore', 'GAME_BATTLE_CORE_READS_ENABLED': 'true', 'GAME_DB_USERNAME': 'game_user', 'GAME_DB_PASSWORD': 'game-secret', 'GAME_DB_ENCRYPT': 'true', 'GAME_DB_TRUST_SERVER_CERTIFICATE': 'true'}

    def test_addresses_keep_real_mask_and_gateway_without_hardcoding(self):
        result = sql.discover_network([{'ifname': 'eth0', 'addr_info': [{'family': 'inet', 'local': '172.25.19.8', 'prefixlen': 21}]}], [{'gateway': '172.25.16.1', 'dev': 'eth0'}], 'nat')
        self.assertEqual(result['addresses'][0]['prefixLength'], 21)
        self.assertEqual(result['routes'][0]['gateway'], '172.25.16.1')
        self.assertEqual(sql.discover_network([], [], 'mystery')['mode'], 'unknown')

    def test_app_game_optional_databases_and_admin_fallbacks_are_independent(self):
        environment = self.environment()
        connections, steps = sql.build_connections(environment, {'adminUsername': 'app_admin', 'adminPassword': 'temporary-admin'})
        by_id = {item['id']: item for item in connections}
        self.assertEqual(by_id['application']['host'], 'app-sql')
        self.assertEqual(by_id['game']['host'], 'game-sql')
        self.assertEqual(by_id['game']['port'], 55477)
        self.assertFalse(by_id['application']['trust'])
        self.assertTrue(by_id['game']['trust'])
        self.assertEqual(by_id['gameBootstrap']['username'], 'app_admin')
        self.assertEqual(by_id['gameBootstrap']['password'], 'temporary-admin')
        self.assertEqual(by_id['gameBootstrap']['databases'], ['GameDb', 'RankDb', 'BattleCore'])
        connections, _ = sql.build_connections(environment, {'adminUsername': 'app_admin', 'adminPassword': 'app-pass', 'gameAdminUsername': 'game_admin'})
        game_admin = next(item for item in connections if item['id'] == 'gameBootstrap')
        self.assertEqual(game_admin['username'], 'game_admin')
        self.assertEqual(game_admin['password'], 'app-pass')

    def test_enabled_additional_database_without_name_is_a_separate_failure(self):
        environment = self.environment()
        environment['GAME_DB_BATTLE_CORE'] = ''
        _, steps = sql.build_connections(environment, {})
        self.assertEqual(steps[0]['reason'], 'additionalDatabaseRequired')
        environment['GAME_DB_RANKING'] = ''
        _, steps = sql.build_connections(environment, {})
        self.assertTrue(any(item['id'] == 'ranking.configuration' and item['status'] == 'failed' for item in steps))

    def test_socket_dns_failure_does_not_invoke_a_shell(self):
        with patch.object(sql.socket, 'create_connection', side_effect=socket.gaierror('private DSN')) as connect:
            result = sql.tcp_probe('host.docker.internal', 1433)
        self.assertEqual(result['code'], 'dns')
        self.assertNotIn('private DSN', str(result))
        connect.assert_called_once_with(('host.docker.internal', 1433), timeout=3)

    def test_container_runs_on_actual_network_without_bootstrap_or_password_arguments(self):
        arguments = sql.probe_command('sha256:real-app-image', 'actual-project_application', 'fixed PHP source')
        self.assertIn('actual-project_application', arguments)
        self.assertEqual(arguments[arguments.index('--entrypoint') + 1], 'php')
        self.assertIn('--read-only', arguments)
        self.assertIn('no-new-privileges:true', arguments)
        self.assertNotIn('--env', arguments)
        self.assertNotIn('bootstrap', ' '.join(arguments))

    def test_actual_container_environment_takes_precedence_over_stale_compose(self):
        result = sql.read_environment({'services': {'app': {'environment': {'DB_HOST': 'old'}}}}, {'Config': {'Env': ['DB_HOST=current', 'DB_PASSWORD=private', 'GAME_DB_HOST=game-current']}})
        self.assertEqual(result['DB_HOST'], 'current')
        self.assertEqual(result['DB_PASSWORD'], 'private')

    def test_restarting_app_uses_one_shot_image_and_actual_network_without_exposing_environment(self):
        environment = self.environment()
        config = {'services': {'app': {'image': 'runtime:local', 'environment': {'DB_HOST': 'stale'}}}, 'networks': {}}
        inspected = {'Image': 'sha256:' + 'a' * 64, 'Config': {'Env': [key + '=' + value for key, value in environment.items()]}, 'NetworkSettings': {'Networks': {'real-application-net': {}}}, 'State': {'Status': 'restarting'}}
        commands = []

        def json_command(arguments):
            return [inspected] if arguments[:2] == ['docker', 'inspect'] else config

        def command(arguments, data=None, timeout=20):
            commands.append((arguments, data))
            if 'ps' in arguments:
                return 'real-container-id'
            if 'run' in arguments:
                self.assertIn('--entrypoint', arguments)
                self.assertIn('real-application-net', arguments)
                self.assertNotIn('app-secret', ' '.join(arguments))
                self.assertIn('app-secret', data)
                return '{"steps":[{"id":"application.sql","status":"passed","category":"authentication","reason":"sqlConnected","action":"sqlConnected","evidence":{}}]}'
            return ''

        php = (Path(__file__).resolve().parents[1] / 'runtime/sql-probe.php').read_text()
        with patch.object(sql, 'json_command', side_effect=json_command), patch.object(sql, 'command', side_effect=command), patch.object(sql, 'network_facts', return_value={'mode': 'nat', 'routes': [], 'addresses': [], 'probes': []}), patch.object(sql, 'tcp_probe', return_value={'host': 'game-sql', 'port': 55477, 'ok': True}):
            report = sql.run_diagnostics({'useInstalled': True}, php)
        self.assertNotIn('app-secret', str(report))
        self.assertNotIn('game-secret', str(report))
        self.assertTrue(any(item['id'] == 'docker.context' and item['evidence']['containerState'] == 'restarting' for item in report['steps']))
        self.assertFalse(any('exec' in arguments for arguments, _ in commands))

    def test_dsn_injection_is_rejected_before_docker(self):
        environment = self.environment()
        environment['DB_HOST'] = 'host;Encrypt=no'
        with self.assertRaises(ValueError):
            sql.build_connections(environment, {})
        environment = self.environment()
        environment['DB_DATABASE'] = 'AppDb;TrustServerCertificate=true'
        with self.assertRaises(ValueError):
            sql.build_connections(environment, {})

    def test_partial_install_uses_private_compose_credentials_without_an_app_container_or_manual_secrets(self):
        import json
        environment = self.environment()
        configuration = {'services': {'app': {'environment': environment}}}
        commands = []
        def command(arguments, data=None, timeout=20):
            commands.append((arguments, data))
            connections = json.loads(data)['connections']
            app = next(item for item in connections if item['id'] == 'application')
            game = next(item for item in connections if item['id'] == 'game')
            self.assertEqual(app['password'], 'app-secret')
            self.assertEqual(game['password'], 'game-secret')
            self.assertEqual(game['username'], 'game_user')
            self.assertEqual(game['host'], 'game-sql')
            self.assertNotIn('manual-decoy', data)
            return '{"steps":[]}'
        php = (Path(__file__).resolve().parents[1] / 'runtime/sql-probe.php').read_text()
        request = {'useInstalled': True, 'gameUsername': 'manual-decoy', 'gamePassword': 'manual-decoy', 'appPassword': 'manual-decoy', 'host': 'manual-decoy'}
        with patch.object(sql, 'docker_context', return_value=(configuration, None, 'runtime:local', ['app-network'])), patch.object(sql, 'network_facts', return_value={'mode': 'nat', 'routes': [], 'addresses': [], 'probes': []}) as network, patch.object(sql, 'tcp_probe', return_value={'host': 'game-sql', 'port': 55477, 'ok': True}), patch.object(sql, 'command', side_effect=command):
            report = sql.run_diagnostics(request, php)
        network.assert_called_once_with('', 1433, [])
        self.assertFalse(any(item['id'] == 'docker.probe' for item in report['steps']), 'Private connection fixture must finish without a swallowed probe failure')
        self.assertEqual(len(commands), 1)
        self.assertIn('--read-only', commands[0][0])
        self.assertNotIn('game-secret', ' '.join(commands[0][0]))
        self.assertNotIn('game-secret', str(report))
        self.assertNotIn('app-secret', str(report))
        self.assertTrue(any(item['id'] == 'docker.context' and item['evidence']['source'] == 'compose' for item in report['steps']))


if __name__ == '__main__':
    unittest.main()
