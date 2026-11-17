import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SupportLogs } from '../src/main/support-logs.js';
import { Backend } from '../src/main/backend.js';
import { productionProfile, developmentProfile } from '../src/main/runtime-profile.js';

test('local support files redact request secrets and keep useful error details', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-support-test-'));
  try {
    const logs = new SupportLogs(directory);
    const secret = 'Private-Password/42!';
    const session = await logs.begin('resumeInstall', { sqlRemoval: { admin_username: 'Temporary-SQL-Admin' }, settings: { sqlPassword: secret, administrator: { password: 'Admin-Private-Password' } } });
    await session.append('SQLSTATE[08001] connection refused\nTemporary-SQL-Admin\n' + secret + '\n' + encodeURIComponent(secret) + '\nAdmin-Private-Password\npassword=unknown-private-value\nhttps://user:uri-secret@host.example');
    const content = await readFile(session.file, 'utf8');
    assert.match(content, /SQLSTATE\[08001\] connection refused/);
    for (const value of ['Temporary-SQL-Admin', secret, encodeURIComponent(secret), 'Admin-Private-Password', 'unknown-private-value', 'uri-secret']) assert.equal(content.includes(value), false);
    assert.match(content, /REDACTED/);
    for (let index = 0; index < 31; index++) await logs.begin('status');
    assert.equal((await readdir(logs.directory)).length, 30);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uninstall requires exact confirmation, exports logs first and removes only fixed profile resources', async () => {
  for (const profile of [productionProfile, developmentProfile]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-uninstall-test-'));
    let exists = true;
    const calls = [];
    const backend = new Backend(process.cwd(), directory, undefined, 'en', profile, async (file, args, input) => {
      calls.push({ file, args, input });
      if (args.includes('--quiet')) return 'Personal-Linux\n' + (exists ? profile.distribution : '');
      if (args.includes('--unregister')) { exists = false; return ''; }
      if (file === 'powershell.exe') return '';
      const payload = JSON.parse(input);
      if (payload.request.action === 'uninstallDatabase') return JSON.stringify({ ok: true, result: { ok: true, code: 'not_installed' } });
      assert.equal(payload.request.action, 'runtimeLogs');
      return JSON.stringify({ ok: true, result: 'redacted previous runtime diagnostics' });
    });
    backend.requireWindows = () => {};
    try {
      for (const input of [{ confirmed: false, distributionConfirmation: profile.distribution }, { confirmed: true, distributionConfirmation: 'Personal-Linux' }]) await assert.rejects(backend.invoke('uninstallRuntime', input), /exact WSL/);
      assert.equal(calls.length, 0);
      const result = await backend.invoke('uninstallRuntime', { confirmed: true, distributionConfirmation: profile.distribution, distribution: 'Personal-Linux', command: 'unsafe' });
      assert.equal(result.removed, true);
      assert.deepEqual(calls.at(-1).args, ['--unregister', profile.distribution]);
      const taskSource = Buffer.from(calls.find(call => call.file === 'powershell.exe').args.at(-1), 'base64').toString('utf16le');
      assert.ok(taskSource.includes(profile.taskName));
      assert.equal(taskSource.includes('Personal-Linux'), false);
      assert.equal(calls.some(call => call.args.includes('--shutdown')), false);
      const files = await readdir(backend.supportLogs.directory);
      assert.ok((await Promise.all(files.map(file => readFile(path.join(backend.supportLogs.directory, file), 'utf8')))).some(text => text.includes('redacted previous runtime diagnostics')));
      assert.equal((await backend.setup.read()).linuxUser, undefined);
      calls.length = 0;
      await backend.invoke('uninstallRuntime', { confirmed: true, distributionConfirmation: profile.distribution });
      assert.equal(calls.some(call => call.args.includes('--unregister')), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('failed task cleanup does not delete the distro and links a local error log', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-uninstall-failure-'));
  const calls = [];
  const backend = new Backend(process.cwd(), directory, undefined, 'en', developmentProfile, async (file, args) => {
    calls.push(args);
    if (args.includes('--quiet')) return 'MuOnline-Dev';
    throw new Error('Task cleanup unavailable');
  });
  backend.requireWindows = () => {};
  try {
    await assert.rejects(backend.invoke('uninstallRuntime', { confirmed: true, distributionConfirmation: 'MuOnline-Dev' }), error => {
      assert.ok(error.logFile.startsWith(path.join(directory, 'logs')));
      return true;
    });
    assert.equal(calls.some(args => args.includes('--unregister')), false);
    assert.equal((await backend.setup.read()).status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('SQL cleanup refusal, partial progress, malformed response or startup failure never unregister runtime', async () => {
  for (const cleanup of [
    { ok: false, code: 'shared_login', database: 'retained', login: 'retained' },
    { ok: false, code: 'sql_operation_failed', database: 'removed', login: 'unknown' },
    { ok: false, code: 'private-secret', database: 'private-secret', login: 'private-secret' },
    null, 'broken-json', new Error('Application command unavailable')
  ]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-sql-cleanup-'));
    const calls = [];
    const backend = new Backend(process.cwd(), directory, undefined, 'en', developmentProfile, async (file, args, input) => {
      calls.push({ file, args });
      if (args.includes('--quiet')) return 'MuOnline-Dev';
      const action = JSON.parse(input).request.action;
      if (action === 'runtimeLogs') return JSON.stringify({ ok: true, result: '' });
      assert.equal(action, 'uninstallDatabase');
      if (cleanup instanceof Error) throw cleanup;
      if (cleanup === 'broken-json') return 'not JSON';
      return JSON.stringify({ ok: true, result: cleanup });
    });
    backend.requireWindows = () => {};
    try {
      await assert.rejects(backend.invoke('uninstallRuntime', {
        confirmed: true, distributionConfirmation: 'MuOnline-Dev',
        sqlRemoval: { admin_password: 'private-secret' }
      }));
      assert.equal(calls.some(call => call.args.includes('--unregister') || call.file === 'powershell.exe'), false);
      assert.equal((await backend.setup.read()).status, 'failed');
      const logs = await readdir(backend.supportLogs.directory);
      for (const log of logs) assert.equal((await readFile(path.join(backend.supportLogs.directory, log), 'utf8')).includes('private-secret'), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('confirmed SQL cleanup completes before task removal and WSL unregister', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-sql-uninstall-'));
  const order = [];
  const sqlRemoval = { confirmed: true, target: { host: 'sql', port: 1433, database: 'Web', login: 'web_app' }, admin_username: 'sa', admin_password: 'private-secret' };
  const backend = new Backend(process.cwd(), directory, undefined, 'en', developmentProfile, async (file, args, input) => {
    if (args.includes('--quiet')) return 'MuOnline-Dev';
    if (file === 'powershell.exe') { order.push('task'); return ''; }
    if (args.includes('--unregister')) { order.push('unregister'); return ''; }
    const request = JSON.parse(input).request;
    order.push(request.action);
    if (request.action === 'uninstallDatabase') {
      assert.deepEqual(request.sqlRemoval, sqlRemoval);
      assert.equal(args.some(value => value.includes('private-secret')), false);
      return JSON.stringify({ ok: true, result: { ok: true, code: 'uninstalled', database: 'removed', login: 'removed' } });
    }
    return JSON.stringify({ ok: true, result: '' });
  });
  backend.requireWindows = () => {};
  try {
    assert.equal((await backend.invoke('uninstallRuntime', { confirmed: true, distributionConfirmation: 'MuOnline-Dev', sqlRemoval })).removed, true);
    assert.deepEqual(order, ['runtimeLogs', 'uninstallDatabase', 'task', 'unregister']);
    assert.equal(JSON.stringify(await backend.setup.read()).includes('private-secret'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
