import { readFile } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';

const trust = JSON.parse(await readFile('build/trust.json', 'utf8'));
if (!trust.keys || Array.isArray(trust.keys) || typeof trust.keys !== 'object') {
  throw new Error('trust.json must contain a keys object.');
}
for (const [keyId, value] of Object.entries(trust.keys)) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) || typeof value !== 'string' || value.includes('PRIVATE KEY')) {
    throw new Error('Trust entries must be named public keys only.');
  }
  if (createPublicKey(value).asymmetricKeyType !== 'ed25519') {
    throw new Error('Trust keys must use Ed25519.');
  }
}
const count = Object.keys(trust.keys).length;
if (count === 0 && process.argv.includes('--require-key')) {
  throw new Error('A production installer requires at least one pinned release trust key.');
}
console.log(count ? 'Validated pinned Ed25519 public trust keys: ' + count : 'Review build: trust store is empty. Installation and updates will be blocked.');
