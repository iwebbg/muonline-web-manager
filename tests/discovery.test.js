import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { versionFromTag, latestGithubTag, discoverWebRelease, DEFAULT_CHANNEL } from '../src/main/releases.js';
import { Backend } from '../src/main/backend.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const trust = { keys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) } };
const settings = { cdn: 'https://cdn.example', webChannel: DEFAULT_CHANNEL, managerChannel: 'manager/stable', githubRepository: 'iwebbg/muonline-web-laravel' };

/** Build signed fixture manifests so discovery tests cross the real trust boundary. */
function manifestResponse(url, version = '1.4.0', tamper = false) {
  const manager = String(url).includes('/manager/');
  const artifact = { url: 'https://cdn.example/artifact.zip', size: 12, sha256: 'a'.repeat(64) };
  const manifest = { schema: 1, kind: manager ? 'manager' : 'web', version, compatibility: { managerMin: '0.1.0', runtime: 'wsl2-docker-v1' }, profiles: ['registry_profile'], artifacts: manager ? { installer: artifact } : { application: artifact, vendor: artifact } };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = { keyId: 'fixture', algorithm: 'Ed25519', signature: sign(null, bytes, privateKey).toString('base64') };
  return new Response(String(url).endsWith('.sig') ? JSON.stringify({ ...signature, signature: tamper ? Buffer.alloc(64).toString('base64') : signature.signature }) : bytes);
}

/** Restore fetch after every isolated network scenario. */
async function network(fetcher, operation) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    await operation();
  } finally {
    globalThis.fetch = original;
  }
}

test('stable tags accept v1.4.0 and 1.4.0 and ignore prereleases or ambiguous versions', () => {
  assert.equal(versionFromTag('v1.4.0'), '1.4.0');
  assert.equal(versionFromTag('1.4.0'), '1.4.0');
  for (const tag of ['main', 'v1.4.0-beta', 'v01.4.0', 'v1.4', '../1.4.0', '99999999999999999999.0.0']) {
    assert.equal(versionFromTag(tag), null);
  }
});

test('scans paginated tags and chooses semantic maximum rather than first or lexicographic maximum', async () => {
  const urls = [];
  await network(async url => {
    urls.push(String(url));
    return Response.json(urls.length === 1 ? Array.from({ length: 100 }, () => ({ name: 'v1.9.0' })) : [{ name: '1.10.0' }, { name: 'v2.0.0-beta' }]);
  }, async () => {
    assert.deepEqual(await latestGithubTag(), { tag: '1.10.0', version: '1.10.0' });
    assert.match(urls[1], /page=2$/);
    assert.ok(urls.every(url => url.startsWith('https://api.github.com/repos/iwebbg/muonline-web-laravel/tags?')));
  });
});

test('latest tag resolves automatically to its versioned CDN directory and exact signed version', async () => {
  const urls = [];
  await network(async url => {
    urls.push(String(url));
    return String(url).includes('api.github.com') ? Response.json([{ name: 'v1.3.0' }, { name: '1.4.0' }]) : manifestResponse(url);
  }, async () => {
    const found = await discoverWebRelease(settings, trust);
    assert.equal(found.manifest.version, '1.4.0');
    assert.ok(urls.includes('https://cdn.example/muonline-web/releases/v1.4.0/manifest.json'));
    assert.ok(urls.includes('https://cdn.example/muonline-web/releases/v1.4.0/manifest.json.sig'));
  });
});

test('an unpublished, incompatible or invalidly signed latest tag never falls back to an old release', async () => {
  for (const scenario of ['missing', 'wrong-version', 'bad-signature']) {
    const urls = [];
    await network(async url => {
      urls.push(String(url));
      if (String(url).includes('api.github.com')) {
        return Response.json([{ name: 'v1.3.0' }, { name: 'v1.4.0' }]);
      }
      if (scenario === 'missing') {
        return new Response('', { status: 404 });
      }
      return manifestResponse(url, scenario === 'wrong-version' ? '1.3.0' : '1.4.0', scenario === 'bad-signature');
    }, async () => {
      const found = await discoverWebRelease(settings, trust);
      assert.equal(found.latest.version, '1.4.0');
      assert.equal(found.manifest, undefined);
      assert.ok(found.error);
      assert.ok(!urls.some(url => url.includes('/v1.3.0/')));
    });
  }
});

test('GitHub outages, private repositories and malformed tag data fail explicitly', async () => {
  for (const response of [new Response('', { status: 403 }), new Response('', { status: 404 }), Response.json({ message: 'invalid' }), Response.json([{ name: 'v2.0.0-beta' }])]) {
    await network(async () => response, async () => {
      await assert.rejects(latestGithubTag());
    });
  }
  await assert.rejects(latestGithubTag('https://untrusted.example/repo'), /Invalid GitHub/);
});

test('compares signed latest version against persisted installed version, clearing stale candidates on failure', async () => {
  const backend = new Backend('/unused', '/unused');
  backend.settings = settings;
  backend.trust = trust;
  let installedVersion = '1.3.0';
  backend.installedApplication = async () => ({ known: true, version: installedVersion, phase: 'ready' });
  await network(async url => String(url).includes('api.github.com') ? Response.json([{ name: 'v1.4.0' }]) : manifestResponse(url), async () => {
    assert.equal((await backend.updates()).web.available, true);
    installedVersion = '1.4.0';
    const result = await backend.updates();
    assert.equal(result.web.available, false);
    assert.equal(result.web.installedVersion, '1.4.0');
    assert.equal(result.web.ready, true);
  });
  await network(async () => new Response('', { status: 403 }), async () => {
    const result = await backend.updates();
    assert.equal(result.web.available, false);
    assert.equal(backend.webRelease, null);
  });
});

test('first install discovers again on click and never requires a manually checked feed', async () => {
  const backend = new Backend('/unused', '/unused');
  backend.settings = settings;
  backend.trust = trust;
  backend.installedApplication = async () => ({ known: true, version: null });
  let checked = false;
  backend.prerequisites = async () => { checked = true; throw new Error('stop-before-download'); };
  await network(async url => String(url).includes('api.github.com') ? Response.json([{ name: 'v1.4.0' }]) : manifestResponse(url), async () => {
    await assert.rejects(backend.deploy('install', { settings: {} }), /stop-before-download/);
    assert.equal(checked, true);
    assert.equal(backend.webRelease.version, '1.4.0');
  });
});

test('old fixed 1.3.0 preferences migrate automatically and CDN-only saves retain discovery', () => {
  const backend = new Backend('/unused', '/unused');
  const migrated = backend.validateSettings({ cdn: 'https://cdn.example', webChannel: 'muonline-web/releases/v1.3.0', managerChannel: 'manager/stable' });
  assert.equal(migrated.webChannel, DEFAULT_CHANNEL);
  assert.equal(migrated.githubRepository, 'iwebbg/muonline-web-laravel');
});
