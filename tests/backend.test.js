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
  assert.deepEqual(backend.validateSettings({ cdn: 'https://cdn.example', webChannel: 'web/stable', managerChannel: 'manager/stable', sqlPassword: 'secret' }), { cdn: 'https://cdn.example', webChannel: 'web/stable', managerChannel: 'manager/stable', githubRepository: 'iwebbg/muonline-web-laravel' });
  for (const cdn of ['http://cdn.example', 'https://name:password@cdn.example', 'https://cdn.example?secret=x']) {
    assert.throws(() => backend.validateSettings({ cdn, webChannel: 'web/stable', managerChannel: 'manager/stable' }));
  }
});

test('deploy input cannot replace authenticated metadata, archive paths or selected action', async () => {
  const backend = new Backend('/unused', '/unused');
  const authenticated = { version: '1.3.0', artifacts: {} };
  backend.webRelease = authenticated;
  backend.refreshWebRelease = async () => { backend.webRelease = authenticated; return { ready: true }; };
  backend.prerequisites = async () => true;
  backend.ensureKeepalive = async () => {};
  let received;
  backend.runtime = async request => { received = request; return 'ok'; };
  await backend.deploy('install', { action: 'update', release: { forged: true }, paths: { application: '/untrusted.zip' }, settings: { profile: 'example' } });
  assert.equal(received.action, 'install');
  assert.equal(received.release, authenticated);
  assert.deepEqual(received.paths, {});
});

test('website buttons resolve fresh installed origins and fixed admin path, ignoring renderer URLs', async () => {
  const backend = new Backend('/unused', '/unused');
  let address = 'http://localhost';
  backend.runtime = async request => {
    assert.deepEqual(request, { action: 'status' });
    return { installed: true, phase: 'ready', access: { url: address } };
  };
  for (const origin of ['http://localhost', 'http://192.168.1.7', 'http://[::1]', 'https://mu.example.com']) {
    address = origin;
    assert.equal(await backend.invoke('openWebsite', { url: 'file:///tmp/unsafe', action: 'install' }), origin);
    assert.equal(await backend.invoke('openAdmin', { path: '/elsewhere' }), origin + '/admin');
  }
});

test('website opening rejects incomplete installations and unsafe configured URI schemes or credentials', async () => {
  const backend = new Backend('/unused', '/unused');
  for (const state of [{ installed: false }, { installed: true, phase: 'bootstrap-pending', access: { url: 'http://localhost' } }]) {
    backend.runtime = async () => state;
    await assert.rejects(backend.invoke('openWebsite'), /Complete installation/);
  }
  for (const address of ['file:///tmp/site', 'javascript:alert(1)', 'https://name:password@example.com', 'https://example.com/path', 'https://example.com?token=x', 'https://example.com/#fragment', 'not a url']) {
    backend.runtime = async () => ({ installed: true, phase: 'ready', access: { url: address } });
    await assert.rejects(backend.invoke('openAdmin'), /Installed website address is invalid/);
    assert.equal(backend.busy, false);
  }
});
