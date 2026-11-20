import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Backend as ProductionBackend } from '../src/main/backend.js';

// Platform identity is mocked per coordinator test; the real probe has its own contract.
class Backend extends ProductionBackend {
  async windowsBootIdentity() { return '638990000000000000'; }
}
import { developmentProfile, productionProfile } from '../src/main/runtime-profile.js';
import { SetupJournal } from '../src/main/setup-journal.js';

test('one Install resumes after restart without reinstalling healthy WSL/Docker or persisting credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-setup-test-'));
  let distro = false, docker = false, installed = false;
  const calls = [];
  const runner = async (file, args, input) => {
    calls.push({ file, args, input });
    if (file === 'powershell.exe') return '';
    if (args.includes('--quiet')) return distro ? 'MuOnline-Dev' : '';
    if (args.includes('--verbose')) return distro ? 'MuOnline-Dev Running 2' : '';
    if (args.includes('--install')) { distro = true; return ''; }
    if (args.includes('--version')) return 'WSL test';
    if (args.includes('sh')) {
      assert.doesNotMatch(input, /\r/);
      if (input.includes('docker-ce')) docker = true;
      return '';
    }
    const { request } = JSON.parse(input);
    if (request.action === 'prepareWsl') return JSON.stringify({ ok: true, result: { linuxUser: 'muonline', restartRequired: false } });
    if (request.action === 'prerequisites') {
      if (!docker) throw new Error('Docker unavailable');
      return JSON.stringify({ ok: true, result: { docker: 'test' } });
    }
    if (request.action === 'status') return JSON.stringify({ ok: true, result: installed ? { installed: true, phase: 'ready' } : { installed: false } });
    throw new Error('Unexpected operation ' + request.action);
  };
  const create = () => {
    const backend = new Backend(process.cwd(), directory, undefined, 'en', developmentProfile, runner);
    backend.requireWindows = () => {};
    return backend;
  };
  try {
    const backend = create();
    backend.deploy = async () => { throw new Error('private failure sql-password'); };
    await assert.rejects(backend.invoke('install', { settings: { sqlHost: '192.0.2.8', sqlAdmin: 'bootstrap-login', sqlPassword: 'sql-password', administrator: { password: 'admin-password' }, access: { mode: 'local' } } }), /private failure/);
    const saved = JSON.parse(await readFile(path.join(directory, 'installation.json'), 'utf8'));
    assert.equal(saved.stage, 'application');
    assert.equal(saved.status, 'failed');
    assert.equal(saved.linuxUser, 'muonline');
    assert.equal(saved.configuration.sqlHost, '192.0.2.8');
    assert.doesNotMatch(JSON.stringify(saved), /sql-password|admin-password|private failure/);
    const resumed = create();
    resumed.deploy = async (action, input) => {
      assert.equal(action, 'install');
      assert.equal(input.settings.sqlHost, '192.0.2.8');
      assert.equal(input.settings.sqlPassword, 'new-secret');
      installed = true;
      return 'Complete';
    };
    await resumed.invoke('resumeInstall', { settings: { sqlPassword: 'new-secret' } });
    resumed.busy = true;
    const progress = await resumed.invoke('setupStatus', { sqlPassword: 'ignored', stage: 'evil' });
    assert.equal(progress.stage, 'ready');
    assert.equal(progress.status, 'complete');
    assert.equal(calls.filter(call => call.args.includes('--install')).length, 1);
    assert.equal(calls.filter(call => call.input?.includes('apt-get install -y docker-ce')).length, 1);
    for (const call of calls.filter(call => call.args.includes('-d') && !call.args.includes('--install'))) assert.equal(call.args[call.args.indexOf('-d') + 1], 'MuOnline-Dev');
    assert.doesNotMatch(await readFile(path.join(directory, 'installation.json'), 'utf8'), /new-secret/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('application resume uses its existing WSL phase and never reinstalls or bypasses recovery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-resume-test-'));
  try {
    for (const phase of ['bootstrap-pending', 'runtime-bootstrapped', 'administrator-created', 'ready', 'migration-recovery-required']) {
      const backend = new Backend(process.cwd(), directory);
      backend.requireWindows = () => {};
      backend.ensureEnvironment = async () => {};
      backend.deploy = async () => { throw new Error('must not reinstall'); };
      let current = phase;
      const actions = [];
      backend.runtime = async request => {
        actions.push(request.action);
        if (request.action === 'status') return { installed: true, phase: current };
        assert.equal(request.action, 'resumeInstall');
        current = 'ready';
        return 'Resumed';
      };
      if (phase === 'migration-recovery-required') {
        await assert.rejects(backend.install(), /manual recovery/);
        assert.deepEqual(actions, ['status']);
      } else {
        await backend.install();
        assert.equal(actions.includes('resumeInstall'), phase !== 'ready');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows reboot and Linux restart boundaries are journaled without shutting down other distros', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-reboot-test-'));
  try {
    const backend = new Backend(process.cwd(), directory, undefined, 'en', productionProfile, async file => {
      if (file === 'wsl.exe') throw new Error('WSL features unavailable');
      return JSON.stringify({ restartRequired: true });
    });
    backend.requireWindows = () => {};
    await assert.rejects(backend.ensureDistribution(), /Restart Windows/);
    assert.equal((await backend.setup.read()).status, 'restartRequired');
    const calls = [];
    backend.runner = async (file, args) => { calls.push(args); return ''; };
    backend.runtime = async request => request.action === 'prepareWsl' ? { linuxUser: 'muonline', restartRequired: true } : { systemd: true };
    await backend.prepareLinux();
    assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(['--terminate', 'Ubuntu-24.04'])));
    assert.ok(calls.every(args => !args.includes('--shutdown')));
    const journal = new SetupJournal(directory, 'Ubuntu-24.04');
    assert.equal((await journal.read()).linuxUser, 'muonline');
    await journal.resetRuntime();
    assert.equal((await journal.read()).stage, 'windows');
    assert.equal((await journal.read()).restartBoot, '638990000000000000');
    assert.equal((await journal.read()).linuxUser, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('empty WSL inventory after reboot proceeds directly to Ubuntu instead of failing the second listing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-empty-wsl-'));
  const calls = [];
  let distro = false;
  const backend = new Backend(process.cwd(), directory, undefined, 'en', productionProfile, async (file, args) => {
    calls.push({ file, args });
    if (file === 'powershell.exe') {
      const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(source, /Start-Process -FilePath powershell.exe/);
      assert.match(source, /-Verb RunAs/);
      assert.doesNotMatch(source, /--shutdown/);
      return JSON.stringify({ restartRequired: false });
    }
    if (args.includes('--quiet')) throw new Error('No installed distributions (exit 4294967295).');
    if (args.includes('--install')) { distro = true; return ''; }
    if (args.includes('--verbose')) return distro ? 'Ubuntu-24.04 Stopped 2' : '';
    throw new Error('Unexpected WSL operation');
  });
  backend.requireWindows = () => {};
  try {
    await backend.ensureDistribution();
    assert.equal(calls.filter(call => call.args.includes('--quiet')).length, 1);
    assert.ok(calls.some(call => JSON.stringify(call.args) === JSON.stringify(['--install', '-d', 'Ubuntu-24.04', '--no-launch'])));
    assert.equal((await backend.setup.read()).status, 'complete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy inbox WSL with working inventory reports fallback download failure before unsupported distro flags', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-inbox-wsl-'));
  const calls = [];
  const backend = new Backend(process.cwd(), directory, undefined, 'bg', productionProfile, async (file, args) => {
    calls.push({ file, args });
    if (file === 'powershell.exe') return JSON.stringify({ failureCode: 51, restartRequired: false });
    if (args.includes('--quiet')) return '';
    if (args.includes('--version')) throw new Error('Usage: wsl.exe [Argument] [Options...]');
    throw new Error('Unexpected command');
  });
  backend.requireWindows = () => {};
  try {
    await assert.rejects(backend.ensureDistribution(), /installer could not be downloaded/);
    assert.equal(calls.some(call => call.args.includes('--install') || call.args.includes('--unregister')), false);
    assert.equal((await backend.setup.read()).status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('upgrading inbox WSL retains existing distro inventory and does not reinstall the website environment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-inbox-upgrade-'));
  const calls = [];
  const backend = new Backend(process.cwd(), directory, undefined, 'en', productionProfile, async (file, args) => {
    calls.push({ file, args });
    if (file === 'powershell.exe') return JSON.stringify({ failureCode: 0, restartRequired: false });
    if (args.includes('--quiet')) return 'Ubuntu-24.04\nPersonal-Linux';
    if (args.includes('--version')) throw new Error('Unknown option');
    if (args.includes('--verbose')) return 'Ubuntu-24.04 Stopped 2';
    throw new Error('Unexpected command');
  });
  backend.requireWindows = () => {};
  try {
    await backend.ensureDistribution();
    assert.equal(calls.some(call => call.args.includes('--install') || call.args.includes('--unregister') || call.args.includes('--shutdown')), false);
    assert.equal((await backend.setup.read()).status, 'complete');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('automatic WSL installer failures report bounded reasons and never advance to distro setup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-msi-failure-'));
  try {
    for (const [failureCode, reason] of [[50, /Windows needs updating/], [51, /could not be downloaded/], [52, /verification failed.*not executed/], [53, /installer did not complete/], [54, /commands are not available/]]) {
      const calls = [];
      const backend = new Backend(process.cwd(), directory, undefined, 'en', productionProfile, async (file, args) => {
        calls.push({ file, args });
        if (file === 'powershell.exe') return JSON.stringify({ restartRequired: false, failureCode });
        if (args.includes('--quiet')) return '';
        throw new Error('Legacy WSL');
      });
      backend.requireWindows = () => {};
      await assert.rejects(backend.ensureDistribution(), reason);
      assert.equal(calls.some(call => call.args.includes('--install') || call.args.includes('--unregister')), false);
      assert.equal((await backend.setup.read()).status, 'failed');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bootstrap failures retain the original error and suggest only a different measured endpoint', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-sql-resume-'));
  const endpoint = { host: '127.0.0.1', port: 1433, gameHost: '127.0.0.1', gamePort: 1433 };
  try {
    for (const mode of ['different', 'same', 'unavailable']) {
      const backend = new Backend(process.cwd(), directory);
      backend.ensureEnvironment = async () => {};
      backend.requireWindows = () => {};
      const failure = new Error('SQL bootstrap failed');
      backend.runtime = async request => {
        if (request.action === 'status') return { installed: true, phase: 'bootstrap-pending', bootstrapSqlEndpoint: endpoint };
        assert.equal(request.action, 'resumeInstall');
        assert.equal(request.settings.sqlAdmin, 'corrected-admin');
        assert.equal(request.settings.sqlPassword, 'current-private-password');
        throw failure;
      };
      backend.sql.suggest = async (port, host) => {
        assert.equal(port, 1433);
        assert.equal(host, endpoint.host);
        if (mode === 'unavailable') throw new Error('optional discovery unavailable');
        return { suggestion: { host: mode === 'same' ? endpoint.host : '172.20.48.1', port } };
      };
      await assert.rejects(backend.install({ settings: { sqlAdmin: 'corrected-admin', sqlPassword: 'current-private-password' } }), error => {
        assert.equal(error, failure);
        assert.deepEqual(error.bootstrapSqlEndpoint, endpoint);
        assert.equal(error.sqlSuggestion?.host, mode === 'different' ? '172.20.48.1' : undefined);
        return true;
      });
      assert.doesNotMatch(await readFile(path.join(directory, 'installation.json'), 'utf8'), /current-private-password/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('WSL elevation keeps the command short and passes the packaged script path through stdin', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-wsl-length-'));
  const resources = path.join(directory, 'Desktop App', 'Потребителски файлове');
  let elevation = false;
  const backend = new Backend(resources, directory, undefined, 'en', productionProfile, async (file, args, input) => {
    if (file === 'wsl.exe') throw new Error('WSL unavailable');
    assert.equal(file, 'powershell.exe');
    elevation = true;
    assert.ok(args.join(' ').length < 8192, 'The command stays bounded independently of installer source size');
    const wrapper = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.doesNotMatch(wrapper, /Install-ModernWslRuntime|Get-AuthenticodeSignature/);
    assert.doesNotMatch(wrapper, /-EncodedCommand/);
    assert.match(wrapper, /'-File',\('"'\+\$payload.path\+'"'\)/);
    assert.match(wrapper, /-Verb RunAs/);
    assert.match(wrapper, /InputEncoding=New-Object System.Text.UTF8Encoding/);
    assert.ok(!wrapper.includes(resources), 'Paths never become PowerShell source');
    const request = JSON.parse(input);
    assert.equal(request.path, path.resolve(resources, 'runtime', 'setup-windows-wsl.ps1'));
    assert.equal(path.basename(request.result), 'result.json');
    assert.equal(wrapper.includes(request.result), false);
    assert.match(wrapper, /Get-Content -LiteralPath/);
    assert.match(wrapper, /result does not match process exit code/);
    return JSON.stringify({ restartRequired: true });
  });
  backend.requireWindows = () => {};
  try {
    await assert.rejects(backend.ensureDistribution(), /Restart Windows/);
    assert.equal(elevation, true);
    assert.equal((await backend.setup.read()).status, 'restartRequired');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unexpected elevated setup exit is logged with its stage and never advances installation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-wsl-stage-'));
  const logged = [];
  let resultFile;
  const backend = new Backend(process.cwd(), directory, undefined, 'en', productionProfile, async (file, args, input) => {
    if (file === 'wsl.exe') {
      assert.ok(!args.includes('--install'), 'Do not install a distro after failed feature preparation');
      throw new Error('Legacy WSL');
    }
    const request = JSON.parse(input);
    resultFile = request.result;
    return JSON.stringify({ failureCode: 1, restartRequired: false, stage: 'windows-features', detail: 'Fixture missing optional feature.' });
  });
  backend.requireWindows = () => {};
  backend.activeLog = { append: async text => logged.push(text) };
  try {
    await assert.rejects(backend.ensureDistribution(), /support logs.*setup stage/);
    assert.ok(logged.some(text => text.includes('windows-features') && text.includes('Fixture missing optional feature.')));
    await assert.rejects(readFile(path.dirname(resultFile)), { code: 'ENOENT' });
    assert.equal((await backend.setup.read()).status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('coordinator launch failure retains the child report before cleaning temporary files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-wsl-parent-failure-'));
  const logged = [];
  let resultPath;
  const original = new Error('Fixture PowerShell coordinator exit 1');
  const backend = new Backend(process.cwd(), directory, undefined, 'en', undefined, async (file, args, input) => {
    if (file === 'wsl.exe') throw new Error('Fixture legacy WSL');
    const request = JSON.parse(input);
    resultPath = request.result;
    await writeFile(resultPath, JSON.stringify({ failureCode: 1, stage: 'windows-features', detail: 'Fixture elevated feature failure.' }));
    throw original;
  });
  backend.requireWindows = () => {};
  backend.activeLog = { append: async value => logged.push(value) };
  try {
    await assert.rejects(backend.ensureDistribution(), error => error === original);
    assert.ok(logged.some(value => value.includes('coordinator: result-report-v2')));
    assert.ok(logged.some(value => value.includes('child report after coordinator failure') && value.includes('Fixture elevated feature failure.')));
    await assert.rejects(readFile(resultPath), { code: 'ENOENT' });
    assert.equal((await backend.setup.read()).status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Install provisions with the detected local endpoint and journals it without persisting temporary credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-auto-local-sql-'));
  const endpoint = { host: '192.168.1.7', port: 1433, gameHost: '192.168.1.7', gamePort: 1433 };
  try {
    for (const installed of [false, true]) {
      const backend = new Backend(process.cwd(), directory);
      backend.requireWindows = () => {};
      backend.ensureEnvironment = async () => {};
      let ready = false;
      backend.sql.prepareInstallation = async (host, port) => {
        assert.equal(host, '192.168.1.7');
        assert.equal(Number(port), 1433);
        return { host: '172.30.176.1', port: 1433, local: true, instanceId: 'MSSQL15.SQLEXPRESS', localAddresses: ['192.168.1.7', '172.30.176.1'] };
      };
      const provision = async request => {
        assert.equal(request.settings.sqlHost, '172.30.176.1');
        assert.equal(request.settings.localSqlInstanceId, 'MSSQL15.SQLEXPRESS');
        assert.equal(request.settings.sqlPassword, 'current-private-secret');
        if (installed) assert.deepEqual(request.settings.sqlEndpointChange, { confirmed: true, expected: endpoint });
        ready = true;
        return 'Complete';
      };
      backend.runtime = async request => request.action === 'status' ? { installed: ready || installed, phase: ready ? 'ready' : 'bootstrap-pending', bootstrapSqlEndpoint: endpoint } : provision(request);
      backend.deploy = async (action, request) => provision(request);
      const result = await backend.install({ settings: { sqlHost: '192.168.1.7', sqlPort: '1433', sqlAdmin: 'temporary-admin', sqlPassword: 'current-private-secret', localSqlInstanceId: 'renderer-forgery' } });
      assert.deepEqual(result.sqlResolvedEndpoint, { host: '172.30.176.1', port: 1433 });
      const journal = await readFile(path.join(directory, 'installation.json'), 'utf8');
      assert.equal(JSON.parse(journal).configuration.sqlHost, '172.30.176.1');
      assert.doesNotMatch(journal, /current-private-secret|renderer-forgery/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed automatic SQL network preparation never enters application bootstrap', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-auto-local-refuse-'));
  const backend = new Backend(process.cwd(), directory);
  backend.requireWindows = () => {};
  backend.ensureEnvironment = async () => {};
  backend.runtime = async request => { assert.equal(request.action, 'status'); return { installed: false }; };
  backend.deploy = async () => { assert.fail('Do not bootstrap before connectivity'); };
  backend.sql.prepareInstallation = async () => { throw new Error('UAC refused'); };
  try {
    await assert.rejects(backend.install({ settings: { sqlHost: '127.0.0.1' } }), /UAC refused/);
    assert.equal((await backend.setup.read()).status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a recorded WSL restart blocks retries on the same boot and clears only after a real Windows boot change', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-wsl-boot-gate-'));
  let boot = '638990000000000000';
  const calls = [];
  const backend = new Backend(process.cwd(), directory, undefined, 'en', undefined, async (file, args) => {
    calls.push({ file, args });
    if (file === 'powershell.exe') return JSON.stringify({ restartRequired: true, failureCode: 3010 });
    if (args.includes('--version')) throw new Error('Fixture inbox WSL');
    if (args.includes('--verbose')) return 'Ubuntu-24.04 Stopped 2';
    return 'Ubuntu-24.04';
  });
  backend.requireWindows = () => {};
  backend.windowsBootIdentity = async () => boot;
  try {
    await assert.rejects(backend.ensureDistribution(), error => error.code === 'WSL_RESTART_REQUIRED');
    assert.equal((await backend.setup.read()).restartBoot, boot);
    const before = calls.length;
    await assert.rejects(backend.ensureDistribution(), error => error.code === 'WSL_RESTART_REQUIRED');
    assert.equal(calls.length, before, 'Retry on the same boot never attempts WSL install/update');
    const reopened = new Backend(process.cwd(), directory, undefined, 'en', undefined, async () => assert.fail('Manager restart must not bypass the boot gate'));
    reopened.requireWindows = () => {};
    reopened.windowsBootIdentity = async () => boot;
    await assert.rejects(reopened.ensureDistribution(), error => error.code === 'WSL_RESTART_REQUIRED');
    boot = '638991000000000000';
    backend.runner = async (file, args) => args.includes('--verbose') ? 'Ubuntu-24.04 Stopped 2' : 'Ubuntu-24.04';
    await backend.ensureDistribution();
    assert.equal((await backend.setup.read()).restartBoot, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows boot measurement accepts only the fixed read-only CIM probe result', async () => {
  const backend = new ProductionBackend(process.cwd(), '/tmp/unused-boot-probe', undefined, 'en', undefined, async (file, args, input) => {
    assert.equal(file, 'powershell.exe');
    assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /Win32_OperatingSystem.*LastBootUpTime/);
    assert.equal(input, '');
    return '638990000000000000\r\n';
  });
  assert.equal(await backend.windowsBootIdentity(), '638990000000000000');
  backend.runner = async () => 'Unverified boot';
  await assert.rejects(backend.windowsBootIdentity(), /could not be verified/);
});


test('public installation draft survives manager restart with all fields but no passwords or grants', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-draft-'));
  try {
    const create = () => new Backend(process.cwd(), directory);
    const draft = { sqlHost: '192.0.2.88', sqlPort: '1444', sqlAdmin: 'setup-admin', profile: 'darksteam_97d99i', appEnv: 'production', gameDatabase: 'Game2', webDatabase: 'Web2', appLogin: 'app2', gameLogin: 'game2', trustCertificate: false,
      access: { mode: 'domain', host: 'mu.example.test', email: 'cert@example.test', httpAcknowledged: false, password: 'access-private' },
      administrator: { name: 'My Owner', email: 'owner@example.test', password: 'web-private' },
      sqlPassword: 'sql-private', adminPassword: 'flat-private', sqlEndpointChange: { confirmed: true }, confirmSqlEndpoint: true, stage: 'ready', restartBoot: 'fake', version: 'evil' };
    await create().invoke('saveInstallationDraft', { settings: draft });
    const saved = await create().invoke('setupStatus');
    assert.equal(saved.configuration.profile, draft.profile);
    assert.equal(saved.configuration.sqlHost, draft.sqlHost);
    assert.equal(saved.configuration.sqlPort, draft.sqlPort);
    assert.equal(saved.configuration.sqlAdmin, draft.sqlAdmin);
    assert.deepEqual(saved.configuration.administrator, { name: 'My Owner', email: 'owner@example.test' });
    assert.deepEqual(saved.configuration.access, { mode: 'domain', host: 'mu.example.test', email: 'cert@example.test', httpAcknowledged: false });
    assert.equal(saved.configuration.gameDatabase, 'Game2');
    assert.equal(saved.configuration.webDatabase, 'Web2');
    assert.equal(saved.configuration.appLogin, 'app2');
    assert.equal(saved.configuration.gameLogin, 'game2');
    assert.equal(saved.configuration.appEnv, 'production');
    assert.equal(saved.configuration.trustCertificate, false);
    assert.equal(saved.stage, undefined);
    assert.equal(saved.restartBoot, undefined);
    const serialized = await readFile(path.join(directory, 'installation.json'), 'utf8');
    assert.doesNotMatch(serialized, /private|password|Password|confirmed|confirmSqlEndpoint|evil/);
    await create().setup.saveDraft({ administrator: { password: 'new-private' }, access: { host: 'changed.example.test' } });
    const resumed = await create().setup.read();
    assert.deepEqual(resumed.configuration.administrator, saved.configuration.administrator);
    assert.equal(resumed.configuration.access.email, 'cert@example.test');
    assert.equal(resumed.configuration.access.host, 'changed.example.test');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
