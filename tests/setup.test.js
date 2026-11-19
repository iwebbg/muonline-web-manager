import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Backend } from '../src/main/backend.js';
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
    assert.doesNotMatch(JSON.stringify(saved), /sql-password|admin-password|bootstrap-login|private failure/);
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
    assert.equal((await journal.read()).stage, undefined);
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
      assert.doesNotMatch(await readFile(path.join(directory, 'installation.json'), 'utf8'), /corrected-admin|current-private-password/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
