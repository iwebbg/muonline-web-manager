#!/usr/bin/env python3
"""Stage an exported release and verify its runtime files, Compose and nginx without installing it."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--release', type=Path, default=Path('artifacts/web'))
parser.add_argument('--php-image', default='muonline-web-local-app:latest')
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1] / 'runtime/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def command(arguments):
    """Verify isolated release commands while retaining no secret-bearing diagnostics."""
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError('Runtime release check failed: ' + arguments[0] + '. No production service was changed.')
    return result.stdout


with tempfile.TemporaryDirectory(prefix='mu-release-check-') as temporary:
    worker.ROOT = Path(temporary)
    manifest = json.loads((args.release / 'manifest.json').read_text())
    paths = {name: str((args.release / (name + '.zip')).resolve()) for name in ('application', 'vendor')}
    staging = worker.stage_release({'release': manifest, 'paths': paths})
    worker.APP = staging
    worker.COMPOSE = worker.ROOT / 'compose.json'
    (staging / '.env').write_text('APP_ENV=production\n')
    access = worker.access_settings({'mode': 'local'})
    worker.COMPOSE.write_text(json.dumps(worker.compose_config(access)))
    command(['docker', 'compose', '--file', str(worker.COMPOSE), 'config', '--quiet'])
    command(['docker', 'run', '--rm', '--network', 'none', '--user', '33:33', '--volume', str(staging) + ':/var/www/html:ro', '--entrypoint', 'php', args.php_image, '-r', 'require "/var/www/html/vendor/autoload.php"; if (!class_exists("Illuminate\\Foundation\\Application") || !is_readable("/var/www/html/public/build/manifest.json")) { exit(1); }'])
    for mode in ('local', 'ip', 'domain'):
        settings = {'mode': mode, 'host': 'mu.example.com' if mode == 'domain' else '192.0.2.1', 'email': 'owner@example.com', 'httpAcknowledged': True}
        config = worker.ROOT / (mode + '.conf')
        config.write_text(worker.nginx_config(worker.access_settings(settings), tls=False))
        command(['docker', 'run', '--rm', '--network', 'none', '--add-host', 'app:127.0.0.1', '--volume', str(config) + ':/etc/nginx/conf.d/default.conf:ro', 'nginx:1.29-alpine', 'nginx', '-t'])
    print('PASS: real production archives stage with matching registry/hashes; www-data reads vendor/build; Compose validates; Local/IP/ACME-bootstrap nginx configurations pass nginx -t. No site installed.')
