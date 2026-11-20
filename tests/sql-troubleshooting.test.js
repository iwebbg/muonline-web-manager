import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifySqlError, ipv4Network, canonicalFirewallAddress, firewallAddressMatches, firewallScope, validateSqlInput, redactDiagnostic, buildSqlReport } from '../src/shared/sql-diagnostics.js';
import { SqlTroubleshooter, windowsTcpProbe } from '../src/main/sql-troubleshooting.js';
import { catalogs } from '../src/shared/i18n.js';

const resources = fileURLToPath(new URL('..', import.meta.url));
const instance = { name: 'SQLEXPRESS', id: 'MSSQL15.SQLEXPRESS', service: 'MSSQL$SQLEXPRESS', view: 'Registry64', state: 'Running', pid: 42, version: '15.0.1', loginMode: 2, tcp: { enabled: true, listenAll: true, sections: [{ name: 'IPAll', dynamicPort: '', port: '1433' }] } };
const windows = { instances: [instance], addresses: [{ address: '172.30.176.1', prefixLength: 20, virtual: true }, { address: '192.168.1.7', prefixLength: 24, virtual: false }], listeners: [{ address: '0.0.0.0', port: 1433, pid: 42 }], firewallRules: [] };
const wsl = { mode: 'nat', addresses: [{ interface: 'eth0', address: '172.30.182.9', prefixLength: 20, family: 'inet' }], routes: [{ gateway: '172.30.176.1', interface: 'eth0' }] };

/** Supply measured facts while prohibiting real processes/network traffic. */
function coordinator() {
  const calls = [];
  const sql = new SqlTroubleshooter(resources, '/tmp/unused-sql-plans', async (...args) => { calls.push(args); throw new Error('No process allowed in this test'); });
  sql.windows = async () => structuredClone(windows);
  sql.wsl = async () => structuredClone(wsl);
  return { sql, calls };
}

test('classifies network, trust, legacy crypto, authentication and permissions independently', () => {
  const samples = [
    ['EE certificate key too weak', 'tls', 'legacyTls'],
    ['legacy sigalg disallowed or unsupported', 'tls', 'legacyTls'],
    ['certificate verify failed: self-signed certificate', 'tls', 'certificate'],
    ['pre-login handshake failed', 'tls', 'tlsHandshake'],
    ['SQLSTATE 28000: Error 18456 Login failed', 'authentication', 'loginRejected'],
    ['Cannot open database requested by the login. Login failed for user.', 'permissions', 'databaseAccess'],
    ['getaddrinfo failed', 'network', 'dns'],
    ['TCP Provider: Connection refused', 'network', 'tcpFailed']
  ];
  for (const [message, category, reason] of samples) {
    assert.deepEqual(classifySqlError(message), { category, reason });
    assert.ok(!JSON.stringify(classifySqlError(message)).includes(message));
  }
  assert.equal(classifySqlError({ nativeCode: 18456, message: 'Authentication rejected' }).reason, 'loginRejected');
  assert.equal(classifySqlError({ nativeCode: 229, message: 'SQL refused the statement' }).category, 'permissions');
  assert.equal(classifySqlError('unrecognized error').reason, 'unclassified');
});

test('uses the measured prefix length and rejects guessed, stale, public and mirrored firewall scopes', () => {
  assert.equal(ipv4Network('172.30.182.9', 20), '172.30.176.0/20');
  const scope = firewallScope(windows, wsl, 1433);
  assert.equal(scope.localAddress, '172.30.176.1');
  assert.equal(scope.remoteAddress, '172.30.176.0/20');
  for (const bad of [{ ...wsl, mode: 'mirrored' }, { ...wsl, addresses: [] }, { ...wsl, addresses: [{ ...wsl.addresses[0], prefixLength: 24 }] }, { ...wsl, routes: [{ gateway: '172.30.192.1', interface: 'eth0' }] }]) {
    assert.throws(() => firewallScope(windows, bad, 1433));
  }
  assert.throws(() => ipv4Network('172.30.176.1', undefined));
  assert.throws(() => ipv4Network('127.000.000.001', 24));
  const wideWindows = { addresses: [{ address: '192.168.0.1', prefixLength: 15, virtual: true }] };
  const wideWsl = { mode: 'nat', routes: [{ gateway: '192.168.0.1', interface: 'eth0' }], addresses: [{ interface: 'eth0', address: '192.168.1.2', prefixLength: 15, family: 'inet' }] };
  assert.throws(() => firewallScope(wideWindows, wideWsl, 1433));
});

test('validates DSN/command targets while keeping passwords as uninterpreted stdin data', () => {
  for (const input of [{ host: 'server;Encrypt=no' }, { host: '$(whoami)' }, { instance: 'SQLEXPRESS;Restart-Service X' }, { gameDatabase: 'Game];DROP DATABASE x' }, { port: 70000 }]) {
    assert.throws(() => validateSqlInput(input));
  }
  const secret = "A'; $(touch /tmp/no) `whoami` Ss@";
  assert.equal(validateSqlInput({ appPassword: secret }).appPassword, secret);
});

test('TCP socket probes distinguish DNS failure and never execute shell commands', async () => {
  let socket;
  const factory = options => {
    assert.deepEqual(options, { host: 'sql.example', port: 1444 });
    socket = new EventEmitter();
    socket.setTimeout = milliseconds => assert.equal(milliseconds, 3000);
    socket.destroy = () => {};
    return socket;
  };
  const result = windowsTcpProbe('sql.example', 1444, factory);
  socket.emit('error', { code: 'ENOTFOUND', message: 'secret DSN' });
  assert.deepEqual(await result, { host: 'sql.example', port: 1444, ok: false, code: 'dns' });
});

test('reports no listener, foreign PID, dynamic port and Windows-vs-WSL routing as separate evidence', () => {
  const target = validateSqlInput({ instance: 'SQLEXPRESS', port: 1433 });
  const facts = structuredClone(windows);
  facts.instances[0].tcp.sections[0].dynamicPort = '55477';
  facts.listeners = [{ address: '0.0.0.0', port: 1433, pid: 999 }];
  facts.probes = [{ host: '172.30.176.1', port: 1433, ok: true }];
  const network = { ...wsl, probes: [{ host: '172.30.176.1', port: 1433, ok: false }] };
  const report = buildSqlReport(facts, network, target);
  assert.equal(report.steps.find(step => step.id === 'windows.listener').reason, 'portOccupied');
  assert.equal(report.steps.find(step => step.id === 'windows.tcpConfiguration').reason, 'dynamicPort');
  assert.equal(report.steps.find(step => step.id === 'windows.firewall').reason, 'firewallRouting');
  facts.listeners = [];
  assert.equal(buildSqlReport(facts, network, target).steps.find(step => step.id === 'windows.listener').reason, 'noListener');
  for (const step of report.steps) {
    for (const language of ['bg', 'en']) {
      assert.ok(catalogs[language]['sql.reason.' + step.reason]);
      assert.ok(catalogs[language]['sql.action.' + step.action]);
    }
  }
});

test('does not claim a disabled login is a wrong password or configured Mixed Mode is effective', () => {
  const facts = structuredClone(windows);
  facts.localSqlMetadata = { windowsOnly: 1, logins: [{ name: 'sa', found: true, enabled: false, explicitConnect: 'GRANT', metadataVisible: true }] };
  const report = buildSqlReport(facts, wsl, validateSqlInput({ instance: 'SQLEXPRESS' }));
  assert.equal(report.steps.find(step => step.id === 'windows.authentication').reason, 'restartRequired');
  assert.equal(report.steps.find(step => step.id === 'windows.login.sa').reason, 'loginDisabled');
});

test('redacts nested credentials, known secrets, connection strings and private keys', () => {
  const safe = redactDiagnostic({ password: 'a', nested: { connectionString: 'Server=x;PWD=secret', message: 'Known sensitive-secret; Password="another secret";' }, evidence: '-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----' }, ['sensitive-secret']);
  assert.equal(safe.password, undefined);
  assert.equal(safe.nested.connectionString, undefined);
  assert.ok(!JSON.stringify(safe).includes('sensitive-secret'));
  assert.ok(!JSON.stringify(safe).includes('another secret'));
  assert.ok(!JSON.stringify(safe).includes('material'));
});

test('previews do not execute changes; firewall commands are narrow and stable across WSL leases', async () => {
  const { sql, calls } = coordinator();
  const first = await sql.plan({ instance: 'SQLEXPRESS', change: 'firewall', port: 1433, adminPassword: 'NEVER-IN-PLAN' });
  sql.wsl = async () => ({ ...wsl, addresses: [{ ...wsl.addresses[0], address: '172.30.180.3' }] });
  const second = await sql.plan({ instance: 'SQLEXPRESS', change: 'firewall', port: 1433 });
  assert.equal(first.command, second.command);
  assert.match(first.command, /-LocalAddress '172.30.176.1'/);
  assert.match(first.command, /-RemoteAddress '172.30.176.0\/20'/);
  assert.ok(!first.command.includes('\n'));
  assert.ok(!JSON.stringify([...sql.plans.values()]).includes('NEVER-IN-PLAN'));
  assert.equal(calls.length, 0);
});

test('Mixed Mode/TCP/restart target the exact discovered instance and reject occupied ports', async () => {
  const { sql, calls } = coordinator();
  const mixed = await sql.plan({ instance: 'SQLEXPRESS', change: 'mixedMode' });
  assert.match(mixed.command, /MSSQL15\.SQLEXPRESS/);
  assert.equal(mixed.restartRequired, true);
  const restart = await sql.plan({ instance: 'SQLEXPRESS', change: 'restart' });
  assert.equal(restart.command, "Restart-Service -Name 'MSSQL$SQLEXPRESS'");
  assert.equal(restart.disconnectsSessions, true);
  const tcp = await sql.plan({ instance: 'SQLEXPRESS', change: 'tcpPort' });
  assert.match(tcp.command, /TcpDynamicPorts -Value ''/);
  assert.ok(!tcp.command.includes("TcpDynamicPorts -Value '0'"));
  sql.windows = async () => ({ ...windows, listeners: [{ port: 1433, pid: 999 }] });
  await assert.rejects(sql.plan({ instance: 'SQLEXPRESS', change: 'tcpPort' }), /another process/);
  assert.equal(calls.length, 0);
});

test('expired, unconfirmed and stale-network plans never reach elevation', async () => {
  const { sql, calls } = coordinator();
  const plan = await sql.plan({ instance: 'SQLEXPRESS', change: 'firewall' });
  await assert.rejects(sql.apply({ planId: plan.id, confirmed: false }), /explicit confirmation/);
  sql.plans.get(plan.id).public.expiresAt = 0;
  await assert.rejects(sql.apply({ planId: plan.id, confirmed: true }), /current preview/);
  const fresh = await sql.plan({ instance: 'SQLEXPRESS', change: 'firewall' });
  sql.wsl = async () => ({ ...wsl, addresses: [{ ...wsl.addresses[0], address: '172.30.181.7' }] });
  await assert.rejects(sql.apply({ planId: fresh.id, confirmed: true }), /changed/);
  assert.equal(calls.length, 0);
});

test('Windows query source stays trusted and user data never enters process arguments', async () => {
  const name = "sa'; Invoke-Expression 'bad'";
  const sql = new SqlTroubleshooter(resources, '/unused', async (file, args, input) => {
    assert.equal(file, 'powershell.exe');
    assert.ok(!args.join(' ').includes(name));
    const launcher = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(launcher.length < 1000);
    assert.ok(!launcher.includes(name));
    const payload = JSON.parse(input);
    assert.equal(payload.request.operation, 'inventory');
    assert.deepEqual(payload.request.loginNames, [name]);
    assert.ok(!payload.script.includes(name));
    return JSON.stringify({ ok: true, result: windows });
  });
  await sql.windows('SQLEXPRESS', [name]);
});

test('confirmed apply elevates only a fresh public plan and cleans private staging paths with spaces', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'Mu SQL Кирилица '));
  try {
    let elevated = 0;
    const sql = new SqlTroubleshooter(resources, directory, async (file, args, input) => {
      elevated++;
      assert.equal(file, 'powershell.exe');
      const launcher = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.ok(launcher.includes('-Verb RunAs'));
      assert.ok(launcher.includes(`('"'+$p.script+'"')`));
      assert.ok(!launcher.includes('\\"'));
      const paths = JSON.parse(input);
      const request = JSON.parse(await readFile(paths.request, 'utf8'));
      assert.equal(request.action, 'mixedMode');
      assert.equal(request.instance, 'SQLEXPRESS');
      assert.equal(request.confirmed, true);
      assert.ok(!JSON.stringify(request).includes('TEMP-SECRET'));
      assert.ok(!args.join(' ').includes(directory));
      await writeFile(paths.result, JSON.stringify({ ok: true, changed: true, code: 'restartRequired' }));
      return '';
    });
    sql.windows = async () => structuredClone(windows);
    const plan = await sql.plan({ instance: 'SQLEXPRESS', change: 'mixedMode', adminPassword: 'TEMP-SECRET' });
    assert.deepEqual(await sql.apply({ planId: plan.id, confirmed: true }), { applied: true, changed: true, reason: 'restartRequired' });
    assert.equal(elevated, 1);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(sql.apply({ planId: plan.id, confirmed: true }), /current preview/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an equivalent existing manual firewall rule is inspected without proposing a duplicate', async () => {
  const { sql, calls } = coordinator();
  sql.windows = async () => ({ ...windows, firewallRules: [{ managed: false, name: 'manual-rule', enabled: true, localAddress: '172.30.176.1', remoteAddress: '172.30.176.0/20', port: '1433', direction: 'Inbound', action: 'Allow', profile: 'Any', program: 'Any', service: 'Any' }] });
  await assert.rejects(sql.plan({ instance: 'SQLEXPRESS', change: 'firewall' }), /already exists/);
  assert.equal(calls.length, 0);
});

test('a failed localhost probe in NAT is not mislabeled as a firewall failure for a working gateway', () => {
  const facts = { ...windows, probes: [{ host: '172.30.176.1', port: 1433, ok: true }] };
  const network = { ...wsl, probes: [{ host: '127.0.0.1', port: 1433, ok: false }, { host: '172.30.176.1', port: 1433, ok: true }] };
  const report = buildSqlReport(facts, network, validateSqlInput({ instance: 'SQLEXPRESS', host: '172.30.176.1' }));
  assert.equal(report.steps.find(step => step.id === 'windows.firewall').reason, 'firewallInspected');
});

test('SQL host suggestion requires measured gateway, reachable TCP and a matching Windows SQL PID', async () => {
  const { sql } = coordinator();
  sql.wsl = async (input, addresses, networkOnly) => {
    assert.equal(networkOnly, true);
    assert.deepEqual(Object.keys(input).sort(), ['host', 'port']);
    return { ...structuredClone(wsl), probes: [{ host: '172.30.176.1', port: 1433, ok: true }] };
  };
  assert.deepEqual(await sql.suggest(1433, '127.0.0.1'), { suggestion: { host: '172.30.176.1', port: 1433, instance: 'SQLEXPRESS' } });
  assert.deepEqual(await sql.suggest(1433, 'remote-sql.example'), { suggestion: null });
  sql.windows = async () => ({ ...structuredClone(windows), listeners: [{ address: '0.0.0.0', port: 1433, pid: 99 }] });
  assert.deepEqual(await sql.suggest(), { suggestion: null });
  sql.windows = async () => structuredClone(windows);
  sql.wsl = async () => ({ ...structuredClone(wsl), probes: [{ host: '172.30.176.1', port: 1433, ok: false }] });
  assert.deepEqual(await sql.suggest(), { suggestion: null });
});

test('Install resolves loopback and owned Windows addresses, prepares a private rule, then requires WSL TCP', async () => {
  for (const host of ['127.0.0.1', '127.0.01', 'localhost', '::1', '192.168.1.7', '172.30.176.1']) {
    const { sql } = coordinator();
    const requests = [];
    sql.elevatedChange = async request => { requests.push(request); return { ok: true }; };
    sql.wsl = async (input, addresses, networkOnly) => {
      assert.equal(networkOnly, true);
      assert.deepEqual(addresses, []);
      assert.deepEqual(Object.keys(input).sort(), ['host', 'port']);
      return { ...structuredClone(wsl), probes: [{ host: '172.30.176.1', port: 1433, ok: requests.length > 0 }] };
    };
    // A non-admin cannot inspect rules; the privileged helper must inspect/deduplicate them.
    sql.windows = async () => ({ ...structuredClone(windows), firewallError: 'firewallUnavailable' });
    const resolved = await sql.prepareInstallation(host, 1433);
    assert.equal(resolved.host, '172.30.176.1');
    assert.equal(resolved.instanceId, instance.id);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].installation, true);
    assert.deepEqual(requests[0].scope, firewallScope(windows, wsl, 1433));
    assert.match(requests[0].ruleName, /^MuOnlineSql-[a-f0-9]{16}$/);
    assert.equal(requests[0].expected.pid, 42);
  }
});

test('external/cloud/private remote SQL remains unchanged without a firewall mutation or WSL discovery', async () => {
  const { sql } = coordinator();
  sql.wsl = async () => { throw new Error('Remote SQL must not use local discovery'); };
  sql.elevatedChange = async () => { throw new Error('Remote SQL must not change local firewall'); };
  for (const host of ['sql.example.net', '203.0.113.5', '192.168.1.99', '10.5.2.10']) {
    assert.deepEqual(await sql.prepareInstallation(host, 1444), { host, port: 1444, local: false });
  }
  sql.windows = async () => { throw new Error('Local inventory unavailable'); };
  assert.deepEqual(await sql.prepareInstallation('sql.example.net', 1444), { host: 'sql.example.net', port: 1444, local: false });
});

test('local preparation rejects unknown/mirrored scopes, listener conflicts, changed binding and failed UAC/TCP', async () => {
  for (const scenario of ['mirrored', 'prefix', 'listener', 'binding', 'uac', 'tcp', 'changed-listener']) {
    const { sql } = coordinator();
    let changes = 0;
    sql.windows = async () => scenario === 'listener' || (scenario === 'changed-listener' && changes > 0) ? { ...windows, listeners: [{ ...windows.listeners[0], pid: 77 }] } : structuredClone(windows);
    sql.wsl = async () => ({ ...structuredClone(wsl), ...(scenario === 'mirrored' ? { mode: 'mirrored' } : {}), ...(scenario === 'prefix' ? { addresses: [] } : {}), probes: scenario === 'changed-listener' ? [{ host: '172.30.176.1', port: 1433, ok: true }] : [] });
    sql.elevatedChange = async () => { changes++; return { ok: scenario !== 'uac' }; };
    await assert.rejects(sql.prepareInstallation('127.0.0.1', 1433, scenario === 'binding' ? 'MSSQL15.Other' : null));
    assert.equal(changes, ['uac', 'tcp', 'changed-listener'].includes(scenario) ? 1 : 0);
  }
});

test('a saved local instance binding allows rediscovering its changed gateway but never a different instance', async () => {
  const { sql } = coordinator();
  sql.elevatedChange = async () => ({ ok: true });
  sql.wsl = async () => ({ ...structuredClone(wsl), probes: [{ host: '172.30.176.1', port: 1433, ok: true }] });
  assert.equal((await sql.prepareInstallation('172.20.48.1', 1433, instance.id)).host, '172.30.176.1');
  await assert.rejects(sql.prepareInstallation('172.20.48.1', 1433, 'MSSQL15.Other'));
});


test('firewall equality compares exact IPv4 address sets across CIDR and dotted mask notation', () => {
  assert.equal(canonicalFirewallAddress('172.30.176.0/255.255.240.0'), '172.30.176.0/20');
  assert.equal(firewallAddressMatches('172.30.176.1/255.255.255.255', '172.30.176.1'), true);
  assert.equal(firewallAddressMatches('172.30.177.4/20', '172.30.176.0/255.255.240.0'), true);
  for (const value of ['Any', '0.0.0.0/0', '172.30.160.0/19', '172.30.176.0/255.0.255.0', '172.30.176.1,172.30.176.2', '172.30.176.0-172.30.191.255']) {
    assert.equal(firewallAddressMatches(value, '172.30.176.0/20'), false);
  }
  const { sql } = coordinator();
  sql.windows = async () => ({ ...windows, firewallRules: [{ managed: false, name: 'manual', enabled: true, localAddress: '172.30.176.1/32', remoteAddress: '172.30.176.0/255.255.240.0', port: '1433', direction: 'Inbound', action: 'Allow', profile: 'Any', program: 'Any', service: 'Any' }] });
  return assert.rejects(sql.plan({ instance: 'SQLEXPRESS', change: 'firewall' }), /already exists/);
});

test('Resume reuses a reachable bound local instance without requiring another firewall mutation', async () => {
  const { sql } = coordinator();
  sql.windows = async () => ({ ...structuredClone(windows), firewallError: 'firewallUnavailable' });
  sql.wsl = async () => ({ ...structuredClone(wsl), probes: [{ host: '172.30.176.1', port: 1433, ok: true }] });
  sql.elevatedChange = async () => assert.fail('Do not reapply firewall for an already reachable bound SQL instance');
  const endpoint = await sql.prepareInstallation('172.30.176.1', 1433, instance.id);
  assert.equal(endpoint.host, '172.30.176.1');
  assert.equal(endpoint.instanceId, instance.id);
  let mutations = 0;
  sql.elevatedChange = async () => { mutations++; return { ok: true }; };
  await sql.prepareInstallation('172.30.176.1', 1433, instance.id, 1444);
  assert.equal(mutations, 1, 'Changing a saved port still prepares its own scoped rule');
});

test('unreadable effective SQL mode does not imply a warning or required restart', () => {
  const report = buildSqlReport(windows, wsl, { instance: instance.name, host: '172.30.176.1', port: 1433 });
  const authentication = report.steps.find(step => step.id === 'windows.authentication');
  assert.equal(authentication.status, 'notChecked');
  assert.equal(authentication.reason, 'mixedConfigured');
  assert.notEqual(authentication.action, 'restartRequired');
});

test('live PDO authentication facts confirm only the corresponding measured local SQL instance', () => {
  const connection = { id: 'application', host: '172.30.176.1', port: 1433 };
  const sqlFacts = [{ id: 'docker.targets', evidence: { connections: [connection] } },
    { id: 'docker.real-network.application.effectiveMode', status: 'passed', evidence: { windowsOnly: 0 } }];
  const inspect = facts => buildSqlReport(windows, { ...wsl, steps: facts }, { instance: instance.name, port: 1433 }).steps.find(step => step.id === 'windows.authentication');
  assert.equal(inspect(sqlFacts).reason, 'mixedEffective');
  assert.equal(inspect(sqlFacts).status, 'passed');
  for (const changed of [{ ...connection, host: 'external-sql.example' }, { ...connection, port: 55555 }]) {
    assert.equal(inspect([{ ...sqlFacts[0], evidence: { connections: [changed] } }, sqlFacts[1]]).reason, 'mixedConfigured');
  }
});
