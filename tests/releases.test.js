import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { authenticateManifest, newer, httpsUrl, checkRelease, downloadRelease } from '../src/main/releases.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const trust = { keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) } };
const artifact = { url: 'https://cdn.interweb.bg/muonline-web/releases/v1.3.0/application.zip', sha256: 'a'.repeat(64), size: 15 };
const manifest = { schema: 1, kind: 'web', version: '1.3.0', compatibility: { managerMin: '0.1.0', runtime: 'wsl2-docker-v1' }, profiles: ['real_registry_key'], artifacts: { application: artifact, vendor: { ...artifact, url: artifact.url.replace('application', 'vendor') } } };

/** Sign exact test bytes with an ephemeral key, never a production trust anchor. */
function signed(value = manifest) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, signature: { algorithm: 'Ed25519', keyId: 'test', signature: sign(null, bytes, privateKey).toString('base64') } };
}

test('authenticates exact manifest bytes and returns real profile keys', () => {
  const { bytes, signature } = signed();
  assert.deepEqual(authenticateManifest(bytes, signature, trust), manifest);
});
test('rejects tampering, unsigned checksums, unknown keys and wrong release kind', () => {
  const { bytes, signature } = signed();
  assert.throws(() => authenticateManifest(Buffer.from(bytes.toString().replace('1.3.0', '9.9.9')), signature, trust), /signature/);
  assert.throws(() => authenticateManifest(bytes, { ...signature, algorithm: 'SHA256' }, trust), /untrusted/);
  assert.throws(() => authenticateManifest(bytes, { ...signature, keyId: '__proto__' }, trust), /untrusted/);
  assert.throws(() => authenticateManifest(bytes, signature, { keys: {} }), /untrusted/);
  assert.throws(() => authenticateManifest(bytes, signature, trust, 'manager'), /manifest/);
});
test('refuses incompatible managers, malformed artifacts and insecure URLs even when signed', () => {
  for (const value of [
    { ...manifest, compatibility: { ...manifest.compatibility, managerMin: '1.0.0' } },
    { ...manifest, artifacts: { ...manifest.artifacts, application: { ...artifact, sha256: 'fake' } } },
    { ...manifest, artifacts: { ...manifest.artifacts, application: { ...artifact, url: 'http://example.com/app.zip' } } }
  ]) {
    const { bytes, signature } = signed(value);
    assert.throws(() => authenticateManifest(bytes, signature, trust));
  }
});
test('compares semantic versions and rejects downgrade or unstable inputs', () => {
  assert.equal(newer('1.10.0', '1.9.9'), true);
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('1.0.0', '2.0.0'), false);
  assert.throws(() => newer('1.0.0-beta', '1.0.0'));
  for (const url of ['http://host', 'https://user:pass@host', 'https://host?token=x', 'file:///secret']) {
    assert.throws(() => httpsUrl(url));
  }
});
test('uses alias without marketing bucket and reports empty/unpublished release feeds', async () => {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return new Response('', { status: 404 });
  };
  try {
    await assert.rejects(checkRelease({ cdn: 'https://cdn.interweb.bg', webChannel: 'muonline-web/releases/v1.3.0' }, trust), /not be published/);
    assert.equal(urls[0], 'https://cdn.interweb.bg/muonline-web/releases/v1.3.0/manifest.json');
    assert.ok(urls.every(url => !url.includes('marketing')));
  } finally {
    globalThis.fetch = original;
  }
});
test('downloads exact authenticated bytes and deletes corrupt staging data', async () => {
  const original = globalThis.fetch;
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mu-download-test-'));
  const payload = Buffer.from('production zip test');
  const release = { artifacts: { application: { url: 'https://cdn.example/app.zip', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') } } };
  globalThis.fetch = async () => new Response(payload);
  try {
    const paths = await downloadRelease(release, path.join(folder, 'valid'));
    assert.deepEqual(await readFile(paths.application), payload);
    release.artifacts.application.sha256 = '0'.repeat(64);
    await assert.rejects(downloadRelease(release, path.join(folder, 'invalid')), /checksum/);
    await assert.rejects(readFile(path.join(folder, 'invalid/application.zip')), /ENOENT/);
  } finally {
    globalThis.fetch = original;
    await rm(folder, { recursive: true, force: true });
  }
});
