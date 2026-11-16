import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export const MANAGER_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_CDN = 'https://cdn.interweb.bg';
export const DEFAULT_CHANNEL = 'muonline-web/releases/v1.3.0';

/** Require an HTTPS origin/path without embedded authentication or query parameters. */
export function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('A clean HTTPS URL is required.');
  }
  return url;
}

/** Compare stable semantic versions without lexicographical ordering mistakes. */
export function newer(version, installed) {
  const expression = /^\d+\.\d+\.\d+$/;
  if (!expression.test(version) || !expression.test(installed)) {
    throw new Error('Only stable major.minor.patch versions are accepted.');
  }
  const left = version.split('.').map(Number);
  const right = installed.split('.').map(Number);
  return left[0] > right[0] || (left[0] === right[0] && (left[1] > right[1] || (left[1] === right[1] && left[2] > right[2])));
}

/** Authenticate the exact manifest bytes using a build-pinned Ed25519 key before parsing. */
export function authenticateManifest(bytes, signature, trust, expectedKind = 'web') {
  if (bytes.length > 1024 * 1024 || signature.algorithm !== 'Ed25519' || !Object.hasOwn(trust.keys, signature.keyId)) {
    throw new Error('Release is unsigned or uses an untrusted signing key.');
  }
  const key = createPublicKey(trust.keys[signature.keyId]);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(signature.signature, 'base64'))) {
    throw new Error('Release manifest signature is invalid.');
  }
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== 1 || manifest.kind !== expectedKind || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Unsupported release manifest.');
  }
  const compatibility = manifest.compatibility;
  if (!compatibility || compatibility.runtime !== 'wsl2-docker-v1' || newer(compatibility.managerMin, MANAGER_VERSION)) {
    throw new Error('Release requires a different manager/runtime version.');
  }
  const required = expectedKind === 'web' ? ['application', 'vendor'] : ['installer'];
  for (const name of required) {
    const artifact = manifest.artifacts?.[name];
    if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > 2 * 1024 ** 3) {
      throw new Error('Invalid release artifact.');
    }
    httpsUrl(artifact.url);
  }
  if (expectedKind === 'web' && (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0 || manifest.profiles.some(profile => !/^[a-z][a-z0-9_]+$/.test(profile)))) {
    throw new Error('Release has no valid Laravel game registry.');
  }
  return manifest;
}

/** Fetch without redirects so a signed URL never silently changes its origin. */
async function fetchBounded(url, maximum) {
  const response = await fetch(httpsUrl(url), { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error('Release endpoint returned HTTP ' + response.status + '. Artifacts may not be published yet.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximum) {
      throw new Error('Release metadata is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Resolve a configurable feed and fetch its detached signature. */
export async function checkRelease(settings, trust, kind = 'web') {
  const base = httpsUrl(settings.cdn).href.replace(/\/$/, '');
  const prefix = kind === 'web' ? settings.webChannel : settings.managerChannel;
  if (!/^[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9/_-]+)*$/.test(prefix) || prefix.includes('..')) {
    throw new Error('Invalid release prefix.');
  }
  const url = base + '/' + prefix.replace(/^\/+|\/+$/g, '') + '/manifest.json';
  const [bytes, signature] = await Promise.all([
    fetchBounded(url, 1024 * 1024),
    fetchBounded(url + '.sig', 8192)
  ]);
  return authenticateManifest(bytes, JSON.parse(signature.toString('utf8')), trust, kind);
}

/** Stream each signed artifact to a private staging folder and enforce size and hash. */
export async function downloadRelease(manifest, folder) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const paths = {};
  try {
    for (const [name, artifact] of Object.entries(manifest.artifacts)) {
      if (!['application', 'vendor', 'installer'].includes(name)) {
        continue;
      }
      const destination = path.join(folder, name === 'installer' ? 'manager-setup.exe' : name + '.zip');
      const response = await fetch(httpsUrl(artifact.url), { redirect: 'error', signal: AbortSignal.timeout(600000) });
      if (!response.ok) {
        throw new Error('Artifact download failed: HTTP ' + response.status);
      }
      const digest = createHash('sha256');
      let count = 0;
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          count += chunk.length;
          if (count > artifact.size) {
            callback(new Error('Artifact exceeds signed size.'));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      if (count !== artifact.size || digest.digest('hex') !== artifact.sha256) {
        throw new Error('Artifact checksum mismatch.');
      }
      paths[name] = destination;
    }
    return paths;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
