#!/usr/bin/env python3
"""Exercise the actual release template and startup with no public ports, SQL or ACME requests."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile


def command(arguments):
    subprocess.run(arguments, check=True, timeout=90)


def mount(source, destination, writable=False):
    return ['--mount', 'type=bind,src=' + str(source) + ',dst=' + destination + ('' if writable else ',readonly')]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('../muonline-web-laravel'))
    args = parser.parse_args()
    source = args.source.resolve() / 'docker/nginx/prod'
    for name in ('Dockerfile', 'startup.sh', 'certbot-renew.sh', 'default.conf.template'):
        if not (source / name).is_file():
            raise SystemExit('Missing release nginx contract: ' + name)
    with tempfile.TemporaryDirectory(prefix='mu-laravel-nginx-', dir='/tmp') as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        spec = importlib.util.spec_from_file_location('manager_worker', Path(__file__).resolve().parents[1] / 'runtime/worker.py')
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        worker.ROOT = root
        worker.APP = root / 'application'
        worker.APP.mkdir()
        (worker.APP / '.env').write_text('APP_ENV=local\n')
        compose_file = root / 'compose.json'
        compose_file.write_text(json.dumps(worker.compose_config({'mode': 'domain', 'host': 'mu.example.test', 'email': 'owner@example.test'})))
        resolved = json.loads(subprocess.check_output(['docker', 'compose', '-f', str(compose_file), 'config', '--format', 'json'], text=True, timeout=30))
        assert 'Host: $$APP_DOMAIN' in resolved['services']['nginx']['healthcheck']['test'][1], resolved['services']['nginx']['healthcheck']['test']
        assert resolved['services']['app']['environment']['APP_ENV'] == 'local'
        print('PASS: actual Compose interpolation preserves the container domain variable and independent APP_ENV', flush=True)
        certificates = root / 'certificates/live/mu.example.test'
        certificates.mkdir(parents=True)
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=mu.example.test', '-keyout', str(certificates / 'privkey.pem'), '-out', str(certificates / 'fullchain.pem')])
        (certificates / 'privkey.pem').chmod(0o644)  # Disposable self-signed test key, never a release artifact.
        challenge = root / 'acme/.well-known/acme-challenge/review-token'
        challenge.parent.mkdir(parents=True)
        challenge.write_text('muonline-release-acme-ok')
        config = root / 'nginx.conf'
        config.write_text('worker_processes 1; pid /tmp/nginx.pid; error_log /dev/stderr; events {} http { access_log /dev/stdout; ' + (source / 'default.conf.template').read_text().replace('${APP_DOMAIN}', 'mu.example.test') + ' }')
        probe = 'nginx -t -p /etc/nginx/ -c /etc/nginx/nginx.conf; nginx -p /etc/nginx/ -c /etc/nginx/nginx.conf; trap "nginx -s quit -p /etc/nginx/ -c /etc/nginx/nginx.conf" EXIT; test "$(wget -q -O - --header="Host: mu.example.test" http://127.0.0.1/.well-known/acme-challenge/review-token)" = "muonline-release-acme-ok"; test "$(wget -q -O - --no-check-certificate https://127.0.0.1/health)" = "ok"; echo "PASS: actual Laravel nginx template serves HTTP-01 and HTTPS health"'
        command(['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '101:101', '--add-host', 'app:127.0.0.1', '--tmpfs', '/tmp:rw,nosuid,noexec,mode=1777', '--tmpfs', '/var/cache/nginx:rw,nosuid,noexec,mode=1777', *mount(config, '/etc/nginx/nginx.conf'), *mount(root / 'acme', '/var/www/certbot'), *mount(root / 'certificates', '/etc/letsencrypt'), '--entrypoint', '/bin/sh', 'nginx:1.29-alpine', '-ec', probe])
        # Run the unchanged Bash startup twice. Only the certificate authority and OS
        # daemons are stubs; the real production startup/template/renew script are used.
        harness = root / 'harness'
        harness.mkdir(mode=0o777)
        harness.chmod(0o777)
        binaries = harness / 'bin'
        binaries.mkdir()
        stubs = {
            'certbot': '''#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> /review/state/certbot-calls
if [[ "$1" == certonly ]]; then
 [[ " $* " == *" --standalone "* && " $* " == *" --non-interactive "* ]]
 mkdir -p "/etc/letsencrypt/live/$APP_DOMAIN"
 printf 'fixture certificate' > "/etc/letsencrypt/live/$APP_DOMAIN/fullchain.pem"
elif [[ "$1" == renew ]]; then
 [[ " $* " == *" --webroot "* && " $* " == *" --deploy-hook nginx -s reload "* ]]
else exit 2; fi
''',
            'service': '#!/bin/bash\nset -eu\n[[ "$*" == "cron start" ]]\nprintf "cron\\n" >> /review/state/order\n',
            'envsubst': '''#!/bin/bash
set -euo pipefail
[[ "$1" == '${APP_DOMAIN}' ]]
while IFS= read -r line || [[ -n "$line" ]]; do printf '%s\\n' "${line//'${APP_DOMAIN}'/$APP_DOMAIN}"; done
''',
            'nginx': '''#!/bin/bash
set -euo pipefail
[[ -f "/etc/letsencrypt/live/$APP_DOMAIN/fullchain.pem" ]]
config=$(cat /etc/nginx/conf.d/default.conf)
[[ "$config" == *"server_name $APP_DOMAIN;"* && "$config" == *'$host'* ]]
printf '%s\\n' "$*" >> /review/state/order
'''
        }
        for name, content in stubs.items():
            file = binaries / name
            file.write_text(content)
            file.chmod(0o755)
        cert_root = harness / 'certificates'
        cert_root.mkdir(mode=0o777)
        cert_root.chmod(0o777)
        runner = 'set -euo pipefail; export PATH=/review/state/bin:$PATH APP_DOMAIN=mu.example.test NGINX_SSL_EMAIL=owner@example.test; bash /review/startup.sh; bash /review/startup.sh; bash /review/renew.sh; [[ $(wc -l </review/state/certbot-calls) == 2 ]]; [[ $(grep -c -- certonly /review/state/certbot-calls) == 1 ]]; echo "PASS: actual Laravel startup issues once, reuses certificates, starts cron and renews with webroot/reload hook (ACME mocked)"'
        command(['docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', str(os.getuid()) + ':' + str(os.getgid()), '--tmpfs', '/etc/nginx/conf.d:rw,nosuid,noexec,mode=1777', *mount(harness, '/review/state', True), *mount(cert_root, '/etc/letsencrypt', True), *mount(source / 'startup.sh', '/review/startup.sh'), *mount(source / 'certbot-renew.sh', '/review/renew.sh'), *mount(source / 'default.conf.template', '/etc/nginx/templates/default.conf.template'), '--entrypoint', '/bin/bash', 'mcr.microsoft.com/powershell:7.5-ubuntu-24.04', '-c', runner])


if __name__ == '__main__':
    main()
