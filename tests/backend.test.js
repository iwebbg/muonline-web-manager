import test from 'node:test';
import assert from 'node:assert/strict';
import { Backend } from '../src/main/backend.js';

test('IPC cannot dispatch arbitrary runtime operations', async () => {
  const backend = new Backend('/unused', '/unused');
  await assert.rejects(backend.invoke('exec', { command: 'rm' }), /Unsupported/);
  assert.equal(backend.busy, false);
});
test('concurrent mutations are rejected and sensitive operations never auto-apply', async () => {
  const backend = new Backend('/unused', '/unused');
  backend.busy = true;
  await assert.rejects(backend.invoke('stop'), /Another operation/);
});
test('runtime input cannot replace the allow-listed operation', async () => {
  const backend = new Backend('/unused', '/unused');
  let request;
  backend.runtime = async value => { request = value; return 'ok'; };
  await backend.invoke('status', { action: 'install', release: { untrusted: true } });
  assert.equal(request.action, 'status');
});
test('release feed settings contain no credential storage fields', () => {
  const backend = new Backend('/unused', '/unused');
  assert.deepEqual(backend.validateSettings({ cdn: 'https://cdn.example', webChannel: 'web/stable', managerChannel: 'manager/stable', sqlPassword: 'secret' }), { cdn: 'https://cdn.example', webChannel: 'web/stable', managerChannel: 'manager/stable' });
  for (const cdn of ['http://cdn.example', 'https://name:password@cdn.example', 'https://cdn.example?secret=x']) {
    assert.throws(() => backend.validateSettings({ cdn, webChannel: 'web/stable', managerChannel: 'manager/stable' }));
  }
});

test('deploy input cannot replace authenticated metadata, archive paths or selected action', async () => {
  const backend = new Backend('/unused', '/unused');
  const authenticated = { version: '1.3.0', artifacts: {} };
  backend.webRelease = authenticated;
  backend.prerequisites = async () => true;
  backend.ensureKeepalive = async () => {};
  let received;
  backend.runtime = async request => { received = request; return 'ok'; };
  await backend.deploy('install', { action: 'update', release: { forged: true }, paths: { application: '/untrusted.zip' }, settings: { profile: 'example' } });
  assert.equal(received.action, 'install');
  assert.equal(received.release, authenticated);
  assert.deepEqual(received.paths, {});
});
