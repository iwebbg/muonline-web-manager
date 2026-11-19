import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifySqlError, ipv4Network, firewallScope, validateSqlInput, redactDiagnostic, buildSqlReport } from '../src/shared/sql-diagnostics.js';
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
