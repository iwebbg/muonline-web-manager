"""Read-only WSL/Docker diagnostics. No shell, bootstrap, migration or stored credentials."""
import errno
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path('/opt/muonline-web')
COMPOSE = ROOT / 'compose.json'
DEADLINE = None


def command(arguments, data=None, timeout=20):
    """Capture diagnostics privately; callers see no raw stderr or credential-bearing config."""
    if DEADLINE is not None:
        remaining = DEADLINE - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Diagnostic time budget reached.')
        timeout = min(timeout, remaining)
    result = subprocess.run(arguments, input=data, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Diagnostic command unavailable.')
    return result.stdout


def json_command(arguments):
    """Read bounded JSON from a fixed process argument list."""
    return json.loads(command(arguments))


def discover_network(addresses, routes, mode='unknown'):
    """Normalize real interface prefixes and default routes; never derive a mask from a gateway."""
    measured = []
    for interface in addresses:
        for address in interface.get('addr_info', []):
            if address.get('family') != 'inet':
                continue
            try:
                network = ipaddress.ip_interface(str(address['local']) + '/' + str(address['prefixlen']))
            except (ValueError, KeyError):
                continue
            measured.append({'interface': interface['ifname'], 'address': str(network.ip), 'prefixLength': network.network.prefixlen, 'family': 'inet'})
    defaults = []
    for route in routes:
        try:
            gateway = str(ipaddress.IPv4Address(route['gateway']))
        except (ValueError, KeyError):
            continue
        if isinstance(route.get('dev'), str):
            defaults.append({'gateway': gateway, 'interface': route['dev']})
    return {'mode': mode if mode in ('nat', 'mirrored', 'virtioproxy', 'none') else 'unknown', 'addresses': measured, 'routes': defaults}


def tcp_probe(host, port):
    """Test sockets directly with a short timeout; never build /dev/tcp shell fragments."""
    try:
        remaining = 3 if DEADLINE is None else min(3, DEADLINE - time.monotonic())
        if remaining <= 0:
            return {'host': host, 'port': port, 'ok': False, 'notChecked': True, 'code': 'diagnosticTimeout'}
        with socket.create_connection((host, port), timeout=remaining):
            return {'host': host, 'port': port, 'ok': True}
    except socket.gaierror:
        return {'host': host, 'port': port, 'ok': False, 'code': 'dns'}
    except (OSError, TimeoutError):
        return {'host': host, 'port': port, 'ok': False, 'code': 'tcpFailed'}


def network_facts(host='', port=1433, windows_addresses=None):
    """Measure active WSL networking mode and probe gateway/localhost/LAN separately."""
    mode = 'unknown'
    executable = shutil.which('wslinfo') or '/usr/lib/wsl/wslinfo'
    try:
        mode = command([executable, '--networking-mode'], timeout=5).strip().lower()
    except Exception:
        pass
    facts = discover_network(json_command(['ip', '-j', '-4', 'address', 'show']), json_command(['ip', '-j', '-4', 'route', 'show', 'default']), mode)
    candidates = ['127.0.0.1'] + [route['gateway'] for route in facts['routes']]
    candidates.extend(windows_addresses or [])
    if host:
        candidates.append(host)
    facts['probes'] = [tcp_probe(candidate, port) for candidate in list(dict.fromkeys(candidates))[:10] if candidate]
    return facts


def step(identifier, status, category, reason, evidence=None):
    """Emit a stable diagnostic message key and explicitly safe evidence."""
    return {'id': identifier, 'status': status, 'category': category, 'reason': reason, 'action': reason, 'evidence': evidence or {}}


def read_environment(configuration, inspected=None):
    """Use actual container env when available, otherwise resolved Compose app env privately."""
    if inspected:
        return dict(item.split('=', 1) for item in inspected.get('Config', {}).get('Env', []) if '=' in item)
    return configuration['services']['app'].get('environment', {})


def connection(environment, identifier, database, kind, username, password, role='runtime'):
    """Construct one private PDO request from the application's own per-connection settings."""
    prefix = 'DB' if kind == 'application' else 'GAME_DB'
    host = str(environment.get(prefix + '_HOST', ''))
    port = int(environment.get(prefix + '_PORT', 1433))
    if not re.fullmatch(r'[A-Za-z0-9_.:-]+', host) or not 1 <= port <= 65535:
        raise ValueError('Invalid SQL target.')
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,127}', str(database)):
        raise ValueError('Invalid database name.')
    return {'id': identifier, 'type': kind, 'host': host, 'port': port, 'database': database, 'username': str(username or ''), 'password': str(password or ''), 'encrypt': str(environment.get(prefix + '_ENCRYPT', 'true')).lower() in ('yes', 'true', '1', 'mandatory'), 'trust': str(environment.get(prefix + '_TRUST_SERVER_CERTIFICATE', 'false')).lower() in ('yes', 'true', '1'), 'role': role}


def build_connections(environment, request):
    """Keep app/game/ranking/optional DBs and both bootstrap identities independent."""
    connections = []
    names = []
    app_database = environment.get('DB_DATABASE', '')
    game_database = environment.get('GAME_DB_MUONLINE', environment.get('GAME_DB_DATABASE', ''))
    targets = [('application', app_database, 'application', environment.get('DB_USERNAME'), environment.get('DB_PASSWORD')), ('game', game_database, 'game', environment.get('GAME_DB_USERNAME'), environment.get('GAME_DB_PASSWORD'))]
    ranking = environment.get('GAME_DB_RANKING')
    if environment.get('GAME_RANKING_CONNECTION', 'game') == 'ranking' and ranking and ranking != game_database:
        targets.append(('ranking', ranking, 'game', environment.get('GAME_DB_USERNAME'), environment.get('GAME_DB_PASSWORD')))
    battle_core = environment.get('GAME_DB_BATTLE_CORE')
    battle_enabled = str(environment.get('GAME_BATTLE_CORE_READS_ENABLED', 'false')).lower() in ('true', '1', 'yes')
    if battle_core and battle_enabled:
        targets.append(('battleCore', battle_core, 'game', environment.get('GAME_DB_USERNAME'), environment.get('GAME_DB_PASSWORD')))
    for identifier, database, kind, username, password in targets:
        if database:
            connections.append(connection(environment, identifier, database, kind, username, password))
            if kind == 'game':
                names.append(database)
    app_admin_username = request.get('adminUsername') or environment.get('APP_DB_ADMIN_USERNAME', '')
    app_admin_password = request.get('adminPassword') or environment.get('APP_DB_ADMIN_PASSWORD', '')
    game_admin_username = request.get('gameAdminUsername') or environment.get('GAME_DB_ADMIN_USERNAME') or app_admin_username
    game_admin_password = request.get('gameAdminPassword') or environment.get('GAME_DB_ADMIN_PASSWORD') or app_admin_password
    app_admin = connection(environment, 'applicationBootstrap', 'master', 'application', app_admin_username, app_admin_password, 'bootstrap')
    # Application DB may legitimately not exist before bootstrap; report its absence without creating it.
    app_admin['databases'] = [app_database] if app_database else []
    game_admin = connection(environment, 'gameBootstrap', 'master', 'game', game_admin_username, game_admin_password, 'bootstrap')
    game_admin['databases'] = list(dict.fromkeys(names))
    connections.extend([app_admin, game_admin])
    extra = []
    if environment.get('GAME_RANKING_CONNECTION', 'game') == 'ranking' and not ranking:
        extra.append(step('ranking.configuration', 'failed', 'permissions', 'additionalDatabaseRequired'))
    if battle_enabled and not battle_core:
        extra.append(step('battleCore.configuration', 'failed', 'permissions', 'additionalDatabaseRequired'))
    elif not battle_core or not battle_enabled:
        extra.append(step('battleCore.configuration', 'notChecked', 'permissions', 'optionalDatabase'))
    return connections, extra


def manual_environment(request):
    """Accept ephemeral manual connection fields before the application has been installed."""
    return {'DB_HOST': request.get('host', ''), 'DB_PORT': request.get('port', 1433), 'DB_DATABASE': request.get('applicationDatabase', ''), 'DB_USERNAME': request.get('appUsername', ''), 'DB_PASSWORD': request.get('appPassword', ''), 'DB_ENCRYPT': request.get('encrypt', True), 'DB_TRUST_SERVER_CERTIFICATE': request.get('trustCertificate', False), 'GAME_DB_HOST': request.get('host', ''), 'GAME_DB_PORT': request.get('port', 1433), 'GAME_DB_MUONLINE': request.get('gameDatabase', ''), 'GAME_DB_RANKING': request.get('rankingDatabase', ''), 'GAME_RANKING_CONNECTION': 'ranking' if request.get('rankingDatabase') else 'game', 'GAME_BATTLE_CORE_READS_ENABLED': bool(request.get('battleCoreDatabase')), 'GAME_DB_BATTLE_CORE': request.get('battleCoreDatabase', ''), 'GAME_DB_USERNAME': request.get('gameUsername', ''), 'GAME_DB_PASSWORD': request.get('gamePassword', ''), 'GAME_DB_ENCRYPT': request.get('encrypt', True), 'GAME_DB_TRUST_SERVER_CERTIFICATE': request.get('trustCertificate', False)}


def docker_context():
    """Find the actual application image and networks even if the container is restarting."""
    arguments = ['docker', 'compose', '-p', 'muonline-manager', '-f', str(COMPOSE)]
    configuration = json_command(arguments + ['config', '--format', 'json'])
    identifiers = command(arguments + ['ps', '-a', '-q', 'app']).strip().splitlines()
    inspected = json_command(['docker', 'inspect', identifiers[0]])[0] if identifiers else None
    image = inspected['Image'] if inspected else configuration['services']['app'].get('image')
    if not isinstance(image, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@-]{0,255}', image):
        raise RuntimeError('Runtime image unavailable.')
    command(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'])
    networks = list(inspected.get('NetworkSettings', {}).get('Networks', {})) if inspected else []
    if not networks:
        for name in configuration['services']['app'].get('networks', {}):
            actual = configuration.get('networks', {}).get(name, {}).get('name')
            if actual:
                networks.append(actual)
    if not networks:
        raise RuntimeError('Application network unavailable.')
    for network in networks:
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,255}', network):
            raise ValueError('Invalid Docker network.')
        command(['docker', 'network', 'inspect', network, '--format', '{{.Id}}'])
    return configuration, inspected, image, networks


def probe_command(image, network, php_source):
    """Bypass the Laravel bootstrap entrypoint and run with a read-only container filesystem."""
    return ['docker', 'run', '--rm', '-i', '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '33:33', '--pids-limit', '64', '--memory', '128m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--entrypoint', 'php', image, '-r', php_source]


DOCTOR_DRIVER = r"""
$input=json_decode(stream_get_contents(STDIN),true,64,JSON_THROW_ON_ERROR);
$environment=array_merge(getenv(),$input['environment'],['APP_DEBUG'=>'false','APP_DB_BOOTSTRAP'=>'false','APP_CONFIG_CACHE'=>'/tmp/sql-diagnostic-config.php','APP_PACKAGES_CACHE'=>'/tmp/sql-diagnostic-packages.php','APP_SERVICES_CACHE'=>'/tmp/sql-diagnostic-services.php']);
$process=proc_open(['php','artisan','game:doctor','--no-interaction'],[0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']],$pipes,'/var/www/html',$environment);
fclose($pipes[0]);
$output=stream_get_contents($pipes[1]);
fclose($pipes[1]);
stream_get_contents($pipes[2]); fclose($pipes[2]);
$code=proc_close($process);
$messages=[];
foreach(explode("\n",preg_replace('/\x1b\[[0-9;]*[a-zA-Z]/','',$output)) as $line){
 $line=trim(preg_replace('/^(INFO|ERROR|WARN)\s+/','',trim($line)));
 if(preg_match('/^(Game database (connection|diagnostics)|Required game profile schema|Missing required game (table|column|procedure):|SQL identity |Unsafe SQL (identity|permission):|Missing SQL permission:|Required adapter object permissions|Authoritative item serial procedure|Game write safety switches|Unsafe startup flags:)/',$line)){ $messages[]=substr($line,0,1024); }
}
echo json_encode(['passed'=>$code===0 && in_array('Game database diagnostics passed.',$messages,true),'messages'=>$messages]);
"""


def probe_adapter(image, network, environment):
    """Use the actual adapter doctor in a one-shot container, not a restarting app entrypoint."""
    if not (ROOT / 'application/vendor/autoload.php').is_file():
        return step('adapter.permissions', 'notChecked', 'permissions', 'doctorRequired')
    arguments = probe_command(image, network, DOCTOR_DRIVER)
    image_position = arguments.index(image)
    arguments[image_position:image_position] = ['--volume', str(ROOT / 'application') + ':/var/www/html:ro', '--workdir', '/var/www/html']
    response = json.loads(command(arguments, json.dumps({'environment': {name: str(value) for name, value in environment.items() if value is not None}}), timeout=150))
    messages = response.get('messages', [])[:200]
    return step('adapter.permissions', 'passed' if response.get('passed') else ('failed' if messages else 'notChecked'), 'permissions', 'adapterPassed' if response.get('passed') else ('adapterPermissions' if messages else 'doctorRequired'), {'messages': messages})


def run_diagnostics(request, php_source):
    """Measure WSL, then test TCP/PDO from each actual application Docker network."""
    global DEADLINE
    DEADLINE = time.monotonic() + (25 if request.get('networkOnly') else 150)
    if request.get('networkOnly'):
        return network_facts(request.get('host', ''), int(request.get('port', 1433)), request.get('windowsAddresses', []))
    # Installed settings own the endpoint; ignore stale manual form values.
    host = '' if request.get('useInstalled', True) else request.get('host', '')
    result = network_facts(host, int(request.get('port', 1433)), request.get('windowsAddresses', []))
    result['steps'] = []
    try:
        configuration, inspected, image, networks = docker_context()
    except Exception:
        result['steps'].append(step('docker.context', 'notChecked', 'docker', 'runtimeUnavailable'))
        return result
    try:
        environment = read_environment(configuration, inspected) if request.get('useInstalled', True) else manual_environment(request)
        if environment.get('DB_URL') or environment.get('DB_CONNECTION', 'sqlsrv') != 'sqlsrv' or environment.get('GAME_DB_CONNECTION', 'sqlsrv') != 'sqlsrv':
            result['steps'].append(step('configuration.override', 'notChecked', 'permissions', 'connectionOverride'))
            return result
        connections, extra = build_connections(environment, request)
        result['steps'].extend(extra)
        actual_host = environment.get('GAME_DB_HOST', '')
        actual_port = int(environment.get('GAME_DB_PORT', 1433))
        result['steps'].append(step('docker.context', 'passed', 'docker', 'runtimeFound', {'networks': networks, 'containerState': inspected.get('State', {}).get('Status') if inspected else 'notCreated', 'source': 'container' if inspected else 'compose', 'profile': environment.get('GAME_SERVER_PROFILE')}))
        result['target'] = {'host': actual_host, 'port': actual_port}
        result['loginNames'] = list(dict.fromkeys(item['username'] for item in connections if item['username']))[:4]
        result['steps'].append(step('docker.targets', 'passed', 'network', 'configuredTargets', {'connections': [{'id': item['id'], 'host': item['host'], 'port': item['port'], 'database': item['database'], 'username': item['username'], 'encrypt': item['encrypt'], 'trustServerCertificate': item['trust']} for item in connections]}))
        if actual_host and not any(probe['host'] == actual_host and probe['port'] == actual_port for probe in result['probes']):
            result['probes'].append(tcp_probe(actual_host, actual_port))
        game_connected = False
        for network in networks[:4]:
            source = php_source.replace('<?php', '', 1)
            # The entrypoint guard is replaced with a fixed stdin driver, not user-generated PHP.
            guard = source.index("if (realpath($_SERVER['SCRIPT_FILENAME']")
            source = source[:guard] + "try { $input=json_decode(stream_get_contents(STDIN),true,64,JSON_THROW_ON_ERROR); echo json_encode(diagnose($input),JSON_THROW_ON_ERROR); } catch (Throwable) { echo json_encode(['steps'=>[diagnosticStep('docker.probe','failed','docker','probeUnavailable')]]); }"
            raw = command(probe_command(image, network, source), json.dumps({'connections': connections}), timeout=120)
            response = json.loads(raw)
            game_connected = game_connected or any(item.get('id') == 'game.sql' and item.get('status') == 'passed' for item in response.get('steps', []))
            for item in response.get('steps', []):
                item['id'] = 'docker.' + network + '.' + item['id']
                result['steps'].append(item)
        if request.get('useInstalled', True) and game_connected:
            result['steps'].append(probe_adapter(image, networks[0], environment))
        else:
            result['steps'].append(step('adapter.permissions', 'notChecked', 'permissions', 'doctorRequired'))
    except Exception:
        result['steps'].append(step('docker.probe', 'notChecked', 'docker', 'probeUnavailable'))
    return result


def main():
    """Read trusted probe code plus private diagnostic inputs; never print exceptions."""
    try:
        payload = json.load(sys.stdin)
        print(json.dumps({'ok': True, 'result': run_diagnostics(payload['request'], payload['probe'])}))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'SQL troubleshooting could not inspect WSL. No credentials were logged.'}))


if __name__ == '__main__':
    main()
