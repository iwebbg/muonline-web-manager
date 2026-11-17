import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Backend } from '../src/main/backend.js';
import { discoverWebRelease, downloadRelease } from '../src/main/releases.js';

// Read public dev feed preferences only. Never initialize WSL, execute archives or publish files.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = new Backend(root, 'unused');
let folder;
try {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const preferences = path.join(process.env.APPDATA, 'MuOnline-Web-Manager-Dev', 'settings.json');
    try {
      backend.settings = backend.validateSettings({ ...backend.settings, ...JSON.parse(await readFile(preferences, 'utf8')) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  console.log('Checking latest stable release through the configured CDN...');
  const trust = JSON.parse(await readFile(path.join(root, 'build/trust.json'), 'utf8'));
  const release = await discoverWebRelease(backend.settings, trust);
  if (!release.manifest) throw new Error(release.error);
  console.log('PASS: manifest signature and latest version ' + release.manifest.version);
  folder = await mkdtemp(path.join(os.tmpdir(), 'muonline-cdn-verification-'));
  for (const name of ['application', 'vendor']) {
    console.log('Downloading and checking ' + name + '.zip...');
    try {
      await downloadRelease({ artifacts: { [name]: release.manifest.artifacts[name] } }, path.join(folder, name));
    } catch (error) {
      throw new Error(name + '.zip: ' + error.message);
    }
    console.log('PASS: ' + name + '.zip size and SHA256 match the signed manifest.');
  }
  console.log('CDN verification passed. No WSL, SQL or installation changes were made.');
} catch (error) {
  console.error('FAIL: ' + error.message + (error.cause?.code ? ' (' + error.cause.code + ')' : ''));
  process.exitCode = 1;
} finally {
  if (folder) await rm(folder, { recursive: true, force: true });
}
