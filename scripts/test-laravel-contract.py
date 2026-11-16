#!/usr/bin/env python3
"""Check real admin:create private-stdin behavior in a disposable, network-isolated PHP test image."""
import argparse
import secrets
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='muonline-web-local-test:latest')
args = parser.parse_args()
password = secrets.token_hex(32) + 'Ss@'
command = ['docker', 'run', '--rm', '--network', 'none', '-i', '--env', 'APP_ENV=testing', '--env', 'APP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '--env', 'DB_CONNECTION=sqlite', '--env', 'DB_DATABASE=/tmp/manager-contract.sqlite', '--env', 'CACHE_STORE=array', '--env', 'SESSION_DRIVER=array', '--env', 'GAME_DATA_SOURCE=fixture', '--entrypoint', 'sh', args.image, '-c', 'touch /tmp/manager-contract.sqlite && php artisan migrate --force --no-interaction >/dev/null && php artisan admin:create']
result = subprocess.run(command, input='\n'.join(['Преглед Manager', 'review@example.invalid', password, password, '']), text=True, capture_output=True, timeout=120)
if result.returncode != 0 or 'Administrator created successfully.' not in result.stdout:
    raise SystemExit('admin:create private stdin contract failed. Output withheld to avoid credential disclosure.')
if password in result.stdout or password in result.stderr:
    raise SystemExit('admin:create exposed its private stdin password.')
print('PASS: real admin:create accepts Cyrillic name/private stdin, creates administrator, and never echoes the password. Disposable container removed.')
