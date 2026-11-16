import { readFile, writeFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';

const filename = process.argv[2];
const keyId = process.env.RELEASE_KEY_ID;
const keyFile = process.env.RELEASE_SIGNING_KEY_FILE;
if (!filename || !keyId || !keyFile || !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)) {
  throw new Error('Usage: RELEASE_KEY_ID=id RELEASE_SIGNING_KEY_FILE=/private/key.pem node scripts/sign-manifest.js manifest.json');
}
const key = createPrivateKey(await readFile(keyFile));
if (key.asymmetricKeyType !== 'ed25519') {
  throw new Error('Release signing requires an Ed25519 key.');
}
const bytes = await readFile(filename);
JSON.parse(bytes.toString('utf8'));
const signature = sign(null, bytes, key).toString('base64');
await writeFile(filename + '.sig', JSON.stringify({ algorithm: 'Ed25519', keyId, signature }, null, 2) + '\n');
console.log('Detached Ed25519 signature written. Manifest bytes must remain unchanged.');
