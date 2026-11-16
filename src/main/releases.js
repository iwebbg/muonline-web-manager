import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export const MANAGER_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_CDN = 'https://cdn.interweb.bg';
export const DEFAULT_CHANNEL = 'muonline-web/releases/v{version}';
export const DEFAULT_REPOSITORY = 'iwebbg/muonline-web-laravel';

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

/** Accept stable SemVer tags with or without a leading v; ignore prereleases. */
export function versionFromTag(tag) {
  if (typeof tag !== 'string') {
    return null;
  }
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
  if (!match || match[1].split('.').some(part => !Number.isSafeInteger(Number(part)))) {
    return null;
  }
  return match[1];
}

/** Discover the highest stable GitHub tag without relying on API ordering or tag dates. */
export async function latestGithubTag(repository = DEFAULT_REPOSITORY) {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes('..')) {
    throw new Error('Invalid GitHub repository.');
  }
  let latest = null;
  for (let page = 1; page <= 10; page++) {
    const response = await fetch('https://api.github.com/repos/' + repository + '/tags?per_page=100&page=' + page, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'MuOnline-Web-Manager' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      throw new Error('GitHub tag check failed: HTTP ' + response.status);
    }
    const tags = JSON.parse((await readBoundedBody(response, 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(tags) || tags.length > 100 || tags.some(tag => !tag || typeof tag.name !== 'string')) {
      throw new Error('Invalid GitHub tag response.');
    }
    for (const tag of tags) {
      const version = versionFromTag(tag.name);
      if (version && (!latest || newer(version, latest.version))) {
        latest = { tag: tag.name, version };
      }
    }
    if (tags.length < 100) {
      if (!latest) {
        throw new Error('No stable application tag is available.');
      }
      return latest;
    }
  }
  throw new Error('GitHub tag list exceeds the discovery limit.');
}

/** Resolve only the newest tagged application and require the matching signed runtime. */
export async function discoverWebRelease(settings, trust) {
  const latest = await latestGithubTag(settings.githubRepository ?? DEFAULT_REPOSITORY);
  try {
    const manifest = await checkRelease(settings, trust, 'web', latest.version);
    if (manifest.version !== latest.version) {
      throw new Error('Signed release version does not match the latest GitHub tag.');
    }
    return { latest, manifest };
  } catch (error) {
    return { latest, error: error.message };
  }
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
  return readBoundedBody(response, maximum);
}

/** Bound JSON metadata before parsing it, including chunked responses. */
async function readBoundedBody(response, maximum) {
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
export async function checkRelease(settings, trust, kind = 'web', version = null) {
  const base = httpsUrl(settings.cdn).href.replace(/\/$/, '');
  let prefix = kind === 'web' ? settings.webChannel : settings.managerChannel;
  if (kind === 'web' && prefix.includes('{version}')) {
    if (versionFromTag(version) !== version) {
      throw new Error('A stable application version is required.');
    }
    prefix = prefix.replaceAll('{version}', version);
  }
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
