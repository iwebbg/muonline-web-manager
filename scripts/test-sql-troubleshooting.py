#!/usr/bin/env python3
"""Real PDO classification on disposable SQL Server; no host port or production connection."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--php-image', default='muonline-web-integration-integration-test:latest')
parser.add_argument('--sql-image', default='mcr.microsoft.com/mssql/server:2022-latest')
args = parser.parse_args()
project = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sql_module', project / 'runtime/sql-troubleshooting.py')
sql = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sql)
name = 'mu-sql-diagnostic-test-' + secrets.token_hex(5)
admin_secret = secrets.token_hex(32) + 'Ss@'
runtime_secret = secrets.token_hex(32) + 'Ss@'
wrong_secret = secrets.token_hex(32) + 'Ss@'
network_created = False
server_created = False


def execute(arguments, data=None, check=True):
    """Keep command output private; never expose generated passwords in failures."""
    result = subprocess.run(arguments, input=data, capture_output=True, text=True, timeout=150)
    if check and result.returncode:
        raise RuntimeError('Disposable SQL diagnostic contract failed; raw output withheld.')
    return result


try:
    execute(['docker', 'network', 'create', '--internal', name])
    network_created = True
    with tempfile.TemporaryDirectory(prefix='mu-sql-diagnostic-') as temporary:
        environment = Path(temporary) / 'sql.env'
        environment.write_text('ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_SA_PASSWORD=' + admin_secret + '\nSQLCMDPASSWORD=' + admin_secret + '\n')
        os.chmod(environment, 0o600)
        execute(['docker', 'run', '-d', '--name', name, '--network', name, '--network-alias', 'sql-test', '--env-file', str(environment), args.sql_image])
        server_created = True
    sqlcmd = ['docker', 'exec', '-i', name, '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-C', '-b']
    for attempt in range(60):
        if execute(sqlcmd + ['-Q', 'SELECT 1'], check=False).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Disposable SQL server did not start.')
    # All identifiers and password syntax here are test-owned, not user input.
    setup = 'CREATE DATABASE [DiagApp];\nGO\nCREATE DATABASE [DiagGame];\nGO\n'
    setup += "CREATE LOGIN [diag_app] WITH PASSWORD='" + runtime_secret + "',CHECK_POLICY=OFF;\nGO\n"
    setup += "CREATE LOGIN [diag_game] WITH PASSWORD='" + runtime_secret + "',CHECK_POLICY=OFF;\nGO\n"
    setup += 'USE [DiagApp];\nGO\nCREATE USER [diag_app] FOR LOGIN [diag_app];\nGRANT CONNECT TO [diag_app];\nGO\nUSE [DiagGame];\nGO\nCREATE USER [diag_game] FOR LOGIN [diag_game];\nGRANT CONNECT TO [diag_game];\nGO\n'
    execute(sqlcmd, data=setup)
    environment = {'DB_HOST': 'sql-test', 'DB_PORT': '1433', 'DB_DATABASE': 'DiagApp', 'DB_USERNAME': 'diag_app', 'DB_PASSWORD': runtime_secret, 'DB_ENCRYPT': 'true', 'DB_TRUST_SERVER_CERTIFICATE': 'true', 'GAME_DB_HOST': 'sql-test', 'GAME_DB_PORT': '1433', 'GAME_DB_MUONLINE': 'DiagGame', 'GAME_DB_RANKING': 'MissingGame', 'GAME_RANKING_CONNECTION': 'ranking', 'GAME_DB_USERNAME': 'diag_game', 'GAME_DB_PASSWORD': wrong_secret, 'GAME_DB_ENCRYPT': 'true', 'GAME_DB_TRUST_SERVER_CERTIFICATE': 'true'}
    connections, _ = sql.build_connections(environment, {'adminUsername': 'sa', 'adminPassword': admin_secret})
    denied = copy.deepcopy(connections[0])
    denied.update(id='deniedDatabase', database='MissingApp')
    connections.append(denied)
    probe = ['docker', 'run', '--rm', '-i', '--network', name, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '33:33', '--volume', str(project / 'runtime/sql-probe.php') + ':/probe.php:ro', '--entrypoint', 'php', args.php_image, '/probe.php']
    raw = execute(probe, json.dumps({'connections': connections}))
    response = json.loads(raw.stdout)
    by_id = {item['id']: item for item in response['steps']}
    assert by_id['application.sql']['status'] == 'passed'
    assert by_id['application.permissions']['reason'] == 'runtimeAccess'
    assert by_id['application.login']['status'] == 'passed'
    assert by_id['game.sql']['reason'] == 'loginRejected'
    assert by_id['gameBootstrap.sql']['status'] == 'passed'
    assert by_id['gameBootstrap.database.MissingGame']['reason'] == 'restoreDatabase'
    assert by_id['deniedDatabase.sql']['reason'] == 'databaseAccess'
    for secret in (admin_secret, runtime_secret, wrong_secret):
        assert secret not in raw.stdout + raw.stderr
    certificate = copy.deepcopy(connections[0])
    certificate['trust'] = False
    tls_response = json.loads(execute(probe, json.dumps({'connections': [certificate]})).stdout)
    assert next(item for item in tls_response['steps'] if item['id'] == 'application.sql')['reason'] == 'certificate'
    # Test legacy error patterns in the real PHP classifier without weakening server/OS crypto.
    classifier = "require '/probe.php'; $samples=json_decode(stream_get_contents(STDIN),true); $out=[]; foreach($samples as $sample){$error=new PDOException($sample); $out[]=classifyDriverError($error);} echo json_encode($out);"
    classifier_command = probe[:-1] + ['-r', classifier]
    classified = json.loads(execute(classifier_command, json.dumps(['EE certificate key too weak; PWD=never-return', 'legacy sigalg disallowed or unsupported', 'Login failed for user; Error 18456'])).stdout)
    assert [item['reason'] for item in classified] == ['legacyTls', 'legacyTls', 'loginRejected']
    verification = execute(sqlcmd, data="IF DB_ID('MissingGame') IS NOT NULL OR DB_ID('MissingApp') IS NOT NULL THROW 50000, 'Diagnostic created a database', 1;\nGO\n")
    print('PASS: real PDO app success/game 18456, independent bootstrap, denied database, missing-game restore advice, TLS certificate classification, legacy crypto patterns and no diagnostic DB creation. Secrets never returned.')
finally:
    if server_created:
        execute(['docker', 'rm', '-f', '-v', name], check=False)
    if network_created:
        execute(['docker', 'network', 'rm', name], check=False)
