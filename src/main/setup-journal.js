import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { publicInstallationSettings } from '../shared/installation-settings.js';
export { publicInstallationSettings } from '../shared/installation-settings.js';

const stages = new Set(['windows', 'distribution', 'linux', 'linuxRestart', 'docker', 'keepalive', 'sqlNetwork', 'webNetwork', 'application', 'ready', 'uninstall']);
const statuses = new Set(['running', 'complete', 'failed', 'restartRequired']);

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
    if (value.restartBoot !== undefined && (typeof value.restartBoot !== 'string' || !/^\d{15,20}$/.test(value.restartBoot))) throw new Error('Installation progress could not be read. Recover installation.json before continuing.');
    if (value.schema !== 1 || value.distribution !== this.distribution) throw new Error('Installation progress belongs to another runtime.');
    return {
      ...empty,
      ...(stages.has(value.stage) ? { stage: value.stage } : {}),
      ...(statuses.has(value.status) ? { status: value.status } : {}),
      completed: Array.isArray(value.completed) ? value.completed.filter(stage => stages.has(stage)) : [],
      configuration: publicInstallationSettings(value.configuration),
      ...(value.restartBoot ? { restartBoot: value.restartBoot } : {}),
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
    const draft = publicInstallationSettings(input);
    const configuration = { ...state.configuration, ...draft };
    for (const key of ['access', 'administrator']) {
      if (draft[key]) configuration[key] = { ...state.configuration[key], ...draft[key] };
    }
    await this.write({ ...state, configuration });
  }

  /** Persist a restart boundary across manager closes; it is cleared only on a new boot. */
  async requireRestart(bootIdentity) {
    if (typeof bootIdentity !== 'string' || !/^\d{15,20}$/.test(bootIdentity)) throw new Error('Windows boot identity could not be verified.');
    await this.write({ ...await this.read(), restartBoot: bootIdentity, status: 'restartRequired' });
  }

  async clearRestart() {
    const state = await this.read();
    delete state.restartBoot;
    await this.write(state);
  }

  async resetRuntime() {
    const state = await this.read();
    await this.write({ schema: 1, distribution: this.distribution, completed: [], configuration: state.configuration, ...(state.restartBoot ? { restartBoot: state.restartBoot, stage: 'windows', status: 'restartRequired' } : {}) });
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
