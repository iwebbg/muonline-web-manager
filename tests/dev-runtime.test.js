import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Backend } from '../src/main/backend.js';
import { developmentProfile, productionProfile, runtimeProfile, isWsl2Distribution } from '../src/main/runtime-profile.js';
import { acquireDevLock } from '../src/main/dev-lock.js';
import { manageDevWsl, runDevSetupStep } from '../scripts/dev-wsl.js';

test('only the main-owned dev profile can enable runtime diagnostics', async () => {
  for (const profile of [productionProfile, developmentProfile]) {
    let received;
    const backend = new Backend(process.cwd(), '/unused', undefined, 'en', profile, async (file, args, input) => {
      received = JSON.parse(input).request;
      return JSON.stringify({ ok: true, result: {} });
    });
    backend.requireWindows = () => {};
    await backend.runtime({ action: 'status', developmentDiagnostics: !profile.development });
    assert.equal(received.developmentDiagnostics, profile.development);
  }
});

test('verbose runtime diagnostics do not appear in user-facing errors', async () => {
  for (const profile of [productionProfile, developmentProfile]) {
    const backend = new Backend(process.cwd(), '/unused', undefined, 'en', profile, async () => JSON.stringify({ ok: false, error: 'Docker failed', diagnostics: 'SQLSTATE[08001]: TCP connection refused' }));
    backend.requireWindows = () => {};
    await assert.rejects(backend.runtime({ action: 'resumeInstall' }), error => {
      assert.equal(error.message.includes('SQLSTATE[08001]'), false);
      return true;
    });
  }
});

test('public WSL setup streams only fixed setup steps and identifies the failed stage', async () => {
  for (const step of ['install', 'version']) {
    const child = new EventEmitter();
    const messages = [];
    const pending = runDevSetupStep(step, {
      report: message => messages.push(message),
      spawnProcess: (file, args, options) => {
        assert.equal(file, 'wsl.exe');
        assert.ok(args.includes('MuOnline-Dev'));
        assert.equal(args[0], step === 'install' ? '--install' : '--set-version');
        assert.deepEqual(options, { shell: false, windowsHide: true, stdio: 'inherit' });
        return child;
      }
    });
    child.emit('close', 4294967295);
    await assert.rejects(pending, new RegExp('step "' + step + '" failed \\(exit 4294967295\\)'));
    assert.match(messages[0], /WSL setup: wsl.exe/);
  }
  assert.throws(() => runDevSetupStep('runtime'), /Unsupported public/);
});

test('only source launches can select the fixed dev identity and distro matching is exact', () => {
  assert.equal(runtimeProfile(false, true), developmentProfile);
  assert.equal(runtimeProfile(true, false), productionProfile);
  assert.throws(() => runtimeProfile(true, true), /only from source/);
  assert.throws(() => new Backend('.', '.', undefined, 'en', { ...developmentProfile }), /Invalid runtime profile/);
  assert.equal(isWsl2Distribution('* MuOnline-Dev Running 2', 'MuOnline-Dev'), true);
  assert.equal(isWsl2Distribution('MuOnline-Dev-Backup Stopped 2\nMuOnline-Dev Stopped 1', 'MuOnline-Dev'), false);
});

test('dev Docker, worker, SQL diagnostics and keepalive all use the dev profile', async () => {
  const calls = [];
  const runner = async (file, args, input) => {
    calls.push({ file, args, input });
    if (args.includes('--verbose')) return 'Ubuntu-24.04 Running 2\nMuOnline-Dev Stopped 2';
    return JSON.stringify({ ok: true, result: { installed: false } });
  };
  const backend = new Backend(process.cwd(), '/unused', undefined, 'en', developmentProfile, runner);
  backend.requireWindows = () => {};
  await backend.installDocker();
  await backend.runtime({ action: 'status' });
  await backend.sql.wsl({}, [], true);
  for (const call of calls.filter(call => call.args.includes('-d'))) {
    assert.equal(call.args[call.args.indexOf('-d') + 1], 'MuOnline-Dev');
  }
  assert.doesNotMatch(calls.find(call => call.args.includes('sh')).input, /\r/);
  const task = calls.find(call => call.file === 'powershell.exe');
  const taskSource = Buffer.from(task.args.at(-1), 'base64').toString('utf16le');
  assert.match(taskSource, /MuOnline-Web-Dev-WSL/);
  assert.match(taskSource, /''-d'',''MuOnline-Dev''/);
  assert.match(taskSource, /-WindowStyle Hidden -Wait -PassThru/);
  assert.match(taskSource, /-NonInteractive -WindowStyle Hidden -EncodedCommand/);
  assert.match(taskSource, /Stop-ScheduledTask -InputObject \$existing/);
  assert.doesNotMatch(taskSource, /Ubuntu-24\.04|MuOnline-Web-WSL/);
  const count = calls.length;
  await assert.rejects(backend.updateManager(), /disabled in dev mode/);
  await assert.rejects(backend.invoke('sqlApply'), /disabled in dev mode/);
  assert.equal(calls.length, count);
});

test('Docker failure identifies whether Linux setup or Windows keepalive failed', async () => {
  for (const failure of ['wsl.exe', 'powershell.exe']) {
    const backend = new Backend(process.cwd(), '/unused', undefined, 'en', developmentProfile, async (file, args) => {
      if (args.includes('--verbose')) return 'MuOnline-Dev Running 2';
      if (file === failure) throw new Error('safe command failure');
      return '';
    });
    backend.requireWindows = () => {};
    await assert.rejects(backend.installDocker(), failure === 'wsl.exe' ? /Docker setup in MuOnline-Dev failed/ : /Windows keepalive task MuOnline-Web-Dev-WSL failed/);
  }
});

test('setup/reset require exclusive access and reset deletes only the confirmed fixed dev resources', async () => {
  const appData = await mkdtemp(path.join(os.tmpdir(), 'muonline-dev-test-'));
  const calls = [];
  const runner = async (file, args, input) => {
    calls.push({ file, args, input });
    return args.includes('--quiet') ? 'Ubuntu-24.04\nMuOnline-Dev\nMuOnline-Dev-Backup\n' : '';
  };
  let prepared = 0;
  const options = { runner, appData, platform: 'win32', prepareLinux: async () => { prepared++; }, confirm: async () => 'MuOnline-Dev' };
  try {
    const release = acquireDevLock(appData);
    await assert.rejects(manageDevWsl('reset', options), /busy/);
    release();
    assert.equal(calls.length, 0);
    await assert.rejects(manageDevWsl('reset', { ...options, confirm: async () => 'Ubuntu-24.04' }), /cancelled/);
    assert.equal(calls.length, 1);
    calls.length = 0;
    const messages = [];
    await manageDevWsl('setup', { ...options, report: message => messages.push(message) });
    assert.equal(prepared, 1);
    assert.deepEqual(calls.map(call => call.args), [['--list', '--quiet'], ['--set-version', 'MuOnline-Dev', '2']]);
    assert.match(messages[0], /Skipping installation/);
    calls.length = 0;
    await assert.rejects(manageDevWsl('setup', {
      ...options,
      report: () => {},
      runner: async (file, args) => {
        calls.push({ file, args });
        if (args.includes('--quiet')) return 'MuOnline-Dev\n';
        throw new Error('WSL2 conversion failed');
      }
    }), /WSL2 conversion failed/);
    assert.deepEqual(calls.map(call => call.args), [['--list', '--quiet'], ['--set-version', 'MuOnline-Dev', '2']]);
    calls.length = 0;
    await manageDevWsl('reset', options);
    assert.deepEqual(calls.map(call => call.file), ['wsl.exe', 'powershell.exe', 'wsl.exe']);
    assert.deepEqual(calls[2].args, ['--unregister', 'MuOnline-Dev']);
    const cleanup = Buffer.from(calls[1].args.at(-1), 'base64').toString('utf16le');
    assert.match(cleanup, /MuOnline-Web-Dev-WSL/);
    assert.doesNotMatch(cleanup, /MuOnline-Web-WSL|Ubuntu-24\.04/);
    calls.length = 0;
    await manageDevWsl('setup', { ...options, runner: async (...args) => { calls.push(args); return ''; } });
    assert.deepEqual(calls[1][1], ['--install', '-d', 'Ubuntu-24.04', '--name', 'MuOnline-Dev', '--no-launch']);
    assert.deepEqual(calls[2][1], ['--set-version', 'MuOnline-Dev', '2']);
    await assert.rejects(manageDevWsl('production-reset', options), /overrides are not supported/);
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});
