#!/usr/bin/env python3
"""Build a production Laravel image from a clean Git snapshot and export runtime release archives."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile


def command(arguments, **options):
    """Run build tools without shell interpolation."""
    return subprocess.run(arguments, check=True, **options)


def profiles_from_registry(source):
    """Extract registry keys without maintaining a second adapter list."""
    registry = (source / 'config/game.php').read_text()
    section = re.search(r"'version_profiles'\s*=>\s*\[(.*?)\]", registry, re.S)
    if not section:
        raise ValueError('Missing Laravel version_profiles registry.')
    profiles = re.findall(r"'([a-zA-Z0-9_]+)'\s*=>", section[1])
    if not profiles:
        raise ValueError('Empty Laravel version_profiles registry.')
    return profiles


def archive_tree(source, destination, vendor):
    """Package only runtime files, excluding dependencies from the application archive."""
    excluded = {'.git', '.github', '.agents', '.codex', '.aws', '.claude', '.ai', 'node_modules', 'tests', 'docs', 'storage'}
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for root, directories, filenames in os.walk(source, followlinks=False):
            relative_root = Path(root).relative_to(source)
            if relative_root == Path('.'):
                directories[:] = [name for name in directories if name not in excluded and (name == 'vendor') == vendor]
            directories[:] = [name for name in directories if not (Path(root) / name).is_symlink()]
            for name in sorted(filenames):
                file = Path(root) / name
                relative = file.relative_to(source)
                if vendor != (relative.parts[0] == 'vendor') or file.is_symlink():
                    continue
                if name == '.env' or name.startswith('.env.') or name.endswith(('.pem', '.pfx', '.key')) or relative.as_posix() in ('public/hot', 'script.sql'):
                    continue
                if relative.parts[:2] == ('bootstrap', 'cache') and name != '.gitignore':
                    continue
                archive.write(file, relative.as_posix())


def package(runtime, output, version, cdn, manager_min='0.1.0'):
    """Write application.zip, production vendor.zip and an unsigned, signable manifest."""
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Version must be stable major.minor.patch.')
    if not cdn.startswith('https://'):
        raise ValueError('CDN must use HTTPS.')
    for required in ('artisan', 'vendor/autoload.php', 'vendor/composer/installed.json', 'public/build/manifest.json', 'docker/php/Dockerfile'):
        if not (runtime / required).is_file():
            raise ValueError('Incomplete production runtime: ' + required)
    installed = json.loads((runtime / 'vendor/composer/installed.json').read_text())
    if not isinstance(installed, dict) or installed.get('dev') is not False:
        raise ValueError('vendor/ must be produced by composer install --no-dev.')
    output.mkdir(parents=True, exist_ok=True)
    artifacts = {}
    for name in ('application', 'vendor'):
        archive = output / (name + '.zip')
        archive_tree(runtime, archive, name == 'vendor')
        with archive.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        artifacts[name] = {'url': cdn.rstrip('/') + '/muonline-web/releases/v' + version + '/' + archive.name, 'sha256': digest, 'size': archive.stat().st_size}
    manifest = {'schema': 1, 'kind': 'web', 'version': version, 'compatibility': {'managerMin': manager_min, 'runtime': 'wsl2-docker-v1', 'php': '8.5', 'database': 'sqlsrv', 'architecture': 'amd64'}, 'profiles': profiles_from_registry(runtime), 'artifacts': artifacts}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def export_runtime(source, destination, revision):
    """Build from git archive so local uncommitted Laravel changes remain untouched."""
    with tempfile.TemporaryDirectory(prefix='muonline-source-') as temporary:
        tree = Path(temporary)
        snapshot = tree / 'source.tar'
        with snapshot.open('wb') as stream:
            command(['git', '-C', str(source), 'archive', revision], stdout=stream)
        context = tree / 'source'
        context.mkdir()
        with tarfile.open(snapshot) as archive:
            archive.extractall(context, filter='data')
        image = 'muonline-release:' + os.urandom(6).hex()
        container = None
        try:
            command(['docker', 'build', '--target', 'production', '--tag', image, '--file', str(context / 'docker/php/Dockerfile'), str(context)])
            container = subprocess.check_output(['docker', 'create', image], text=True).strip()
            command(['docker', 'cp', container + ':/var/www/html/.', str(destination)])
        finally:
            if container:
                command(['docker', 'rm', container], stdout=subprocess.DEVNULL)
            command(['docker', 'image', 'rm', image], stdout=subprocess.DEVNULL)


def main():
    """Export/build production assets without publishing to R2."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('../muonline-web-laravel'))
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--runtime', type=Path, help='Already-built production runtime (skips Docker build).')
    parser.add_argument('--output', type=Path, default=Path('artifacts/web'))
    parser.add_argument('--version', required=True)
    parser.add_argument('--cdn', default='https://cdn.interweb.bg')
    args = parser.parse_args()
    if args.runtime:
        package(args.runtime.resolve(), args.output, args.version, args.cdn)
    else:
        with tempfile.TemporaryDirectory(prefix='muonline-runtime-') as temporary:
            runtime = Path(temporary)
            export_runtime(args.source.resolve(), runtime, args.ref)
            package(runtime, args.output, args.version, args.cdn)
    print('Created unsigned release in ' + str(args.output) + '. Sign manifest.json before distribution. Nothing was uploaded.')


if __name__ == '__main__':
    main()
