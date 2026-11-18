/** Preview or explicitly apply global WSL2 limits without restarting any distribution. */
import { readFile, lstat, writeFile, copyFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Preserve unrelated INI settings/comments and reject ambiguous duplicate target settings. */
export function resourceConfiguration(content, { memory = 2, cpus = 2, swap = 1 } = {}) {
  for (const [value, min, max] of [[memory, 1, 32], [cpus, 1, 64], [swap, 0, 32]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid WSL resource limit.');
  }
  const values = { memory: memory + 'GB', processors: String(cpus), swap: swap + 'GB' };
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let section = '';
  let foundSection = false;
  let insertion = lines.length;
  const seen = new Set();
  for (let index = 0; index < lines.length; index++) {
    const heading = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(lines[index]);
    if (heading) {
      if (section === 'wsl2') insertion = index;
      section = heading[1].trim().toLowerCase();
      if (section === 'wsl2') {
        if (foundSection) throw new Error('Duplicate [wsl2] sections; resolve configuration manually.');
        foundSection = true;
        insertion = lines.length;
      }
      continue;
    }
    const setting = /^(\s*)([A-Za-z]+)(\s*=\s*)([^#;]*?)(\s*[#;].*)?$/.exec(lines[index]);
    if (section !== 'wsl2' || !setting) continue;
    const key = setting[2].toLowerCase();
    if (!Object.hasOwn(values, key)) continue;
    if (seen.has(key)) throw new Error('Duplicate WSL resource setting; resolve configuration manually.');
    seen.add(key);
    lines[index] = setting[1] + setting[2] + setting[3] + values[key] + (setting[5] ?? '');
  }
  if (!foundSection) {
    if (lines.at(-1) !== '') lines.push('');
    lines.push('[wsl2]');
    insertion = lines.length;
  }
  lines.splice(insertion, 0, ...Object.entries(values).filter(([key]) => !seen.has(key)).map(([key, value]) => key + '=' + value));
  return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}

/** Decode common Windows INI encodings and retain the original byte encoding on save. */
export function decodeConfiguration(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString('utf16le'), encode: text => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) };
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\u0000')) throw new Error('Unsupported WSL configuration encoding.');
  return { text, encode: text => Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text)]) };
}

/** Create an exact backup and atomically replace only the reviewed user's configuration file. */
export async function writeResourceConfiguration(filename, original, updated) {
  let metadata;
  try { metadata = await lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) throw new Error('WSL configuration must be a regular file.');
  const current = metadata ? await readFile(filename) : null;
  if ((current === null) !== (original === null) || (current && !current.equals(original))) throw new Error('WSL configuration changed since preview; retry.');
  const suffix = new Date().toISOString().replaceAll(':', '-') + '-' + randomBytes(4).toString('hex');
  const backup = metadata ? filename + '.before-muonline-' + suffix : null;
  if (backup) await copyFile(filename, backup, constants.COPYFILE_EXCL);
  const temporary = filename + '.tmp-' + suffix;
  try {
    await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
    const latest = metadata ? await readFile(filename) : null;
    if (latest && !latest.equals(original)) throw new Error('WSL configuration changed before save; retry.');
    // A new file uses exclusive creation so it cannot replace a concurrently created configuration.
    if (!metadata) await writeFile(filename, updated, { flag: 'wx', mode: 0o600 });
    else await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
  return backup;
}

/** Source-only Windows CLI; applying limits never invokes wsl --shutdown. */
async function main() {
  const { values } = parseArgs({ options: {
    apply: { type: 'boolean' }, 'confirm-global': { type: 'boolean' },
    'memory-gb': { type: 'string', default: '2' }, cpus: { type: 'string', default: '2' },
    'swap-gb': { type: 'string', default: '1' }
  } });
  if (process.platform !== 'win32') throw new Error('Run this resource configuration command on Windows.');
  const filename = path.join(os.homedir(), '.wslconfig');
  let original = null;
  try { original = await readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const decoded = decodeConfiguration(original ?? Buffer.alloc(0));
  const proposed = resourceConfiguration(decoded.text, { memory: Number(values['memory-gb']), cpus: Number(values.cpus), swap: Number(values['swap-gb']) });
  const updated = decoded.encode(proposed);
  console.log('GLOBAL WSL2 settings: affects every WSL2 distribution for this Windows user.');
  console.log('Proposed limits: RAM=' + values['memory-gb'] + 'GB; CPUs=' + values.cpus + '; disk swap=' + values['swap-gb'] + 'GB.');
  console.log('Unrelated settings are retained. No automatic WSL shutdown or restart.');
  if (!values.apply) { console.log('Preview only. Apply with --apply --confirm-global before first WSL startup, or restart WSL manually during planned downtime.'); return; }
  if (!values['confirm-global']) throw new Error('Applying requires --confirm-global because all WSL2 distributions are affected.');
  if (original?.equals(updated)) { console.log('Limits already configured.'); return; }
  const backup = await writeResourceConfiguration(filename, original, updated);
  console.log('Saved: ' + filename);
  if (backup) console.log('Exact previous configuration backup: ' + backup);
  console.log('Limits take effect on the next full WSL2 VM startup. Running instances were not interrupted.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
