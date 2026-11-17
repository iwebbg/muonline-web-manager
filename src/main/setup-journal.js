import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const stages = new Set(['windows', 'distribution', 'linux', 'linuxRestart', 'docker', 'keepalive', 'application', 'ready', 'uninstall']);
const statuses = new Set(['running', 'complete', 'failed', 'restartRequired']);

/** Persist only a bounded installation draft. Bootstrap identities/passwords are excluded. */
export function publicInstallationSettings(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const result = {};
  for (const key of ['sqlHost', 'sqlPort', 'profile', 'appEnv', 'gameDatabase', 'webDatabase', 'appLogin', 'gameLogin']) {
    if (typeof input[key] === 'string' && input[key].length <= 512) result[key] = input[key];
  }
  if (typeof input.trustCertificate === 'boolean') result.trustCertificate = input.trustCertificate;
  if (input.access && typeof input.access === 'object') {
    result.access = {};
    for (const key of ['mode', 'host', 'email']) {
      if (typeof input.access[key] === 'string' && input.access[key].length <= 512) result.access[key] = input.access[key];
    }
    if (typeof input.access.httpAcknowledged === 'boolean') result.access.httpAcknowledged = input.access.httpAcknowledged;
  }
  return result;
}

/** Desktop setup progress is independent of the private WSL application/SQL phase journal. */
export class SetupJournal {
  constructor(directory, distribution) {
    this.directory = directory;
    this.distribution = distribution;
    this.filename = path.join(directory, 'installation.json');
  }

  async read() {
    const empty = { schema: 1, distribution: this.distribution, completed: [], configuration: {} };
    let value;
    try { value = JSON.parse(await readFile(this.filename, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return empty;
      throw new Error('Installation progress could not be read. Recover installation.json before continuing.');
    }
    if (value.schema !== 1 || value.distribution !== this.distribution) throw new Error('Installation progress belongs to another runtime.');
    return {
      ...empty,
      ...(stages.has(value.stage) ? { stage: value.stage } : {}),
      ...(statuses.has(value.status) ? { status: value.status } : {}),
      completed: Array.isArray(value.completed) ? value.completed.filter(stage => stages.has(stage)) : [],
      configuration: publicInstallationSettings(value.configuration),
      ...(typeof value.linuxUser === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value.linuxUser) ? { linuxUser: value.linuxUser } : {})
    };
  }

  async write(value) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.filename + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(this.filename + '.tmp', this.filename);
  }

  async saveDraft(input) {
    const state = await this.read();
    await this.write({ ...state, configuration: { ...state.configuration, ...publicInstallationSettings(input) } });
  }

  async resetRuntime() {
    const state = await this.read();
    await this.write({ schema: 1, distribution: this.distribution, completed: [], configuration: state.configuration });
  }

  /** Journal before effects. Never save exception text, subprocess output or caller input. */
  async run(stage, operation) {
    if (!stages.has(stage)) throw new Error('Invalid setup stage.');
    const state = await this.read();
    await this.write({ ...state, stage, status: 'running' });
    let result;
    try {
      result = await operation();
    } catch (error) {
      const current = await this.read();
      await this.write({ ...current, stage, status: error.code === 'WSL_RESTART_REQUIRED' ? 'restartRequired' : 'failed' });
      throw error;
    }
    const current = await this.read();
    await this.write({ ...current, stage, status: 'complete', completed: [...new Set([...current.completed, stage])],
      ...(stage === 'linux' && /^[a-z_][a-z0-9_-]{0,31}$/.test(result?.linuxUser ?? '') ? { linuxUser: result.linuxUser } : {}) });
    return result;
  }
}
