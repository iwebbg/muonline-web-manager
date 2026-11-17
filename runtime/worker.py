"""Privileged WSL runtime. Only fixed operations are accepted; input is JSON on stdin."""
import base64
import contextlib
import configparser
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import zipfile

ROOT = Path('/opt/muonline-web')
APP = ROOT / 'application'
STATE = ROOT / 'state.json'
COMPOSE = ROOT / 'compose.json'
RENEWAL_TIMER = Path('/etc/systemd/system/muonline-certificates.timer')
WSL_CONFIG = Path('/etc/wsl.conf')
OS_RELEASE = Path('/etc/os-release')
PID_ONE = Path('/proc/1/comm')
DEVELOPMENT_DIAGNOSTICS = False
RECORD_DIAGNOSTICS = False
DIAGNOSTIC_SECRETS = set()
DIAGNOSTIC_ACTION = ''


def diagnostic_secrets(value):
    """Collect known secrets recursively without saving the request or private state."""
    if isinstance(value, dict):
        for key, item in value.items():
            if isinstance(item, str) and item and (re.search(r'password|secret|token|key', key, re.I) or key == 'sqlAdmin'):
                DIAGNOSTIC_SECRETS.add(item)
            else:
                diagnostic_secrets(item)
    elif isinstance(value, list):
        for item in value:
            diagnostic_secrets(item)


def redact_development_output(value):
    """Keep detailed dev errors while removing known passwords and common connection strings."""
    text = value.decode('utf-8', errors='replace') if isinstance(value, bytes) else str(value or '')
    try:
        if STATE.exists():
            diagnostic_secrets(json.loads(STATE.read_text()))
    except (OSError, ValueError):
        pass
    variants = set()
    for secret in DIAGNOSTIC_SECRETS:
        variants.update((secret, json.dumps(secret)[1:-1], secret.replace("'", "''"), urllib.parse.quote(secret, safe=''), urllib.parse.quote_plus(secret), base64.b64encode(secret.encode()).decode()))
    for secret in sorted(variants, key=len, reverse=True):
        if len(secret) < 4:
            text = re.sub(r'(?<!\w)' + re.escape(secret) + r'(?!\w)', '[REDACTED]', text)
        else:
            text = text.replace(secret, '[REDACTED]')
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'(?i)([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@', r'\1[REDACTED]@', text)
    return re.sub(r'(?im)\b(password|pwd|token|secret|app_key)\b\s*(?:=>|=|:)\s*[^\r\n;,]+', r'\1=[REDACTED]', text)


def development_log(event, arguments, **details):
    """Dev-only, bounded root-private JSONL. Never record argv/stdin or unredacted output."""
    if not (DEVELOPMENT_DIAGNOSTICS or RECORD_DIAGNOSTICS):
        return
    operation = 'command'
    if arguments and arguments[0] == 'docker':
        operation = docker_failure(arguments, 0).split(': ', 1)[1].split(' ', 1)[0]
    elif arguments:
        operation = Path(arguments[0]).name
    entry = {'time': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'action': DIAGNOSTIC_ACTION, 'event': event, 'operation': operation}
    for key in ('stdout', 'stderr'):
        if key in details:
            entry[key] = redact_development_output(details[key])[-100000:]
    for key in ('exitCode', 'elapsedSeconds', 'errorType'):
        if key in details:
            entry[key] = details[key]
    try:
        directory = ROOT / 'diagnostics'
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        logfile = directory / 'runtime.jsonl'
        encoded = json.dumps(entry, ensure_ascii=True) + '\n'
        if logfile.exists() and logfile.stat().st_size + len(encoded) > 2 * 1024 * 1024:
            os.replace(logfile, directory / 'runtime.previous.jsonl')
        with logfile.open('a', encoding='utf-8') as stream:
            os.chmod(logfile, 0o600)
            stream.write(encoded)
    except OSError:
        # Diagnostics must not change deployment/recovery outcomes.
        pass


def development_logs():
    """Return only recorded, redacted dev diagnostics; production cannot access this endpoint."""
    require(DEVELOPMENT_DIAGNOSTICS, 'Development diagnostics are disabled.')
    return runtime_logs()


def runtime_logs():
    """Read redacted support diagnostics; enabled only by the trusted main process."""
    require(RECORD_DIAGNOSTICS or DEVELOPMENT_DIAGNOSTICS, 'Runtime diagnostics are disabled.')
    entries = []
    for name in ('runtime.previous.jsonl', 'runtime.jsonl'):
        logfile = ROOT / 'diagnostics' / name
        if logfile.exists():
            for line in logfile.read_text(encoding='utf-8').splitlines():
                try:
                    entries.append(json.loads(line))
                except ValueError:
                    continue
    selected = []
    size = 0
    for entry in reversed(entries):
        rendered = '[' + entry['time'] + '] ' + entry['action'] + ' / ' + entry['operation'] + ' / ' + entry['event']
        if 'exitCode' in entry:
            rendered += ' / exit ' + str(entry['exitCode']) + ' / ' + str(entry.get('elapsedSeconds', 0)) + 's'
        for key in ('stdout', 'stderr'):
            if entry.get(key):
                rendered += '\n' + key + ':\n' + entry[key]
        if size + len(rendered) > 600000:
            break
        selected.append(rendered)
        size += len(rendered)
    return '\n\n'.join(reversed(selected)) or 'No runtime logs recorded yet. Retry the operation with the updated manager first.'


def ensure_linux_user():
    """Create a fixed local account with a locked password; do not change existing passwords."""
    import pwd
    try:
        account = pwd.getpwnam('muonline')
    except KeyError:
        run(['useradd', '--create-home', '--user-group', '--shell', '/bin/bash', 'muonline'])
        account = pwd.getpwnam('muonline')
    require(account.pw_uid >= 1000, 'The muonline Linux account conflicts with a system account.')
    return account.pw_name


def prepare_wsl():
    """Idempotently prepare Ubuntu via explicit WSL root/exec, without interactive OOBE."""
    release = dict(line.split('=', 1) for line in OS_RELEASE.read_text().splitlines() if '=' in line)
    require(release.get('ID', '').strip('"') == 'ubuntu' and release.get('VERSION_ID', '').strip('"') == '24.04', 'Ubuntu 24.04 is required.')
    require(run(['uname', '-m']).strip() == 'x86_64', 'This runtime requires x64 WSL.')
    username = ensure_linux_user()
    config = configparser.RawConfigParser()
    original = WSL_CONFIG.read_text() if WSL_CONFIG.exists() else ''
    config.read_string(original)
    if not config.has_section('boot'):
        config.add_section('boot')
    if config.get('boot', 'systemd', fallback='false').lower() != 'true':
        # Preserve all options and retain the original file (including comments) for recovery.
        backup = ROOT / 'wsl.conf.before-manager'
        if not backup.exists():
            atomic(backup, original)
        config.set('boot', 'systemd', 'true')
        import io
        text = io.StringIO()
        config.write(text)
        atomic(WSL_CONFIG, text.getvalue())
        os.chmod(WSL_CONFIG, 0o644)
    return {'linuxUser': username, 'restartRequired': PID_ONE.read_text().strip() != 'systemd'}


def require(condition, message):
    """Reject invalid input before executing a privileged operation."""
    if not condition:
        raise ValueError(message)


def docker_failure(arguments, code, output='', timed_out=False):
    """Return fixed diagnostic categories only; never echo argv, stdin or dependency output."""
    operation = 'command'
    if arguments[:2] == ['docker', 'compose']:
        index = 6 if arguments[2:3] == ['--project-name'] else 2
        verb = arguments[index] if len(arguments) > index else ''
        operation = {'build': 'build', 'up': 'start', 'run': 'bootstrap' if '--env-from-file' in arguments else 'run', 'exec': 'exec', 'ps': 'status', 'logs': 'logs'}.get(verb, 'compose')
    reason = 'unknown'
    patterns = [
        ('diskSpace', r'no space left on device'),
        ('daemon', r'cannot connect to the docker daemon|is the docker daemon running'),
        ('network', r'temporary failure resolving|could not resolve|no such host|tls handshake timeout|network is unreachable|i/o timeout'),
        ('imageMissing', r'manifest unknown|manifest for .+ not found|no matching manifest|pull access denied'),
        ('buildTarget', r'target stage .+ could not be found|target .+ could not be found'),
        ('dockerfile', r'failed to read dockerfile|cannot locate specified dockerfile'),
        ('buildContext', r'failed to calculate checksum|not found in build context|excluded by .dockerignore'),
        ('portBusy', r'port is already allocated|address already in use'),
        ('unhealthy', r'container .+ is unhealthy|dependency failed to start'),
        ('composeConfig', r'validating .+compose|invalid interpolation|failed to read .+env|no such service'),
        ('unsupportedOption', r'unknown flag:|unknown shorthand flag:'),
        ('sqlLogin', r'login failed for user|sqlstate\[28000\]'),
        ('permission', r'permission denied'),
        ('buildStep', r'failed to solve|did not complete successfully'),
    ]
    for candidate, expression in patterns:
        if re.search(expression, output, re.I):
            reason = candidate
            break
    if timed_out:
        reason = 'timeout'
    line = re.search(r'^Dockerfile:(\d{1,6})\s*$', output, re.M)
    location = '; Dockerfile line ' + line[1] if line else ''
    return 'Docker operation failed: ' + operation + ' (exit ' + str(code) + '; reason ' + reason + location + '). Output withheld to protect credentials.'


def run(arguments, *, data=None, timeout=1800, allow_failure=False):
    """Execute argument arrays without a shell and suppress potentially secret diagnostics."""
    started = time.monotonic()
    development_log('start', arguments)
    try:
        result = subprocess.run(arguments, input=data, text=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        development_log('timeout', arguments, exitCode='timeout', elapsedSeconds=round(time.monotonic() - started, 3), stdout=error.stdout, stderr=error.stderr)
        if arguments[0] == 'docker':
            raise RuntimeError(docker_failure(arguments, 'timeout', timed_out=True)) from None
        raise RuntimeError('Runtime command timed out: ' + arguments[0]) from None
    except OSError as error:
        development_log('error', arguments, errorType=type(error).__name__, elapsedSeconds=round(time.monotonic() - started, 3))
        raise
    development_log('finish', arguments, exitCode=result.returncode, elapsedSeconds=round(time.monotonic() - started, 3), stdout=result.stdout, stderr=result.stderr)
    if result.returncode and not allow_failure:
        if arguments[0] == 'docker':
            raise RuntimeError(docker_failure(arguments, result.returncode, (result.stdout or '') + '\n' + (result.stderr or '')))
        raise RuntimeError('Runtime command failed: ' + arguments[0] + ' (exit ' + str(result.returncode) + '). Check runtime diagnostics; output is withheld to protect credentials.')
    return result.stdout[-200000:]


def compose(*arguments, data=None, allow_failure=False):
    """Operate only on the manager-owned Compose project."""
    return run(['docker', 'compose', '--project-name', 'muonline-manager', '--file', str(COMPOSE), *arguments], data=data, allow_failure=allow_failure)


def atomic(path, content):
    """Replace a private configuration file without an incomplete write window."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb' if isinstance(content, bytes) else 'w') as stream:
            stream.write(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_state(state):
    """Persist private deployment state containing only runtime credentials."""
    atomic(STATE, json.dumps(state, indent=2))


def load_state():
    """Load the installed deployment record."""
    require(STATE.exists(), 'Install the application first.')
    return json.loads(STATE.read_text())


def password():
    """Generate the required 32 random bytes encoded as hex with a policy suffix."""
    return secrets.token_hex(32) + 'Ss@'


def identifier(value):
    """Allow only SQL identifiers accepted by the existing Laravel bootstrap."""
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,127}', value), 'Invalid SQL identifier.')
    require(value.lower() not in ('sa', 'master', 'model', 'msdb', 'tempdb'), 'Reserved SQL identifier.')
    return value


def single_line(value, maximum=255):
    """Accept bounded strings safe for dotenv and interactive command input."""
    require(isinstance(value, str) and 0 < len(value) <= maximum and not re.search(r'[\x00-\x1f\x7f]', value), 'Invalid text value.')
    return value


def env_text(values):
    """Encode literal dotenv strings without evaluating user input."""
    lines = []
    for key, value in values.items():
        value = str(value)
        require(not re.search(r'[\x00-\x1f\x7f]', value), 'Invalid environment value.')
        escaped = value.replace('\\', '\\\\').replace('"', '\\"').replace('$', '\\$')
        lines.append(key + '="' + escaped + '"')
    return '\n'.join(lines) + '\n'


def access_settings(settings):
    """Validate access independently of Laravel APP_ENV."""
    mode = settings.get('mode')
    require(mode in ('local', 'ip', 'domain'), 'Invalid access mode.')
    host = settings.get('host', '')
    if mode == 'local':
        host = 'localhost'
    elif mode == 'ip':
        host = str(ipaddress.ip_address(host))
        require(settings.get('httpAcknowledged') is True, 'Confirm the HTTP production warning.')
    else:
        host = host.lower()
        require(len(host) <= 253 and re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', host), 'Invalid domain.')
        single_line(settings.get('email', ''))
        require(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', settings['email']), 'Invalid ACME email.')
    url_host = '[' + host + ']' if ':' in host else host
    return {'mode': mode, 'host': host, 'email': settings.get('email', ''), 'url': ('https://' if mode == 'domain' else 'http://') + url_host}


def nginx_config(access, tls=False):
    """Generate an injection-safe nginx virtual host and ACME webroot."""
    host = access['host']
    if ':' in host:
        host = '[' + host + ']'
    if access['mode'] == 'domain' and not tls:
        return 'server { listen 80; server_name ' + host + '; location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; } location / { return 503; } }\n'
    common = '''
    root /var/www/html/public;
    index index.php;
    server_tokens off;
    client_max_body_size 16m;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }
    location = /health { return 200 'ok'; }
    location / { try_files $uri $uri/ /index.php?$query_string; }
    location = /index.php {
        include fastcgi_params;
        fastcgi_pass app:9000;
        fastcgi_param SCRIPT_FILENAME /var/www/html/public/index.php;
        fastcgi_param HTTPS HTTPS_VALUE;
    }
    location ~ \\.php$ { deny all; }
    location ~ /\\. { deny all; }
'''
    if tls:
        return ('server { listen 80; server_name ' + host + '; location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; } location / { return 301 https://$host$request_uri; } }\n'
                + 'server { listen 443 ssl; server_name ' + host + ';\nssl_certificate /etc/letsencrypt/live/' + host + '/fullchain.pem;\nssl_certificate_key /etc/letsencrypt/live/' + host + '/privkey.pem;\nssl_protocols TLSv1.2 TLSv1.3;\n'
                + common.replace('HTTPS_VALUE', 'on') + '}\n')
    return 'server { listen 80; server_name ' + host + ';\n' + common.replace('HTTPS_VALUE', 'off') + '}\n'


def compose_config(access):
    """Reuse the Laravel PHP development image as a runtime with prebuilt dependencies."""
    mount = str(APP) + ':/var/www/html'
    image = {'build': {'context': str(APP), 'dockerfile': 'docker/php/Dockerfile', 'target': 'development'}, 'image': 'muonline-manager-runtime:local', 'restart': 'unless-stopped', 'working_dir': '/var/www/html', 'user': '33:33', 'env_file': [str(APP / '.env')], 'volumes': [mount]}
    services = {}
    for name, role in [('app', 'app'), ('queue', 'queue'), ('scheduler', 'scheduler')]:
        services[name] = dict(image, environment={'CONTAINER_ROLE': role, 'APP_DB_BOOTSTRAP': 'false', 'APP_DB_ADMIN_USERNAME': '', 'APP_DB_ADMIN_PASSWORD': '', 'GAME_DB_ADMIN_USERNAME': '', 'GAME_DB_ADMIN_PASSWORD': ''}, depends_on={'redis': {'condition': 'service_healthy'}})
    services['app']['healthcheck'] = {'test': ['CMD-SHELL', 'cgi-fcgi -bind -connect 127.0.0.1:9000 >/dev/null 2>&1'], 'interval': '10s', 'timeout': '5s', 'retries': 30}
    services['queue']['depends_on']['app'] = {'condition': 'service_healthy'}
    services['scheduler']['depends_on']['app'] = {'condition': 'service_healthy'}
    binding = '127.0.0.1:' if access['mode'] == 'local' else ''
    services['nginx'] = {'image': 'nginx:1.29-alpine', 'restart': 'unless-stopped', 'ports': [binding + '80:80'] + ([binding + '443:443'] if access['mode'] == 'domain' else []), 'volumes': [mount + ':ro', str(ROOT / 'nginx.conf') + ':/etc/nginx/conf.d/default.conf:ro', str(ROOT / 'acme') + ':/var/www/certbot:ro', str(ROOT / 'certificates') + ':/etc/letsencrypt:ro'], 'depends_on': {'app': {'condition': 'service_healthy'}}, 'healthcheck': {'test': ['CMD-SHELL', 'wget -q --spider http://127.0.0.1/up'], 'interval': '10s', 'timeout': '5s', 'retries': 15}}
    if access['mode'] == 'domain':
        services['nginx']['healthcheck']['test'] = ['CMD-SHELL', 'wget -q --spider --no-check-certificate https://127.0.0.1/up']
    services['redis'] = {'image': 'redis:8-alpine', 'restart': 'unless-stopped', 'command': ['redis-server', '--appendonly', 'yes'], 'volumes': ['redis-data:/data'], 'healthcheck': {'test': ['CMD', 'redis-cli', 'ping'], 'interval': '5s', 'timeout': '3s', 'retries': 20}}
    services['certbot'] = {'image': 'certbot/certbot:v4.0.0', 'profiles': ['tools'], 'volumes': [str(ROOT / 'acme') + ':/var/www/certbot', str(ROOT / 'certificates') + ':/etc/letsencrypt']}
    return {'services': services, 'volumes': {'redis-data': {}}}


def update_access_environment(content, values):
    """Replace only explicitly selected keys, preserving comments and unrelated multiline values."""
    lines = content.splitlines(keepends=True)
    result = []
    seen = set()
    index = 0
    while index < len(lines):
        statement = lines[index]
        index += 1
        match = re.match(r'^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)', statement)
        if match:
            value = match[2]
            if value.startswith(('"', "'")):
                quote = value[0]
                remainder = value[1:]
                while True:
                    # Skip escaped characters when locating the closing quote.
                    if re.search(r'(?<!\\)(?:\\\\)*' + re.escape(quote), remainder):
                        break
                    require(index < len(lines), 'Site environment contains an unterminated quoted value.')
                    remainder += lines[index]
                    statement += lines[index]
                    index += 1
            if match[1] in values:
                seen.add(match[1])
                statement = env_text({match[1]: values[match[1]]})
        result.append(statement)
    text = ''.join(result)
    missing = {key: value for key, value in values.items() if key not in seen}
    if missing:
        text += ('' if not text or text.endswith('\n') else '\n') + env_text(missing)
    return text


def game_write_mode():
    """Read only the two literal safety flags from the actual dotenv file; never evaluate it."""
    file = APP / '.env'
    if not file.exists():
        return 'unknown'
    content = file.read_bytes().decode('utf-8')
    flags = {}
    for key in ('GAME_DB_READONLY', 'GAME_WRITES_ENABLED'):
        matches = re.findall(r'^\s*' + key + r'\s*=\s*(true|false|"true"|"false"|\'true\'|\'false\')\s*(?:#[^\r\n]*)?$', content, re.M | re.I)
        if len(matches) != 1:
            return 'unknown'
        flags[key] = matches[0].strip('"\'').lower()
    if flags == {'GAME_DB_READONLY': 'false', 'GAME_WRITES_ENABLED': 'true'}:
        return 'enabled'
    if flags == {'GAME_DB_READONLY': 'true', 'GAME_WRITES_ENABLED': 'false'}:
        return 'disabled'
    return 'unknown'


def apply_game_writes(state, settings):
    """Change only game write flags, recreate the project, and recover exact config on failure."""
    require(state.get('phase') == 'ready', 'Recover installation before changing game writes.')
    require(isinstance(settings, dict) and type(settings.get('enabled')) is bool and settings.get('confirmed') is True, 'Confirm the game write change and project restart.')
    current = game_write_mode()
    require(settings.get('expectedMode') == current, 'Game write settings changed. Refresh status and confirm again.')
    target = 'enabled' if settings['enabled'] else 'disabled'
    if current == target:
        return {'gameWrites': target, 'restarted': False}
    envfile = APP / '.env'
    require(envfile.exists(), 'Existing site environment is missing. Restore it before changing game writes.')
    previous = json.loads(json.dumps(state))
    backup = ROOT / 'backups' / ('game-writes-' + datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(3))
    backup.mkdir(parents=True)
    for source in (STATE, envfile):
        shutil.copy2(source, backup / source.name)
    flags = {'GAME_DB_READONLY': 'false' if settings['enabled'] else 'true', 'GAME_WRITES_ENABLED': 'true' if settings['enabled'] else 'false'}
    save_state(dict(previous, phase='game-writes-changing', recoveryBackup=str(backup)))

    def restart_project():
        # A plain docker restart does not reread env_file. Bypass the bootstrap entrypoint.
        compose('run', '--rm', '--no-deps', '--entrypoint', 'php', 'app', 'artisan', 'config:clear', '--no-interaction')
        compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')

    try:
        atomic(envfile, update_access_environment(envfile.read_bytes().decode('utf-8'), flags))
        os.chown(envfile, 33, 33)
        require(game_write_mode() == target, 'Game write flags are duplicated or invalid. Restore a consistent site environment.')
        state['environment'].update(flags)
        restart_project()
        save_state(dict(state, phase='ready'))
        return {'gameWrites': target, 'restarted': True}
    except Exception:
        try:
            atomic(envfile, (backup / '.env').read_bytes())
            os.chown(envfile, 33, 33)
            atomic(STATE, (backup / STATE.name).read_bytes())
            restart_project()
            state.clear()
            state.update(previous)
        except Exception:
            save_state(dict(previous, phase='game-writes-recovery-required', recoveryBackup=str(backup)))
            raise RuntimeError('Game write change and recovery failed. Recover configuration manually. Backup: ' + str(backup)) from None
        raise RuntimeError('Game write change failed; previous configuration restored. Backup: ' + str(backup)) from None


def write_configuration(state, tls=False, preserve_environment=False):
    """Write the site environment, reverse proxy and Docker project together."""
    access = state['access']
    access_environment = dict(APP_URL=access['url'], SESSION_SECURE_COOKIE=str(access['mode'] == 'domain').lower(), SESSION_DOMAIN='null', SESSION_HTTP_ONLY='true', SESSION_SAME_SITE='lax')
    environment_file = APP / '.env'
    if preserve_environment:
        require(environment_file.is_file(), 'Existing site environment is missing. Restore it before updating.')
    elif environment_file.exists():
        original = environment_file.read_bytes().decode('utf-8')
        atomic(environment_file, update_access_environment(original, access_environment))
    else:
        atomic(environment_file, env_text({**state['environment'], **access_environment}))
    os.chown(APP / '.env', 33, 33)
    atomic(ROOT / 'nginx.conf', nginx_config(access, tls))
    os.chmod(ROOT / 'nginx.conf', 0o644)
    atomic(COMPOSE, json.dumps(compose_config(access), indent=2))


def restore_access_configuration(backup):
    """Restore the exact pre-change files instead of reconstructing them from stale state."""
    for target in (COMPOSE, APP / '.env', ROOT / 'nginx.conf', STATE):
        source = backup / target.name
        if source.exists():
            atomic(target, source.read_bytes())
            os.chmod(target, stat.S_IMODE(source.stat().st_mode))
        else:
            target.unlink(missing_ok=True)
    if (APP / '.env').exists():
        os.chown(APP / '.env', 33, 33)


def safe_extract(archive, destination, kind):
    """Reject traversal, links, special files, duplicate paths and runtime-owned content."""
    with zipfile.ZipFile(archive) as bundle:
        require(len(bundle.infolist()) < 100000, 'Archive contains too many entries.')
        total = 0
        seen = set()
        for member in bundle.infolist():
            name = member.filename
            path = PurePosixPath(name)
            require(name and '\\' not in name and not path.is_absolute() and '..' not in path.parts and ':' not in name, 'Unsafe archive path.')
            require(str(path) not in seen, 'Duplicate archive path.')
            seen.add(str(path))
            mode = member.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'Archive links and special files are forbidden.')
            # Report only a fixed protected root, never file contents or arbitrary archive paths.
            require(path.parts[0] not in ('.env', '.git', 'node_modules', 'storage'), 'Archive contains protected runtime data (' + kind + ': ' + path.parts[0] + ').')
            if kind == 'vendor':
                require(path.parts[0] == 'vendor', 'Vendor archive must contain vendor/ only.')
            else:
                require(path.parts[0] != 'vendor', 'Application archive cannot contain vendor/.')
            total += member.file_size
            require(total <= 4 * 1024**3, 'Archive exceeds extraction size limit.')
        bundle.extractall(destination)
    # Private staging is root-only, but deployed code must be readable by PHP/nginx.
    for root, directories, files in os.walk(destination):
        os.chmod(root, 0o755)
        for filename in files:
            os.chmod(Path(root) / filename, 0o644)


def stage_release(request):
    """Stage hash-verified artifacts passed by the signature-verifying desktop process."""
    release = request['release']
    require(re.fullmatch(r'\d+\.\d+\.\d+', release['version']), 'Invalid release version.')
    staging = ROOT / 'staging' / (release['version'] + '-' + secrets.token_hex(6))
    staging.mkdir(parents=True)
    try:
        for kind in ('application', 'vendor'):
            item = release['artifacts'][kind]
            archive = Path(request['paths'][kind])
            require(archive.is_file() and archive.stat().st_size == item['size'], 'Artifact size mismatch.')
            require(hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() == item['sha256'], 'Artifact checksum mismatch.')
            safe_extract(archive, staging, kind)
        for relative in ('artisan', 'vendor/autoload.php', 'public/build/manifest.json', 'config/game.php', 'docker/php/Dockerfile'):
            require((staging / relative).is_file(), 'Incomplete runtime release: ' + relative)
        registry = (staging / 'config/game.php').read_text()
        section = re.search(r"'version_profiles'\s*=>\s*\[(.*?)\]", registry, re.S)
        require(section is not None, 'Laravel game profile registry is missing.')
        actual = re.findall(r"'([a-zA-Z0-9_]+)'\s*=>", section[1])
        require(actual == release['profiles'], 'Manifest profiles differ from the Laravel registry.')
        return staging
    except Exception:
        shutil.rmtree(staging)
        raise


def initialize_storage():
    """Make persistent Laravel write directories available to the runtime identity."""
    os.chmod(APP, 0o755)
    for relative in ('storage/app/public', 'storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views', 'storage/logs', 'bootstrap/cache'):
        directory = APP / relative
        directory.mkdir(parents=True, exist_ok=True)
        run(['chown', '-R', '33:33', str(directory)])
        run(['chmod', '-R', 'u+rwX,go+rX', str(directory)])
    for relative in ('storage', 'storage/app', 'storage/framework', 'storage/framework/cache', 'bootstrap'):
        os.chmod(APP / relative, 0o755)
        if relative != 'bootstrap':
            # The entrypoint runs as www-data and chmods these parents too; write access
            # to their children is insufficient when the parents still belong to root.
            os.chown(APP / relative, 33, 33)
    link = APP / 'public/storage'
    if not link.exists() and not link.is_symlink():
        link.symlink_to('../storage/app/public')


def diagnose_sql():
    """Return only recognized doctor messages; discard arbitrary command and exception output."""
    output = compose('exec', '-T', 'app', 'php', 'artisan', 'game:doctor', '--no-interaction', allow_failure=True)
    output = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', output)
    prefixes = (
        'Game database connection ', 'Game database diagnostics ', 'Required game profile schema ',
        'Missing required game table:', 'Missing required game column:', 'Missing required game procedure:',
        'SQL identity ', 'Unsafe SQL identity:', 'Unsafe SQL permission:', 'Missing SQL permission:',
        'Required adapter object permissions ', 'Authoritative item serial procedure ',
        'Game write safety switches ', 'Unsafe startup flags:', 'SQL role verification ',
        'Elevated permission verification ', 'Object permission verification ',
    )
    messages = []
    for line in output.splitlines():
        line = re.sub(r'^(INFO|ERROR|WARN)\s+', '', line.strip()).strip()
        if line.startswith(prefixes):
            messages.append(line[:1024])
    return {'passed': 'Game database diagnostics passed.' in messages, 'messages': messages or ['No recognized diagnostics returned. Check service status and runtime installation.']}


def create_admin(details):
    """Drive the existing admin:create prompts through private stdin, never argv."""
    name = single_line(details['name'])
    email = single_line(details['email'])
    secret = single_line(details['password'], 1024)
    require(len(secret) >= 12, 'Administrator password must have at least 12 characters.')
    require(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email), 'Invalid administrator email.')
    output = compose('exec', '-T', 'app', 'php', 'artisan', 'admin:create', data='\n'.join([name, email, secret, secret, '']))
    require('Administrator created successfully.' in output, 'Administrator creation was not confirmed.')
    return 'Administrator created.'


def administrator_snapshot(value):
    """Return only the documented public identity fields, never tokens or hashes."""
    require(isinstance(value, dict), 'Invalid administrator command response.')
    require(type(value.get('id')) is int and 0 < value['id'] <= 9007199254740991, 'Invalid administrator command response.')
    require(value.get('role') in ('administrator', 'game_master') and type(value.get('is_active')) is bool, 'Invalid administrator command response.')
    require(all(isinstance(value.get(key), str) and len(value[key]) <= 255 for key in ('name', 'email')), 'Invalid administrator command response.')
    return {key: value[key] for key in ('id', 'name', 'email', 'role', 'is_active')}


def manage_administrators(operation, details=None, secrets_to_hide=()):
    """Run fixed Artisan commands, accepting JSON validation failures without exposing process output."""
    details = details or {}
    require(operation in ('list', 'update', 'delete'), 'Unsupported administrator operation.')
    arguments = ['docker', 'compose', '--project-name', 'muonline-manager', '--file', str(COMPOSE), 'exec', '-T', 'app', 'php', 'artisan', 'admin:' + operation]
    private_input = None
    if operation != 'list':
        identity = details.get('id')
        require(type(identity) is int and 0 < identity <= 9007199254740991, 'Invalid administrator ID.')
        arguments.append(str(identity))
    if operation == 'update':
        require(set(details) <= {'id', 'name', 'email', 'is_active', 'password', 'confirmed'}, 'Invalid administrator update fields.')
        changes = 0
        for key in ('name', 'email'):
            if key in details:
                arguments.append('--' + key + '=' + single_line(details[key]))
                changes += 1
        if 'is_active' in details:
            require(type(details['is_active']) is bool, 'Invalid administrator active state.')
            require(details['is_active'] or details.get('confirmed') is True, 'Confirm administrator deactivation.')
            arguments.append('--active=' + ('1' if details['is_active'] else '0'))
            changes += 1
        if 'password' in details:
            secret = single_line(details['password'], 1024)
            valid_password = (
                len(secret.encode('utf-8')) <= 4096 and len(secret) >= 12
                and any(char.isupper() for char in secret)
                and any(char.islower() for char in secret)
                and any(char.isdigit() for char in secret)
                and any(not char.isalnum() and not char.isspace() for char in secret)
            )
            if not valid_password:
                return {'code': 'validation', 'errors': {'password': ['Administrator password must have at least 12 characters, uppercase, lowercase, number and symbol.']}}
            arguments.append('--password-stdin')
            private_input = secret + '\n'
            secrets_to_hide = (*secrets_to_hide, secret)
            changes += 1
        require(changes > 0, 'Provide at least one administrator change.')
    if operation == 'delete':
        require(details.get('confirmed') is True, 'Confirm administrator deletion.')
        arguments.append('--force')
    arguments.extend(['--json', '--no-interaction'])
    try:
        result = subprocess.run(arguments, input=private_input, text=True, capture_output=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired):
        return {'code': 'commandUnavailable'}
    output = result.stdout
    if len(output) > 2000000:
        return {'code': 'invalidResponse'}
    try:
        response = json.loads(output)
        require(isinstance(response, dict), 'Invalid administrator command response.')
        if result.returncode != 0:
            errors = {}
            for field, messages in response.get('errors', {}).items():
                if field not in ('name', 'email', 'password', 'is_active', 'administrator', 'database', 'confirmation') or not isinstance(messages, list):
                    continue
                safe = []
                for message in messages[:10]:
                    if not isinstance(message, str):
                        continue
                    for secret in secrets_to_hide:
                        if secret:
                            message = message.replace(secret, '[REDACTED]')
                    safe.append(message[:1000])
                if safe:
                    errors[field] = safe
            return {'code': 'validation', 'errors': errors} if errors else {'code': 'commandUnavailable'}
        require('errors' not in response, 'Invalid administrator command response.')
        if operation == 'list':
            require(isinstance(response.get('administrators'), list), 'Invalid administrator command response.')
            return {'administrators': [administrator_snapshot(row) for row in response['administrators']]}
        if operation == 'delete':
            require(response.get('administrator') == {'id': details['id'], 'deleted': True}, 'Invalid administrator command response.')
            return {'administrator': {'id': details['id'], 'deleted': True}}
        row = administrator_snapshot(response.get('administrator'))
        require(row['id'] == details['id'], 'Invalid administrator command response.')
        return {'administrator': row}
    except (ValueError, TypeError, AttributeError):
        # Missing commands in an older web release and bootstrap crashes need distinct, safe guidance.
        missing = re.search(r'(command[^\r\n]*admin:[a-z]+[^\r\n]*not defined|no commands defined in the ["\']admin["\'] namespace)', output + result.stderr, re.I)
        return {'code': 'releaseRequired' if missing else 'invalidResponse'}


def install(request):
    """Provision restricted SQL identities using the existing Laravel entrypoint bootstrap."""
    require(not STATE.exists() and not APP.exists(), 'Existing installation detected. Use recovery or update instead.')
    values = request['settings']
    game = identifier(values['gameDatabase'])
    web = identifier(values['webDatabase'])
    app_login = identifier(values['appLogin'])
    game_login = identifier(values['gameLogin'])
    admin_login = single_line(values['sqlAdmin'])
    require(len({app_login.lower(), game_login.lower(), admin_login.lower()}) == 3 and game.lower() != web.lower(), 'SQL databases and runtime identities must be distinct.')
    host = single_line(values['sqlHost'])
    require(re.fullmatch(r'[a-zA-Z0-9_.:-]+', host), 'Invalid SQL host.')
    port = int(values['sqlPort'])
    require(1 <= port <= 65535, 'Invalid SQL port.')
    require(values['appEnv'] in ('local', 'production'), 'Invalid APP_ENV.')
    require(values['profile'] in request['release']['profiles'], 'Choose a profile from the release registry.')
    state = {'version': request['release']['version'], 'access': access_settings(values['access']), 'environment': {}}
    environment = state['environment']
    environment.update(
        APP_NAME='MuOnline Web',
        APP_ENV=values['appEnv'],
        APP_DEBUG='false',
        APP_KEY='base64:' + base64.b64encode(secrets.token_bytes(32)).decode(),
        DB_CONNECTION='sqlsrv',
        DB_HOST=host,
        DB_PORT=str(port),
        DB_DATABASE=web,
        DB_USERNAME=app_login,
        DB_PASSWORD=password(),
        DB_ENCRYPT='true',
        DB_TRUST_SERVER_CERTIFICATE=str(values.get('trustCertificate') is True).lower(),
        GAME_DB_CONNECTION='sqlsrv',
        GAME_DB_HOST=host,
        GAME_DB_PORT=str(port),
        GAME_DB_MUONLINE=game,
        GAME_DB_RANKING=game,
        GAME_DB_USERNAME=game_login,
        GAME_DB_PASSWORD=password(),
        GAME_DB_ENCRYPT='true',
        GAME_DB_TRUST_SERVER_CERTIFICATE=str(values.get('trustCertificate') is True).lower(),
        GAME_DATA_SOURCE='database',
        GAME_SERVER_PROFILE=values['profile'],
        GAME_EVENT_PROFILE=values['profile'],
        GAME_ACCOUNT_PASSWORD_SCHEME='darksteam_md5' if values['profile'] == 'darksteam_1_0m' else 'plaintext',
        GAME_DB_READONLY='true',
        GAME_WRITES_ENABLED='false',
        GAME_RANKING_CONNECTION='game',
        GAME_BATTLE_CORE_READS_ENABLED='false',
        REDIS_HOST='redis',
        CACHE_STORE='redis',
        SESSION_DRIVER='redis',
        QUEUE_CONNECTION='redis',
        APP_DB_BOOTSTRAP='false',
        AUTO_MIGRATE='false',
    )
    sql_secret = single_line(values['sqlPassword'], 1024)
    staging = stage_release(request)
    state['themeHashes'] = theme_hashes(staging)
    staging.rename(APP)
    initialize_storage()
    for directory in ('acme', 'certificates', 'backups'):
        (ROOT / directory).mkdir(exist_ok=True)
    os.chmod(ROOT / 'acme', 0o755)
    write_configuration(state)
    save_state(dict(state, phase='bootstrap-pending'))
    return finish_install(state, {'sqlAdmin': admin_login, 'sqlPassword': sql_secret, 'administrator': values['administrator']})


def finish_install(state, credentials):
    """Resume an interrupted bootstrap without rotating runtime passwords or APP_KEY."""
    phase = state.get('phase', 'bootstrap-pending')
    require(phase in ('bootstrap-pending', 'runtime-bootstrapped', 'administrator-created'), 'Only incomplete first installations can be resumed.')
    state['phase'] = phase
    write_configuration(state)
    compose('build', 'app')
    compose('up', '-d', '--wait', 'redis')
    if phase == 'bootstrap-pending':
        bootstrap = dict(state['environment'], APP_DB_BOOTSTRAP='true', APP_DB_ADMIN_USERNAME=single_line(credentials['sqlAdmin']), APP_DB_ADMIN_PASSWORD=single_line(credentials['sqlPassword'], 1024))
        descriptor, filename = tempfile.mkstemp(prefix='muonline-bootstrap-', dir='/dev/shm')
        try:
            with os.fdopen(descriptor, 'w') as stream:
                stream.write(env_text(bootstrap))
            compose('run', '--rm', '--no-deps', '--env-from-file', filename, 'app', 'true')
        finally:
            Path(filename).unlink(missing_ok=True)
        state['phase'] = 'runtime-bootstrapped'
        save_state(state)
    compose('up', '-d', '--wait', '--wait-timeout', '300', 'app', 'queue', 'scheduler')
    require(diagnose_sql()['passed'], 'Game database diagnostics failed. Run SQL diagnostics to inspect schema and permission checks.')
    if state['phase'] == 'runtime-bootstrapped':
        create_admin(credentials['administrator'])
        state['phase'] = 'administrator-created'
        save_state(state)
    # Initial IP mode was already explicitly confirmed before the installation state was saved.
    apply_access(state, {**state['access'], 'httpAcknowledged': state['access']['mode'] == 'ip'}, initial=True)
    save_state(dict(state, phase='ready'))
    return 'Installation complete. Bootstrap credentials removed. Game writes remain disabled.'


def issue_certificate(access):
    """Obtain a domain-specific certificate through the HTTP-01 webroot challenge."""
    compose('run', '--rm', 'certbot', 'certonly', '--webroot', '-w', '/var/www/certbot', '--non-interactive', '--agree-tos', '--email', access['email'], '-d', access['host'], '--keep-until-expiring')


def renewal_timer(enabled):
    """Renew certificates and reload nginx independently of the desktop application."""
    if not enabled:
        run(['systemctl', 'disable', '--now', 'muonline-certificates.timer'])
        return
    atomic('/etc/systemd/system/muonline-certificates.service', '[Unit]\nDescription=MuOnline Web certificate renewal\nAfter=docker.service\n[Service]\nType=oneshot\nExecStart=/usr/bin/docker compose -p muonline-manager -f /opt/muonline-web/compose.json run --rm certbot renew --webroot -w /var/www/certbot --quiet\nExecStart=/usr/bin/docker compose -p muonline-manager -f /opt/muonline-web/compose.json exec -T nginx nginx -s reload\n')
    atomic(RENEWAL_TIMER, '[Unit]\nDescription=MuOnline certificate renewal schedule\n[Timer]\nOnCalendar=*-*-* 03,15:00:00\nRandomizedDelaySec=3600\nPersistent=true\n[Install]\nWantedBy=timers.target\n')
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'enable', '--now', 'muonline-certificates.timer'])


def apply_access(state, settings, initial=False):
    """Back up access configuration and restore it when nginx, ACME or health checks fail."""
    access = access_settings(settings)
    previous = json.loads(json.dumps(state))
    backup = ROOT / 'backups' / ('access-' + datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(3))
    backup.mkdir(parents=True)
    for source in (STATE, COMPOSE, APP / '.env', ROOT / 'nginx.conf'):
        if source.exists():
            shutil.copy2(source, backup / source.name)
    state['access'] = access
    save_state(dict(previous, phase='access-changing'))
    try:
        write_configuration(state)
        compose('up', '-d', '--force-recreate', 'app', 'queue', 'scheduler', 'nginx')
        if access['mode'] == 'domain':
            issue_certificate(access)
            write_configuration(state, tls=True)
            compose('up', '-d', '--force-recreate', 'nginx')
            compose('exec', '-T', 'nginx', 'nginx', '-t')
            renewal_timer(True)
        elif RENEWAL_TIMER.exists():
            renewal_timer(False)
        compose('exec', '-T', 'app', 'php', 'artisan', 'config:clear', '--no-interaction')
        compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')
        compose('exec', '-T', 'nginx', 'nginx', '-t')
        save_state(state)
    except Exception:
        state.clear()
        state.update(previous)
        try:
            restore_access_configuration(backup)
            if initial:
                if RENEWAL_TIMER.exists():
                    renewal_timer(False)
            else:
                compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')
                compose('exec', '-T', 'app', 'php', 'artisan', 'config:clear', '--no-interaction')
                compose('restart', 'app', 'queue', 'scheduler')
                if previous['access']['mode'] == 'domain':
                    renewal_timer(True)
                elif RENEWAL_TIMER.exists():
                    renewal_timer(False)
        except Exception:
            with contextlib.suppress(Exception):
                save_state(dict(previous, phase='access-recovery-required', backup=str(backup)))
            raise RuntimeError('Access change and recovery failed. Restore the private configuration backup: ' + str(backup)) from None
        if initial:
            raise RuntimeError('Initial access setup failed. Installation state was preserved; use Resume installation after correcting DNS/firewall. Backup: ' + str(backup)) from None
        raise RuntimeError('Access change failed; previous configuration restored. Backup: ' + str(backup)) from None
    return 'Access configuration applied: ' + access['url']


SQL_BACKUP = r'''
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
try {
    $dsn = "sqlsrv:Server=".getenv("DB_HOST").",".getenv("DB_PORT").";Database=master;Encrypt=true;TrustServerCertificate=".getenv("DB_TRUST_SERVER_CERTIFICATE").";LoginTimeout=10";
    $pdo = new PDO($dsn, $input["username"], $input["password"], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    foreach ($input["databases"] as $database) {
        if (!preg_match('/\A[A-Za-z][A-Za-z0-9_]{0,127}\z/', $database["name"])) { exit(2); }
        $query = $pdo->prepare("BACKUP DATABASE [".$database["name"]."] TO DISK = ? WITH COPY_ONLY, CHECKSUM, INIT");
        $query->execute([$database["path"]]);
        $verify = $pdo->prepare("RESTORE VERIFYONLY FROM DISK = ? WITH CHECKSUM");
        $verify->execute([$database["path"]]);
    }
} catch (Throwable $exception) { fwrite(STDERR, "SQL backup failed. Verify the SQL account permissions and server-side backup directory.\n"); exit(1); }
echo "SQL backups verified.\n";
'''


def validate_backup_configuration(state):
    """Refuse stale SQL targets before backing up or putting a site into update maintenance."""
    try:
        configuration = json.loads(compose('config', '--format', 'json'))
        current = configuration['services']['app']['environment']
        require(isinstance(current, dict), 'Invalid runtime configuration.')
    except (ValueError, KeyError, TypeError):
        raise RuntimeError('Cannot verify SQL targets before backup or update. Check application configuration.') from None
    keys = ('DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'GAME_DB_CONNECTION', 'GAME_DB_HOST', 'GAME_DB_PORT', 'GAME_DB_MUONLINE', 'GAME_SERVER_PROFILE')
    require(not current.get('DB_URL') and all(str(current.get(key, '')) == str(state['environment'][key]) for key in keys if key in state['environment']), 'SQL targets or game profile differ from the saved installation. Reconcile the runtime configuration before backup or update.')


def backup(state, credentials):
    """Create verified native SQL backups plus a private archive of site data and configuration."""
    validate_backup_configuration(state)
    directory = single_line(credentials['directory'])
    require(re.fullmatch(r'[A-Za-z]:\\[A-Za-z0-9_\\ .-]+|/[A-Za-z0-9_/. -]+', directory) and '..' not in directory, 'Use an absolute backup directory on the SQL Server host.')
    stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%S') + '-' + secrets.token_hex(4)
    destination = ROOT / 'backups' / stamp
    destination.mkdir(parents=True)
    os.chmod(destination, 0o700)
    separator = '\\' if '\\' in directory else '/'
    databases = [{'name': state['environment'][key], 'path': directory.rstrip('/\\') + separator + state['environment'][key] + '-' + stamp + '.bak'} for key in ('DB_DATABASE', 'GAME_DB_MUONLINE')]
    compose('exec', '-T', 'app', 'php', '-r', SQL_BACKUP, data=json.dumps({'username': single_line(credentials['username']), 'password': single_line(credentials['password'], 1024), 'databases': databases}))
    with tarfile.open(destination / 'site.tar.gz', 'w:gz') as archive:
        for path in (APP, STATE, COMPOSE, ROOT / 'nginx.conf', ROOT / 'certificates'):
            archive.add(path, arcname=path.relative_to(ROOT))
    atomic(destination / 'backup.json', json.dumps({'created': stamp, 'version': state['version'], 'sqlServerBackups': databases, 'note': 'SQL .bak files reside on the SQL server. Copy them off-server. Database migration rollback is manual.'}, indent=2))
    return str(destination)


def theme_hashes(directory):
    """Record shipped theme contents so updates preserve changes without freezing stock themes."""
    hashes = {}
    for relative in ('resources/views/themes', 'public/themes'):
        base = directory / relative
        if base.exists():
            for file in base.rglob('*'):
                if file.is_file() and not file.is_symlink():
                    with file.open('rb') as stream:
                        hashes[file.relative_to(directory).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return hashes


def preserve_custom_themes(staging, previous_hashes):
    """Copy new or locally modified theme files while allowing stock template fixes to update."""
    current = theme_hashes(APP)
    for relative, digest in current.items():
        if previous_hashes.get(relative) != digest:
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(APP / relative, target)


def update(request):
    """Stage a release, back up SQL/data, migrate explicitly and preserve mutable site content."""
    state = load_state()
    require(state.get('phase') == 'ready', 'Recover the incomplete installation before updating.')
    validate_backup_configuration(state)
    version = request['release']['version']
    require(tuple(map(int, version.split('.'))) > tuple(map(int, state['version'].split('.'))), 'Release is not newer than installed application.')
    require(state['environment']['GAME_SERVER_PROFILE'] in request['release']['profiles'], 'Update removes the installed game profile.')
    staging = stage_release(request)
    old = ROOT / ('previous-' + state['version'] + '-' + secrets.token_hex(4))
    migration_started = False
    backup_path = None
    save_state(dict(state, phase='updating', attemptedVersion=version))
    try:
        compose('exec', '-T', 'app', 'php', 'artisan', 'down', '--retry=60', '--no-interaction')
        compose('stop', 'queue', 'scheduler')
        backup_path = backup(state, request['backup'])
        next_theme_hashes = theme_hashes(staging)
        preserve_custom_themes(staging, state.get('themeHashes', {}))
        for relative in ('storage',):
            source = APP / relative
            if source.exists():
                shutil.copytree(source, staging / relative, dirs_exist_ok=True, symlinks=True)
        shutil.copy2(APP / '.env', staging / '.env')
        compose('stop', 'app', 'nginx')
        APP.rename(old)
        staging.rename(APP)
        initialize_storage()
        write_configuration(state, tls=state['access']['mode'] == 'domain', preserve_environment=True)
        compose('build', 'app')
        save_state(dict(state, phase='migration-recovery-required', attemptedVersion=version, backup=backup_path))
        migration_started = True
        compose('run', '--rm', '--no-deps', 'app', 'php', 'artisan', 'migrate', '--force', '--no-interaction')
        compose('run', '--rm', '--no-deps', 'app', 'php', 'artisan', 'optimize:clear', '--no-interaction')
        compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')
        compose('exec', '-T', 'app', 'php', 'artisan', 'up', '--no-interaction')
        state['version'] = version
        state['themeHashes'] = next_theme_hashes
        save_state(state)
        return 'Updated to ' + version + '. Backup: ' + backup_path
    except Exception:
        if migration_started:
            save_state(dict(state, phase='migration-recovery-required', attemptedVersion=version, backup=backup_path))
            raise RuntimeError('Update failed after migrations began. Site remains in maintenance. Do not automatically roll back SQL. Backup: ' + str(backup_path)) from None
        try:
            if old.exists():
                if APP.exists():
                    failed = ROOT / ('failed-' + secrets.token_hex(4))
                    APP.rename(failed)
                old.rename(APP)
                write_configuration(state, tls=state['access']['mode'] == 'domain', preserve_environment=True)
                compose('build', 'app')
            compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')
            compose('exec', '-T', 'app', 'php', 'artisan', 'up', '--no-interaction')
            save_state(state)
        except Exception:
            raise RuntimeError('Update failed before migrations, but runtime recovery also failed. Inspect the persisted updating phase. Backup: ' + str(backup_path)) from None
        raise RuntimeError('Update failed before migrations; original runtime restored.') from None
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def dispatch(request):
    """Expose an explicit runtime operation allow-list, with no arbitrary command endpoint."""
    action = request.get('action')
    if action == 'runtimeLogs':
        return runtime_logs()
    if action == 'developmentLogs' or (action == 'logs' and DEVELOPMENT_DIAGNOSTICS):
        return development_logs()
    if action == 'prepareWsl':
        return prepare_wsl()
    if action == 'linuxStatus':
        require(PID_ONE.read_text().strip() == 'systemd', 'WSL systemd is not running after the distribution restart.')
        return {'systemd': True}
    if action == 'prerequisites':
        require(run(['uname', '-m']).strip() == 'x86_64', 'This runtime release requires x64 WSL. ARM64 is not supported yet.')
        require('--env-from-file' in run(['docker', 'compose', 'run', '--help']), 'Upgrade Docker Compose; --env-from-file support is required.')
        return {'docker': run(['docker', 'info', '--format', '{{.ServerVersion}}']).strip(), 'compose': run(['docker', 'compose', 'version', '--short']).strip(), 'systemd': run(['systemctl', 'is-active', 'docker']).strip()}
    if action == 'install':
        return install(request)
    if action == 'status':
        if not STATE.exists():
            return {'installed': False}
        state = load_state()
        try:
            services = compose('ps', '--all', '--format', 'json')
            error = None
        except RuntimeError as exception:
            services = '[]'
            error = str(exception)
        return {'installed': True, 'version': state['version'], 'phase': state.get('phase'), 'access': state['access'], 'gameWrites': game_write_mode(), 'services': services, 'runtimeError': error}
    state = load_state()
    if action == 'setGameWrites':
        return apply_game_writes(state, request.get('gameWrites'))
    if action == 'resumeInstall':
        # Repair manager-created directory ownership from earlier interrupted installs
        # before the non-root entrypoint runs again. Preserve all existing storage data.
        initialize_storage()
        return finish_install(state, request['settings'])
    if action in ('start', 'stop', 'restart'):
        require(state.get('phase') == 'ready', 'Installation requires manual recovery. Consult the recovery guide.')
        commands = {'start': ['up', '-d', '--wait', '--wait-timeout', '300'], 'stop': ['stop'], 'restart': ['restart']}
        compose(*commands[action])
        return 'Services: ' + action
    if action == 'logs':
        # Nginx access logs can contain user data; redact environment values and known credential fields.
        output = compose('logs', '--no-color', '--tail', '150', 'app', 'queue', 'scheduler', 'nginx')
        for key, value in state['environment'].items():
            if any(marker in key for marker in ('PASSWORD', 'KEY', 'TOKEN', 'SECRET')) and value:
                output = output.replace(value, '[REDACTED]')
        output = re.sub(r'(?i)(authorization)([=: ]+)[^\r\n]+', r'\1\2[REDACTED]', output)
        return re.sub(r'(?i)(password|token|secret)([=: ]+)[^\s&,]+', r'\1\2[REDACTED]', output)
    if action == 'doctor':
        return diagnose_sql()
    if action == 'admin':
        return create_admin(request['administrator'])
    if action in ('adminList', 'adminUpdate', 'adminDelete'):
        require(state.get('phase') == 'ready', 'Recover installation first.')
        private_values = [value for key, value in state.get('environment', {}).items() if any(marker in key for marker in ('PASSWORD', 'KEY', 'TOKEN', 'SECRET')) and isinstance(value, str)]
        return manage_administrators({'adminList': 'list', 'adminUpdate': 'update', 'adminDelete': 'delete'}[action], request.get('administrator'), private_values)
    if action == 'access':
        require(state.get('phase') == 'ready', 'Recover installation first.')
        return apply_access(state, request['access'])
    if action == 'backup':
        return backup(state, request['backup'])
    if action == 'update':
        return update(request)
    raise ValueError('Unsupported runtime operation.')


def main():
    """Serialize privileged operations and return sanitized protocol messages."""
    import fcntl
    global DEVELOPMENT_DIAGNOSTICS, RECORD_DIAGNOSTICS, DIAGNOSTIC_ACTION

    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    with (ROOT / '.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            request = json.load(sys.stdin)
            DEVELOPMENT_DIAGNOSTICS = request.get('developmentDiagnostics') is True
            RECORD_DIAGNOSTICS = request.get('recordDiagnostics') is True
            DIAGNOSTIC_ACTION = request.get('action') if request.get('action') in ('install', 'resumeInstall', 'setGameWrites', 'prepareWsl', 'linuxStatus', 'prerequisites', 'status', 'logs', 'developmentLogs', 'start', 'stop', 'restart', 'update', 'backup', 'admin', 'adminList', 'adminUpdate', 'adminDelete', 'doctor', 'access') else 'unknown'
            if DEVELOPMENT_DIAGNOSTICS or RECORD_DIAGNOSTICS:
                diagnostic_secrets(request)
            response = {'ok': True, 'result': dispatch(request)}
            if (DEVELOPMENT_DIAGNOSTICS or RECORD_DIAGNOSTICS) and request.get('action') not in ('status', 'logs', 'runtimeLogs', 'developmentLogs', 'linuxStatus'):
                response['diagnostics'] = runtime_logs()
            print(json.dumps(response))
        except (ValueError, RuntimeError) as exception:
            response = {'ok': False, 'error': str(exception)}
            if DEVELOPMENT_DIAGNOSTICS or RECORD_DIAGNOSTICS:
                response['diagnostics'] = runtime_logs()
            print(json.dumps(response))
        except Exception:
            print(json.dumps({'ok': False, 'error': 'Runtime operation failed. No credentials were logged. Inspect installation state and the recovery guide.'}))


if __name__ == '__main__':
    main()
