import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebNetwork } from '../src/main/web-network.js';
import { Backend } from '../src/main/backend.js';
import { productionProfile, developmentProfile } from '../src/main/runtime-profile.js';

async function fixture(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mu-web-network-test-'));
  try { await operation(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Local web mode never elevates; only fixed mode/profile cross public preparation stdin', async () => fixture(async directory => {
  const calls = [];
  let mode = 'local';
  const web = new WebNetwork(process.cwd(), directory, async (file, args, stdin) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(args[0], '-NoProfile');
    const payload = JSON.parse(stdin);
    const request = JSON.parse(await readFile(payload.request, 'utf8'));
    assert.deepEqual(Object.keys(request).sort(), ['mode', 'profile']);
    assert.equal(request.profile, 'production');
    assert.doesNotMatch(stdin + args.join(' '), /private-password|untrusted-host|user-value/);
    assert.equal(payload.script, path.join(process.cwd(), 'runtime/web-network.ps1'));
    calls.push(payload);
    await writeFile(payload.result, JSON.stringify({ ok: true, result: { previousMode: mode, mode: request.mode, changed: mode !== request.mode, target: '172.25.16.4' } }));
    mode = request.mode;
  }, productionProfile);
  await web.configure({ mode: 'local' });
  assert.equal(calls.length, 0);
  const ticket = await web.configure({ mode: 'domain', host: 'untrusted-host', password: 'private-password', port: 9999 });
  assert.equal(ticket.previousMode, 'local');
  assert.deepEqual(await web.read(), { mode: 'domain', pending: false });
  assert.equal(await readFile(web.marker, 'utf8'), '{"mode":"domain"}');
  await web.restore(ticket);
  assert.equal((await web.read()).mode, 'local');
  for (const payload of calls) await assert.rejects(access(payload.request), { code: 'ENOENT' });
}));

test('interrupted elevation retains a pending journal and never silently refreshes public ports', async () => fixture(async directory => {
  let calls = 0;
  const web = new WebNetwork(process.cwd(), directory, async () => { calls++; throw new Error('UAC cancelled'); }, developmentProfile);
  await assert.rejects(web.configure({ mode: 'ip' }), /did not complete/);
  assert.deepEqual(await web.read(), { mode: 'ip', pending: true });
  await assert.rejects(web.refresh(), /incomplete/);
  assert.equal(calls, 1);
  await assert.rejects(web.configure({ mode: 'other', command: 'anything' }), /Invalid web access/);
}));

test('Access validates before Windows effects and restores its network ticket on runtime refusal', async () => fixture(async directory => {
  const backend = new Backend(process.cwd(), directory);
  const order = [];
  backend.runtime = async request => {
    order.push(request.action);
    if (request.action === 'validateAccess') return { mode: 'domain', host: 'mu.example.test', email: 'owner@example.test' };
    throw new Error('Certificate refused');
  };
  const ticket = { changed: true, previousMode: 'local' };
  backend.web.configure = async access => { order.push('network'); assert.equal(access.host, 'mu.example.test'); return ticket; };
  backend.web.restore = async value => { order.push('restore'); assert.equal(value, ticket); };
  await assert.rejects(backend.invoke('access', { action: 'install', access: { mode: 'domain' } }), /Certificate refused/);
  assert.deepEqual(order, ['validateAccess', 'network', 'access', 'restore']);
}));

test('PowerShell web helper protects conflicts, retries and owned-only cleanup', { skip: process.platform !== 'win32' }, async () => {
  const output = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('tests/windows-web-contract.ps1')], { windowsHide: true });
    let text = '';
    child.stdout.on('data', data => { text += data; });
    child.stderr.on('data', data => { text += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(text) : reject(new Error(text)));
  });
  assert.match(output, /PASS: Windows web network contracts/);
});
