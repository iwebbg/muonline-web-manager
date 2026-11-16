import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { httpsUrl } from '../src/main/releases.js';

const [installer, version, base = 'https://cdn.interweb.bg'] = process.argv.slice(2);
if (!installer || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Usage: node scripts/manager-manifest.js installer.exe version [cdn-base]');
}
httpsUrl(base);
const manifest = {
  schema: 1,
  kind: 'manager',
  version,
  compatibility: { managerMin: '0.1.0', runtime: 'wsl2-docker-v1' },
  artifacts: { installer: { url: base.replace(/\/$/, '') + '/muonline-web/manager/v' + version + '/' + path.basename(installer), sha256: createHash('sha256').update(await readFile(installer)).digest('hex'), size: (await stat(installer)).size } }
};
await writeFile(path.join(path.dirname(installer), 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Unsigned manager manifest created. Sign it before distribution.');
