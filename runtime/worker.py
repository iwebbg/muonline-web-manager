"""Privileged WSL runtime. Only fixed operations are accepted; input is JSON on stdin."""
import base64
import contextlib
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
import zipfile

ROOT = Path('/opt/muonline-web')
APP = ROOT / 'application'
STATE = ROOT / 'state.json'
COMPOSE = ROOT / 'compose.json'


def require(condition, message):
    """Reject invalid input before executing a privileged operation."""
    if not condition:
        raise ValueError(message)


def run(arguments, *, data=None, timeout=1800):
    """Execute argument arrays without a shell and suppress potentially secret diagnostics."""
    result = subprocess.run(arguments, input=data, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Runtime command failed: ' + arguments[0] + ' (exit ' + str(result.returncode) + '). Check runtime diagnostics; output is withheld to protect credentials.')
    return result.stdout[-200000:]


def compose(*arguments, data=None):
    """Operate only on the manager-owned Compose project."""
    return run(['docker', 'compose', '--project-name', 'muonline-manager', '--file', str(COMPOSE), *arguments], data=data)


def atomic(path, content):
    """Replace a private configuration file without an incomplete write window."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
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
    services['nginx'] = {'image': 'nginx:1.29-alpine', 'restart': 'unless-stopped', 'ports': [binding + '80:80'] + ([binding + '443:443'] if access['mode'] == 'domain' else []), 'volumes': [mount + ':ro', str(ROOT / 'nginx.conf') + ':/etc/nginx/conf.d/default.conf:ro', str(ROOT / 'acme') + ':/var/www/certbot:ro', str(ROOT / 'certificates') + ':/etc/letsencrypt:ro'], 'depends_on': {'app': {'condition': 'service_healthy'}}, 'healthcheck': {'test': ['CMD-SHELL', 'wget -q --spider http://127.0.0.1/health'], 'interval': '10s', 'timeout': '5s', 'retries': 15}}
    if access['mode'] == 'domain':
        services['nginx']['healthcheck']['test'] = ['CMD-SHELL', 'wget -q --spider --no-check-certificate https://127.0.0.1/health']
    services['redis'] = {'image': 'redis:8-alpine', 'restart': 'unless-stopped', 'command': ['redis-server', '--appendonly', 'yes'], 'volumes': ['redis-data:/data'], 'healthcheck': {'test': ['CMD', 'redis-cli', 'ping'], 'interval': '5s', 'timeout': '3s', 'retries': 20}}
    services['certbot'] = {'image': 'certbot/certbot:v4.0.0', 'profiles': ['tools'], 'volumes': [str(ROOT / 'acme') + ':/var/www/certbot', str(ROOT / 'certificates') + ':/etc/letsencrypt']}
    return {'services': services, 'volumes': {'redis-data': {}}}


def write_configuration(state, tls=False):
    """Write the site environment, reverse proxy and Docker project together."""
    access = state['access']
    environment = dict(state['environment'])
    environment.update(APP_URL=access['url'], SESSION_SECURE_COOKIE=str(access['mode'] == 'domain').lower(), SESSION_DOMAIN='null', SESSION_HTTP_ONLY='true', SESSION_SAME_SITE='lax')
    atomic(APP / '.env', env_text(environment))
    os.chown(APP / '.env', 33, 33)
    atomic(ROOT / 'nginx.conf', nginx_config(access, tls))
    os.chmod(ROOT / 'nginx.conf', 0o644)
    atomic(COMPOSE, json.dumps(compose_config(access), indent=2))


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
            require(path.parts[0] not in ('.env', '.git', 'node_modules', 'storage'), 'Archive contains protected runtime data.')
            if kind == 'vendor':
                require(path.parts[0] == 'vendor', 'Vendor archive must contain vendor/ only.')
            else:
                require(path.parts[0] != 'vendor', 'Application archive cannot contain vendor/.')
            total += member.file_size
            require(total <= 4 * 1024**3, 'Archive exceeds extraction size limit.')
        bundle.extractall(destination)


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
    for relative in ('storage/app/public', 'storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views', 'storage/logs', 'bootstrap/cache'):
        directory = APP / relative
        directory.mkdir(parents=True, exist_ok=True)
        run(['chown', '-R', '33:33', str(directory)])
    link = APP / 'public/storage'
    if not link.exists() and not link.is_symlink():
        link.symlink_to('../storage/app/public')


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
    environment.update(APP_NAME='MuOnline Web', APP_ENV=values['appEnv'], APP_DEBUG='false', APP_KEY='base64:' + base64.b64encode(secrets.token_bytes(32)).decode(), DB_CONNECTION='sqlsrv', DB_HOST=host, DB_PORT=str(port), DB_DATABASE=web, DB_USERNAME=app_login, DB_PASSWORD=password(), DB_ENCRYPT='true', DB_TRUST_SERVER_CERTIFICATE=str(values.get('trustCertificate') is True).lower(), GAME_DB_CONNECTION='sqlsrv', GAME_DB_HOST=host, GAME_DB_PORT=str(port), GAME_DB_MUONLINE=game, GAME_DB_RANKING=game, GAME_DB_USERNAME=game_login, GAME_DB_PASSWORD=password(), GAME_DB_ENCRYPT='true', GAME_DB_TRUST_SERVER_CERTIFICATE=str(values.get('trustCertificate') is True).lower(), GAME_DATA_SOURCE='database', GAME_SERVER_PROFILE=values['profile'], GAME_EVENT_PROFILE=values['profile'], GAME_ACCOUNT_PASSWORD_SCHEME='darksteam_md5' if values['profile'] == 'darksteam_1_0m' else 'plaintext', GAME_DB_READONLY='true', GAME_WRITES_ENABLED='false', GAME_RANKING_CONNECTION='game', GAME_BATTLE_CORE_READS_ENABLED='false', REDIS_HOST='redis', CACHE_STORE='redis', SESSION_DRIVER='redis', QUEUE_CONNECTION='redis', APP_DB_BOOTSTRAP='false', AUTO_MIGRATE='false')
    sql_secret = single_line(values['sqlPassword'], 1024)
    staging = stage_release(request)
    staging.rename(APP)
    initialize_storage()
    for directory in ('acme', 'certificates', 'backups'):
        (ROOT / directory).mkdir(exist_ok=True)
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
    if state['phase'] == 'runtime-bootstrapped':
        create_admin(credentials['administrator'])
        state['phase'] = 'administrator-created'
        save_state(state)
    apply_access(state, state['access'], initial=True)
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
    atomic('/etc/systemd/system/muonline-certificates.timer', '[Unit]\nDescription=MuOnline certificate renewal schedule\n[Timer]\nOnCalendar=*-*-* 03,15:00:00\nRandomizedDelaySec=3600\nPersistent=true\n[Install]\nWantedBy=timers.target\n')
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
    try:
        write_configuration(state)
        compose('up', '-d', '--force-recreate', 'app', 'queue', 'scheduler', 'nginx')
        if access['mode'] == 'domain':
            issue_certificate(access)
            write_configuration(state, tls=True)
            compose('up', '-d', '--force-recreate', 'nginx')
            compose('exec', '-T', 'nginx', 'nginx', '-t')
            renewal_timer(True)
        elif Path('/etc/systemd/system/muonline-certificates.timer').exists():
            renewal_timer(False)
        compose('exec', '-T', 'app', 'php', 'artisan', 'config:clear', '--no-interaction')
        compose('up', '-d', '--wait', '--wait-timeout', '300')
        compose('exec', '-T', 'nginx', 'nginx', '-t')
        save_state(state)
    except Exception:
        state.clear()
        state.update(previous)
        if initial:
            write_configuration(previous, tls=False)
            save_state(previous)
            raise RuntimeError('Initial access setup failed. Installation state was preserved; use Resume installation after correcting DNS/firewall. Backup: ' + str(backup)) from None
        write_configuration(previous, tls=previous['access']['mode'] == 'domain')
        try:
            compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')
            compose('exec', '-T', 'app', 'php', 'artisan', 'config:clear', '--no-interaction')
            if previous['access']['mode'] == 'domain' and not initial:
                renewal_timer(True)
        except Exception:
            raise RuntimeError('Access change and recovery failed. Restore the private configuration backup: ' + str(backup)) from None
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


def backup(state, credentials):
    """Create verified native SQL backups plus a private archive of site data and configuration."""
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


def update(request):
    """Stage a release, back up SQL/data, migrate explicitly and preserve mutable site content."""
    state = load_state()
    require(state.get('phase') == 'ready', 'Recover the incomplete installation before updating.')
    version = request['release']['version']
    require(tuple(map(int, version.split('.'))) > tuple(map(int, state['version'].split('.'))), 'Release is not newer than installed application.')
    require(state['environment']['GAME_SERVER_PROFILE'] in request['release']['profiles'], 'Update removes the installed game profile.')
    staging = stage_release(request)
    old = ROOT / ('previous-' + state['version'] + '-' + secrets.token_hex(4))
    migration_started = False
    switched = False
    backup_path = None
    try:
        compose('exec', '-T', 'app', 'php', 'artisan', 'down', '--retry=60', '--no-interaction')
        compose('stop', 'queue', 'scheduler')
        backup_path = backup(state, request['backup'])
        for relative in ('storage', 'resources/views/themes', 'public/themes'):
            source = APP / relative
            if source.exists():
                shutil.copytree(source, staging / relative, dirs_exist_ok=True, symlinks=True)
        shutil.copy2(APP / '.env', staging / '.env')
        compose('stop', 'app', 'nginx')
        APP.rename(old)
        staging.rename(APP)
        switched = True
        initialize_storage()
        write_configuration(state, tls=state['access']['mode'] == 'domain')
        compose('build', 'app')
        migration_started = True
        compose('run', '--rm', '--no-deps', 'app', 'php', 'artisan', 'migrate', '--force', '--no-interaction')
        compose('run', '--rm', '--no-deps', 'app', 'php', 'artisan', 'optimize:clear', '--no-interaction')
        compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')
        compose('exec', '-T', 'app', 'php', 'artisan', 'up', '--no-interaction')
        state['version'] = version
        save_state(state)
        return 'Updated to ' + version + '. Backup: ' + backup_path
    except Exception:
        if migration_started:
            save_state(dict(state, phase='migration-recovery-required', attemptedVersion=version, backup=backup_path))
            raise RuntimeError('Update failed after migrations began. Site remains in maintenance. Do not automatically roll back SQL. Backup: ' + str(backup_path)) from None
        if switched:
            failed = ROOT / ('failed-' + secrets.token_hex(4))
            APP.rename(failed)
            old.rename(APP)
        compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '300')
        compose('exec', '-T', 'app', 'php', 'artisan', 'up', '--no-interaction')
        raise RuntimeError('Update failed before migrations; original runtime restored.') from None
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def dispatch(request):
    """Expose an explicit runtime operation allow-list, with no arbitrary command endpoint."""
    action = request.get('action')
    if action == 'prerequisites':
        return {'docker': run(['docker', 'info', '--format', '{{.ServerVersion}}']).strip(), 'compose': run(['docker', 'compose', 'version', '--short']).strip(), 'systemd': run(['systemctl', 'is-active', 'docker']).strip()}
    if action == 'install':
        return install(request)
    if action == 'status':
        if not STATE.exists():
            return {'installed': False}
        state = load_state()
        return {'installed': True, 'version': state['version'], 'phase': state.get('phase'), 'access': state['access'], 'services': compose('ps', '--all', '--format', 'json')}
    state = load_state()
    if action == 'resumeInstall':
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
        return re.sub(r'(?i)(password|token|secret|authorization)([=: ]+)[^\s&,]+', r'\1\2[REDACTED]', output)
    if action == 'doctor':
        compose('exec', '-T', 'app', 'php', 'artisan', 'game:doctor', '--no-interaction')
        return 'game:doctor passed.'
    if action == 'admin':
        return create_admin(request['administrator'])
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

    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    with (ROOT / '.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            request = json.load(sys.stdin)
            print(json.dumps({'ok': True, 'result': dispatch(request)}))
        except (ValueError, RuntimeError) as exception:
            print(json.dumps({'ok': False, 'error': str(exception)}))
        except Exception:
            print(json.dumps({'ok': False, 'error': 'Runtime operation failed. No credentials were logged. Inspect installation state and the recovery guide.'}))


if __name__ == '__main__':
    main()
