#!/usr/bin/env python3
"""Verify native backup SQL against an isolated disposable SQL Server, never production."""
import argparse
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
spec = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1] / 'runtime/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
name = 'mu-manager-backup-test-' + secrets.token_hex(5)
secret = secrets.token_hex(32) + 'Ss@'
network_created = False
server_created = False


def execute(arguments, data=None, check=True):
    """Capture all diagnostics privately, with no password in process arguments or errors."""
    result = subprocess.run(arguments, input=data, text=True, capture_output=True, timeout=120)
    if check and result.returncode:
        raise RuntimeError('Disposable SQL test command failed; diagnostics withheld to protect generated credentials.')
    return result


try:
    execute(['docker', 'network', 'create', '--internal', name])
    network_created = True
    with tempfile.TemporaryDirectory(prefix='mu-sql-test-') as temporary:
        env = Path(temporary) / 'sql.env'
        env.write_text('ACCEPT_EULA=Y\nMSSQL_PID=Developer\nMSSQL_SA_PASSWORD=' + secret + '\nSQLCMDPASSWORD=' + secret + '\n')
        os.chmod(env, 0o600)
        execute(['docker', 'run', '-d', '--name', name, '--network', name, '--network-alias', 'sql-test', '--env-file', str(env), args.sql_image])
        server_created = True
    sqlcmd = ['docker', 'exec', '-i', name, '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-C', '-b']
    for attempt in range(60):
        if execute(sqlcmd + ['-Q', 'SELECT 1'], check=False).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Disposable SQL Server did not become ready.')
    execute(sqlcmd, data='CREATE DATABASE [ManagerTestWeb];\nGO\nCREATE DATABASE [ManagerTestGame];\nGO\n')
    payload = {'username': 'sa', 'password': secret, 'databases': [{'name': 'ManagerTestWeb', 'path': '/var/opt/mssql/data/manager-web.bak'}, {'name': 'ManagerTestGame', 'path': '/var/opt/mssql/data/manager-game.bak'}]}
    result = execute(['docker', 'run', '--rm', '-i', '--network', name, '--env', 'DB_HOST=sql-test', '--env', 'DB_PORT=1433', '--env', 'DB_TRUST_SERVER_CERTIFICATE=true', '--entrypoint', 'php', args.php_image, '-r', worker.SQL_BACKUP], data=json.dumps(payload))
    if 'SQL backups verified.' not in result.stdout or secret in result.stdout + result.stderr:
        raise RuntimeError('SQL backup contract or secret handling failed.')
    print('PASS: SQL Server COPY_ONLY/CHECKSUM backup and RESTORE VERIFYONLY for both databases using PDO/private stdin. No host port or production network access.')
finally:
    if server_created:
        execute(['docker', 'rm', '-f', '-v', name], check=False)
    if network_created:
        execute(['docker', 'network', 'rm', name], check=False)
