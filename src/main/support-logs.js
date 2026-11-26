import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Collect request secrets in memory only; never save request bodies, argv or stdin. */
export function secretValues(value, result = new Set()) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    const sensitive = /password|secret|token|key|client_id|webhook_id|mail_username|mail_url/i.test(key) || ['sqlAdmin', 'admin_username'].includes(key);
    if (sensitive && item && typeof item === 'object' && typeof item.value === 'string') result.add(item.value);
    if (typeof item === 'string' && item && sensitive) result.add(item);
    else if (item && typeof item === 'object') secretValues(item, result);
  }
  return result;
}

export function redactSupportText(value, secrets = new Set()) {
  let text = String(value ?? '');
  const variants = new Set();
  for (const secret of secrets) for (const variant of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), secret.replaceAll("'", "''"), Buffer.from(secret).toString('base64')]) variants.add(variant);
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) {
    if (secret.length < 4) text = text.replace(new RegExp('(?<!\\w)' + secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\w)', 'g'), '[REDACTED]');
    else text = text.replaceAll(secret, '[REDACTED]');
  }
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(password|pwd|token|secret|app_key)\b\s*(?:=>|=|:)\s*[^\r\n;,]+/gim, '$1=[REDACTED]');
}

/** Windows-local per-operation support files survive runtime uninstall. Bounded to 30 x 2 MiB. */
export class SupportLogs {
  constructor(userData) { this.directory = path.join(userData, 'logs'); }

  async begin(action, input = {}) {
    if (!/^[a-zA-Z]+$/.test(action)) action = 'operation';
    await mkdir(this.directory, { recursive: true });
    const filename = new Date().toISOString().replace(/[-:.Z]/g, '') + '-' + action + '-' + randomBytes(4).toString('hex') + '.log';
    const file = path.join(this.directory, filename);
    const secrets = secretValues(input);
    let content = '';
    const session = { file, failed: false, append: async value => {
      content = Buffer.from(content + redactSupportText(value, secrets) + '\n').subarray(-2 * 1024 * 1024).toString('utf8');
      try { await writeFile(file, content, { mode: 0o600 }); } catch { session.failed = true; }
    } };
    await session.append('MuOnline Web Manager support log\nAction: ' + action + '\nStarted: ' + new Date().toISOString());
    if (session.failed) throw new Error('Could not save the support log.');
    const entries = (await readdir(this.directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^\d{8}T\d{9}-[a-zA-Z]+-[a-f0-9]{8}\.log$/.test(entry.name)).map(entry => entry.name).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - 30))) await unlink(path.join(this.directory, old));
    return session;
  }
}
