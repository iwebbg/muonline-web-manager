import { readFile, writeFile, rename, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execute, launchDetached } from './process.js';
import { DEFAULT_CDN, DEFAULT_CHANNEL, MANAGER_VERSION, checkRelease, downloadRelease, newer } from './releases.js';

import { languages, resolveLocale } from '../shared/i18n.js';

const DISTRIBUTION = 'Ubuntu-24.04';
const BOOTSTRAP = "import sys,json,io; p=json.load(sys.stdin); sys.stdin=io.StringIO(json.dumps(p['request'])); exec(compile(p['worker'],'muonline-worker','exec'),{'__name__':'__main__'})";

/** Own the desktop-to-WSL boundary and authenticated release lifecycle. */
export class Backend {
  /** Receive trusted resource paths from the main process only. */
  constructor(resources, userData, trustFile = path.join(resources, 'trust.json'), defaultLanguage = 'en') {
    this.resources = resources;
    this.userData = userData;
    this.trustFile = trustFile;
    this.language = resolveLocale(defaultLanguage);
    this.settings = { cdn: DEFAULT_CDN, webChannel: DEFAULT_CHANNEL, managerChannel: 'muonline-web/manager/stable' };
    this.webRelease = null;
    this.managerRelease = null;
    this.busy = false;
  }

  /** Read public feed settings without storing SQL or administrator credentials. */
  async initialize() {
    await mkdir(this.userData, { recursive: true });
    try {
      const stored = JSON.parse(await readFile(path.join(this.userData, 'settings.json'), 'utf8'));
      this.settings = this.validateSettings(stored);
      if (languages.includes(stored.language)) {
        this.language = stored.language;
      }
    } catch {
      // Missing or invalid settings fall back to the documented public CDN.
    }
    this.trust = JSON.parse(await readFile(this.trustFile, 'utf8'));
  }

  /** Allow only bounded release endpoint settings to cross IPC. */
  validateSettings(input) {
    const result = {};
    for (const key of ['cdn', 'webChannel', 'managerChannel']) {
      if (typeof input[key] !== 'string' || input[key].length < 1 || input[key].length > 512 || /[\x00-\x20]/.test(input[key])) {
        throw new Error('Invalid feed settings.');
      }
      result[key] = input[key];
    }
    const url = new URL(result.cdn);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
      throw new Error('CDN must use HTTPS without credentials.');
    }
    for (const prefix of [result.webChannel, result.managerChannel]) {
      if (!/^[a-zA-Z0-9/_.-]+$/.test(prefix) || prefix.includes('..')) {
        throw new Error('Invalid release channel prefix.');
      }
    }
    return result;
  }

  /** Persist public preferences atomically without SQL or administrator credentials. */
  async savePreferences(settings = this.settings, language = this.language) {
    const filename = path.join(this.userData, 'settings.json');
    const temporary = filename + '.tmp';
    await writeFile(temporary, JSON.stringify({ ...settings, language }, null, 2), { mode: 0o600 });
    await rename(temporary, filename);
  }

  /** Run the packaged Python worker with private JSON stdin and fixed WSL arguments. */
  async runtime(request) {
    this.requireWindows();
    const worker = await readFile(path.join(this.resources, 'runtime', 'worker.py'), 'utf8');
    const output = await execute('wsl.exe', ['-d', DISTRIBUTION, '-u', 'root', '--exec', 'python3', '-c', BOOTSTRAP], JSON.stringify({ worker, request }));
    let response;
    try {
      response = JSON.parse(output.trim());
    } catch {
      throw new Error('WSL returned an invalid runtime response. Complete Ubuntu initialization and retry.');
    }
    if (!response.ok) {
      throw new Error(response.error);
    }
    return response.result;
  }

  /** Prevent accidental privileged Linux execution during development. */
  requireWindows() {
    if (process.platform !== 'win32') {
      throw new Error('Runtime operations require Windows with WSL2. Linux development supports tests and the panel preview.');
    }
  }

  /** Detect WSL2, the fixed Ubuntu distribution and the root-controlled Docker daemon. */
  async prerequisites() {
    this.requireWindows();
    const version = await execute('wsl.exe', ['--version'], '', 30000);
    const distributions = await execute('wsl.exe', ['--list', '--verbose'], '', 30000);
    const line = distributions.split('\n').find(value => value.includes(DISTRIBUTION));
    if (!line || !/\s2\s*$/.test(line.trim())) {
      throw new Error('Ubuntu-24.04 must be installed and use WSL version 2. Run WSL setup, finish Ubuntu initialization and restart Windows if requested.');
    }
    return { wsl: version, distribution: DISTRIBUTION, ...await this.runtime({ action: 'prerequisites' }) };
  }

  /** Install WSL through an explicit button with Windows elevation and no user script input. */
  async installWsl() {
    this.requireWindows();
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p = Start-Process -FilePath wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"], '', 900000);
    try {
      await execute('wsl.exe', ['--set-default-version', '2'], '', 60000);
      await execute('wsl.exe', ['--install', '-d', DISTRIBUTION, '--no-launch'], '', 900000);
    } catch {
      return 'WSL features requested. Restart Windows if required, then run WSL setup again to install Ubuntu-24.04 for this Windows user.';
    }
    return 'WSL2 and Ubuntu installation requested for this user. Launch Ubuntu-24.04 once to finish initialization, then check prerequisites.';
  }

  /** Install Docker from its official Ubuntu repository, then register a user logon keepalive task. */
  async installDocker() {
    this.requireWindows();
    const distributions = await execute('wsl.exe', ['--list', '--verbose'], '', 30000);
    const line = distributions.split('\n').find(value => value.includes(DISTRIBUTION));
    if (!line || !/\s2\s*$/.test(line.trim())) {
      throw new Error('Initialize Ubuntu-24.04 under WSL2 first.');
    }
    const script = await readFile(path.join(this.resources, 'runtime', 'setup-docker.sh'), 'utf8');
    await execute('wsl.exe', ['-d', DISTRIBUTION, '-u', 'root', '--exec', 'sh', '-s'], script);
    await this.ensureKeepalive();
    return 'Docker installed. MuOnline-Web-WSL logon task keeps services alive when the panel closes.';
  }

  /** Keep WSL alive independently of the panel even when Docker was already installed. */
  async ensureKeepalive() {
    this.requireWindows();
    const script = await readFile(path.join(this.resources, 'runtime', 'keepalive.ps1'), 'utf8');
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], script, 60000);
  }

  /** Check separate web and manager feeds; never download or apply automatically. */
  async updates() {
    const results = {};
    for (const kind of ['web', 'manager']) {
      try {
        const manifest = await checkRelease(this.settings, this.trust, kind);
        this[kind + 'Release'] = manifest;
        results[kind] = { version: manifest.version, profiles: manifest.profiles ?? [], available: kind === 'manager' ? newer(manifest.version, MANAGER_VERSION) : true };
      } catch (error) {
        this[kind + 'Release'] = null;
        results[kind] = { error: error.message };
      }
    }
    return results;
  }

  /** Download authenticated artifacts, translate fixed local paths, and clean desktop staging afterward. */
  async deploy(action, input) {
    const manifest = this.webRelease;
    if (!manifest) {
      throw new Error('Check the signed web release feed before installing or updating.');
    }
    await this.prerequisites();
    await this.ensureKeepalive();
    const folder = await mkdtemp(path.join(os.tmpdir(), 'muonline-release-'));
    try {
      const windowsPaths = await downloadRelease(manifest, folder);
      const paths = {};
      for (const [name, filename] of Object.entries(windowsPaths)) {
        paths[name] = (await execute('wsl.exe', ['-d', DISTRIBUTION, '--exec', 'wslpath', '-u', filename], '', 30000)).trim();
      }
      return await this.runtime({ ...input, action, release: manifest, paths });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /** Download a signed manager installer and start it only after explicit Update. */
  async updateManager() {
    this.requireWindows();
    if (!this.managerRelease || !newer(this.managerRelease.version, MANAGER_VERSION)) {
      throw new Error('No authenticated newer manager release is available.');
    }
    const folder = await mkdtemp(path.join(this.userData, 'manager-update-'));
    const paths = await downloadRelease(this.managerRelease, folder);
    // NSIS owns UAC and replacement. The runtime remains independently managed in WSL.
    await launchDetached(paths.installer);
    return 'Verified manager installer launched. The panel will close; WSL services continue.';
  }

  /** Serialize mutations and reject any operation absent from the IPC allow-list. */
  async invoke(action, input = {}) {
    if (this.busy) {
      throw new Error('Another operation is running. Wait for it to finish.');
    }
    this.busy = true;
    try {
      switch (action) {
        case 'settings':
          return { ...this.settings, language: this.language, managerVersion: MANAGER_VERSION, trustedKeys: Object.keys(this.trust.keys) };
        case 'setLanguage':
          if (!languages.includes(input.language)) {
            throw new Error('Invalid language.');
          }
          await this.savePreferences(this.settings, input.language);
          this.language = input.language;
          return { language: this.language };
        case 'saveSettings': {
          const settings = this.validateSettings(input);
          await this.savePreferences(settings);
          this.settings = settings;
          this.webRelease = null;
          this.managerRelease = null;
          return 'Feed settings saved.';
        }
        case 'prerequisites':
          return await this.prerequisites();
        case 'installWsl':
          return await this.installWsl();
        case 'installDocker':
          return await this.installDocker();
        case 'updates':
          return await this.updates();
        case 'install':
        case 'update':
          return await this.deploy(action, input);
        case 'updateManager':
          return await this.updateManager();
        case 'start':
          await this.ensureKeepalive();
          return await this.runtime({ ...input, action });
        case 'status':
        case 'stop':
        case 'restart':
        case 'logs':
        case 'doctor':
        case 'admin':
        case 'access':
        case 'backup':
        case 'resumeInstall':
          return await this.runtime({ ...input, action });
        default:
          throw new Error('Unsupported manager operation.');
      }
    } finally {
      this.busy = false;
    }
  }
}
