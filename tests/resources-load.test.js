import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resourceConfiguration, decodeConfiguration, writeResourceConfiguration } from '../scripts/wsl-resources.js';
import { workload, runLoad } from '../scripts/load-test.js';

test('WSL limits preserve unrelated sections, comments and UTF-16 while rejecting duplicate settings', () => {
  const original = '# keep\r\n[wsl2]\r\nMemory = 8GB # existing\r\nnetworkingMode=mirrored\r\n[experimental]\r\nautoMemoryReclaim=gradual\r\n';
  const updated = resourceConfiguration(original);
  assert.match(updated, /Memory = 2GB # existing\r\n/);
  assert.match(updated, /networkingMode=mirrored\r\nprocessors=2\r\nswap=1GB\r\n\[experimental\]/);
  assert.ok(updated.includes('autoMemoryReclaim=gradual\r\n'));
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(original, 'utf16le')]);
  const decoded = decodeConfiguration(bytes);
  assert.deepEqual(decoded.encode(decoded.text), bytes);
  assert.equal(resourceConfiguration(updated), updated);
  assert.match(resourceConfiguration(''), /\[wsl2\]\nmemory=2GB\nprocessors=2\nswap=1GB\n/);
  for (const value of ['[wsl2]\nmemory=1GB\nMemory=2GB', '[wsl2]\n[WSL2]']) assert.throws(() => resourceConfiguration(value), /Duplicate/);
  assert.throws(() => resourceConfiguration('', { memory: 0 }), /Invalid/);
});

test('WSL apply keeps an exact backup and refuses stale previews', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mu-wsl-limits-'));
  try {
    const filename = path.join(directory, '.wslconfig');
    const original = Buffer.from('[wsl2]\r\nmemory=6GB\r\n');
    await writeFile(filename, original);
    const backup = await writeResourceConfiguration(filename, original, Buffer.from(resourceConfiguration(original.toString())));
    assert.deepEqual(await readFile(backup), original);
    assert.match(await readFile(filename, 'utf8'), /memory=2GB/);
    await assert.rejects(writeResourceConfiguration(filename, original, Buffer.from('bad')), /changed/);
    assert.equal(await writeResourceConfiguration(path.join(directory, 'new-config'), null, Buffer.from('new')), null);
    assert.equal(await readFile(path.join(directory, 'new-config'), 'utf8'), 'new');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('load validation rejects credential URLs, unsupported paths and unbounded concurrency', () => {
  for (const input of [
    { url: 'http://user:secret@localhost' }, { url: 'http://localhost/?token=secret' },
    { url: 'http://localhost', concurrency: 201 }, { url: 'http://localhost', paths: '/account/zen-bank' },
    { url: 'http://localhost', duration: 0 }, { url: 'ftp://localhost' }
  ]) assert.throws(() => workload(input));
});

/** Start only an ephemeral local fixture; no test reaches an installed site or database. */
async function fixture(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

test('burst attempts 200 concurrent public GET requests and reports failures without response contents', async () => {
  let requests = 0;
  const { server, url } = await fixture((req, res) => {
    assert.equal(req.method, 'GET');
    requests++;
    const status = requests % 2 === 0 ? 429 : 200;
    setTimeout(() => { res.writeHead(status); res.end('private fixture content'); }, 20);
  });
  try {
    const summary = await runLoad(workload({ url, mode: 'burst', concurrency: 200, paths: '/', duration: 2 }));
    assert.equal(summary.completed, 200);
    assert.equal(summary.peakInFlight, 200);
    assert.equal(summary.failed, 100);
    assert.equal(summary.httpStatuses['429'], 100);
    assert.equal(summary.routes['/'].requests, 200);
    assert.equal(JSON.stringify(summary).includes('private fixture content'), false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('stress clients retain separate cookies and never follow external redirects', async () => {
  let identity = 0;
  const identities = new Set();
  const { server, url } = await fixture((req, res) => {
    if (req.url === '/rankings') { res.writeHead(302, { Location: 'http://external.invalid/' }); res.end(); return; }
    if (req.headers.cookie) identities.add(req.headers.cookie);
    else res.setHeader('Set-Cookie', 'fixture_user=' + (++identity) + '; Path=/');
    res.end('ok');
  });
  try {
    const summary = await runLoad(workload({ url, mode: 'stress', concurrency: 3, paths: '/,/rankings', duration: 1, maxRequests: 30 }));
    assert.equal(summary.completed, 30);
    assert.ok(summary.httpStatuses['302'] > 0);
    assert.equal(identity, 3);
    assert.equal(identities.size, 3);
    assert.equal(summary.requestLimitReached, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('load requests time out and a pre-aborted run opens no connections', async () => {
  const { server, url } = await fixture(() => {});
  try {
    const summary = await runLoad(workload({ url, mode: 'burst', concurrency: 1, duration: 1, timeout: 1, paths: '/' }));
    assert.equal(summary.transportErrors.timeout, 1);
    assert.equal(summary.failed, 1);
    const controller = new AbortController();
    controller.abort();
    const stopped = await runLoad(workload({ url }), { signal: controller.signal });
    assert.equal(stopped.completed, 0);
    assert.equal(stopped.interrupted, true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
