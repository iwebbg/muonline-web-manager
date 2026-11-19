import { readFile, writeFile, rename, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execute, launchDetached } from './process.js';
import { DEFAULT_CDN, DEFAULT_CHANNEL, DEFAULT_REPOSITORY, MANAGER_VERSION, checkRelease, discoverWebRelease, downloadRelease, newer } from './releases.js';

import { encodedPowerShell, SqlTroubleshooter } from './sql-troubleshooting.js';
import { languages, resolveLocale } from '../shared/i18n.js';

import { productionProfile, developmentProfile, isWsl2Distribution } from './runtime-profile.js';
import { SetupJournal } from './setup-journal.js';
import { SupportLogs } from './support-logs.js';
const BOOTSTRAP = "import sys,json,io; p=json.load(sys.stdin); sys.stdin=io.StringIO(json.dumps(p['request'])); exec(compile(p['worker'],'muonline-worker','exec'),{'__name__':'__main__'})";

/** Own the desktop-to-WSL boundary and authenticated release lifecycle. */
export class Backend {
  /** Receive trusted resource paths from the main process only. */
  constructor(resources, userData, trustFile = path.join(resources, 'trust.json'), defaultLanguage = 'en', profile = productionProfile, runner = execute) {
    if (profile !== productionProfile && profile !== developmentProfile) throw new Error('Invalid runtime profile.');
    this.profile = profile;
    this.setup = new SetupJournal(userData, profile.distribution);
    this.supportLogs = new SupportLogs(userData);
    this.activeLog = null;
    this.logUnavailable = false;
    this.runner = (file, args, input, timeout) => runner(file, args, input, timeout, this.activeLog ? { onDiagnostics: async result => {
      await this.activeLog?.append('Process: ' + result.executable + ' / exit ' + result.code + '\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
    } } : null);
    this.resources = resources;
    this.userData = userData;
    this.trustFile = trustFile;
    this.language = resolveLocale(defaultLanguage);
    this.settings = { cdn: DEFAULT_CDN, webChannel: DEFAULT_CHANNEL, managerChannel: 'muonline-web/manager/stable', githubRepository: DEFAULT_REPOSITORY };
    this.webRelease = null;
    this.managerRelease = null;
    this.busy = false;
    this.sql = new SqlTroubleshooter(resources, userData, this.runner, undefined, profile);
    this.sqlReport = null;
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
    if (result.webChannel === 'muonline-web/releases/v1.3.0') {
      result.webChannel = DEFAULT_CHANNEL;
    }
    result.githubRepository = input.githubRepository ?? DEFAULT_REPOSITORY;
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(result.githubRepository) || result.githubRepository.includes('..')) {
      throw new Error('Invalid GitHub repository.');
    }
    for (const prefix of [result.webChannel.replaceAll('{version}', '1.0.0'), result.managerChannel]) {
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
    // A renderer field cannot enable diagnostic output for the normal/packaged runtime.
    const trustedRequest = { ...request, developmentDiagnostics: this.profile.development, recordDiagnostics: true };
    const output = await this.runner('wsl.exe', ['-d', this.profile.distribution, '-u', 'root', '--exec', 'python3', '-c', BOOTSTRAP], JSON.stringify({ worker, request: trustedRequest }));
    let response;
    try {
      response = JSON.parse(output.trim());
    } catch {
      throw new Error('WSL returned an invalid runtime response. Complete Ubuntu initialization and retry.');
    }
    if (!response.ok && typeof response.diagnostics === 'string' && !this.activeLog) {
      try { this.activeLog = await this.supportLogs.begin(request.action, request); } catch { this.logUnavailable = true; }
    }
    if (typeof response.diagnostics === 'string') await this.activeLog?.append(response.diagnostics);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  /** Prevent accidental privileged Linux execution during development. */
  requireWindows() {
    if (process.platform !== 'win32') {
      throw new Error('Runtime operations require Windows with WSL2. Linux development supports tests and the panel preview.');
    }
  }

  /** Resolve only the installed site's root or admin route; renderer URLs are never accepted. */
  async websiteUrl(administration = false) {
    const state = await this.runtime({ action: 'status' });
    if (!state?.installed || state.phase !== 'ready') {
      throw new Error('Complete installation and check website status first.');
    }
    try {
      const url = new URL(state.access?.url);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Invalid website address');
      }
      return url.origin + (administration ? '/admin' : '');
    } catch {
      throw new Error('Installed website address is invalid. Check access settings.');
    }
  }

  /** Detect WSL2, the fixed Ubuntu distribution and the root-controlled Docker daemon. */
  async prerequisites() {
    this.requireWindows();
    const version = await this.runner('wsl.exe', ['--version'], '', 30000);
    const distributions = await this.runner('wsl.exe', ['--list', '--verbose'], '', 30000);
    if (!isWsl2Distribution(distributions, this.profile.distribution)) {
      throw new Error(this.profile.development ? 'Create MuOnline-Dev with npm run dev:wsl:setup first.' : 'Ubuntu-24.04 must be installed and use WSL version 2. Run WSL setup, finish Ubuntu initialization and restart Windows if requested.');
    }
    return { wsl: version, distribution: this.profile.distribution, ...await this.runtime({ action: 'prerequisites' }) };
  }

  /** Install WSL through an explicit button; use the same resumable path as full Install. */
  async installWsl() {
    this.requireWindows();
    await this.ensureDistribution();
    await this.prepareLinux();
    return 'WSL2 and Linux account are ready. No Linux password is required by the manager.';
  }

  /** Request machine features only when inventory is unavailable; never change the default distro. */
  async ensureDistribution() {
    this.requireWindows();
    return this.setup.run('distribution', async () => {
      let distributions;
      let needsPreparation = false;
      try {
        distributions = await this.runner('wsl.exe', ['--list', '--quiet'], '', 30000);
        // Inbox WSL may list distros but reject modern install flags and --version.
        if (!this.profile.development) await this.runner('wsl.exe', ['--version'], '', 30000);
      } catch (error) {
        if (this.profile.development) throw error;
        needsPreparation = true;
      }
      if (needsPreparation) {
        await this.setup.run('windows', async () => {
          const preparation = (await readFile(path.join(this.resources, 'runtime', 'setup-windows-wsl.ps1'), 'utf8')).replaceAll('\r\n', '\n');
          const encoded = Buffer.from(preparation, 'utf16le').toString('base64');
          const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','" + encoded + "' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if($p.ExitCode -notin @(0,50,51,52,53,54,3010,1641)){exit $p.ExitCode}; @{restartRequired=($p.ExitCode -in @(3010,1641));failureCode=$p.ExitCode}|ConvertTo-Json -Compress";
          const result = JSON.parse((await this.runner('powershell.exe', encodedPowerShell(script), '', 900000)).trim());
          const failures = {
            50: 'Windows needs updating before the current WSL runtime can be installed. Update Windows, then click Install again. Existing distributions were retained.',
            51: 'The official WSL installer could not be downloaded. Check internet access and retry Install. Existing distributions were retained.',
            52: 'WSL installer verification failed. The package was not executed. Retry Install after checking Windows updates and network access.',
            53: 'The verified WSL installer did not complete. Check Windows Installer and retry Install. Existing distributions were retained.',
            54: 'WSL runtime was installed but its modern commands are not available yet. Restart Windows, then retry Install.'
          };
          if (failures[result.failureCode]) throw new Error(failures[result.failureCode]);
          if (result.restartRequired) {
            const restart = new Error('Restart Windows, then click Install again to continue. Installation progress has been saved.');
            restart.code = 'WSL_RESTART_REQUIRED';
            throw restart;
          }
        });
        // Empty WSL inventory can itself exit nonzero. Once machine features are ready,
        // install the fixed distro directly instead of repeating the failed empty listing.
        distributions ??= '';
      }
      const exists = distributions.replaceAll('\u0000', '').split(/\r?\n/).some(line => line.trim() === this.profile.distribution);
      if (!exists) {
        const args = ['--install', '-d', 'Ubuntu-24.04', ...(this.profile.development ? ['--name', this.profile.distribution] : []), '--no-launch'];
        await this.runner('wsl.exe', args, '', 900000);
      }
      const versions = await this.runner('wsl.exe', ['--list', '--verbose'], '', 30000);
      if (!isWsl2Distribution(versions, this.profile.distribution)) {
        await this.runner('wsl.exe', ['--set-version', this.profile.distribution, '2'], '', 900000);
      }
    });
  }

  /** Explicit root/exec avoids the interactive Ubuntu user wizard. Restart only this distro if needed. */
  async prepareLinux() {
    this.requireWindows();
    const prepared = await this.setup.run('linux', async () => {
      const script = (await readFile(path.join(this.resources, 'runtime', 'ensure-python.sh'), 'utf8')).replaceAll('\r\n', '\n');
      await this.runner('wsl.exe', ['-d', this.profile.distribution, '-u', 'root', '--exec', 'sh', '-s'], script);
      return this.runtime({ action: 'prepareWsl' });
    });
    if (prepared.restartRequired) {
      await this.setup.run('linuxRestart', async () => {
        await this.runner('wsl.exe', ['--terminate', this.profile.distribution], '', 60000);
        await this.runtime({ action: 'linuxStatus' });
      });
    }
    return prepared;
  }

  /** Re-measure every completed stage; retry an interrupted effect instead of trusting a stale checkpoint. */
  async ensureEnvironment() {
    await this.ensureDistribution();
    await this.prepareLinux();
    await this.setup.run('docker', async () => {
      try { await this.prerequisites(); } catch {
        await this.installDocker({ keepalive: false });
        await this.prerequisites();
      }
    });
    await this.setup.run('keepalive', () => this.ensureKeepalive());
  }

  /** One user action prepares the runtime, then installs/resumes the private WSL application phase. */
  async install(input = {}) {
    this.requireWindows();
    await this.setup.saveDraft(input.settings);
    const saved = await this.setup.read();
    const request = { settings: { ...saved.configuration, ...input.settings } };
    await this.ensureEnvironment();
    const result = await this.setup.run('application', async () => {
      const state = await this.runtime({ action: 'status' });
      if (state.installed) {
        if (state.phase === 'ready') return 'Installation is already complete.';
        if (!['bootstrap-pending', 'runtime-bootstrapped', 'administrator-created'].includes(state.phase)) {
          throw new Error('Installation requires manual recovery. Consult the recovery guide.');
        }
        return this.runtime({ action: 'resumeInstall', settings: request.settings });
      }
      return this.deploy('install', request);
    });
    await this.setup.run('ready', async () => {
      const state = await this.runtime({ action: 'status' });
      if (!state.installed || state.phase !== 'ready') throw new Error('Installation has not reached the ready phase. Retry Install to continue.');
    });
    return result;
  }

  /** Install Docker from its official Ubuntu repository, then register a user logon keepalive task. */
  async installDocker({ keepalive = true } = {}) {
    this.requireWindows();
    const distributions = await this.runner('wsl.exe', ['--list', '--verbose'], '', 30000);
    if (!isWsl2Distribution(distributions, this.profile.distribution)) {
      throw new Error('Initialize ' + this.profile.distribution + ' under WSL2 first.');
    }
    const script = (await readFile(path.join(this.resources, 'runtime', 'setup-docker.sh'), 'utf8')).replaceAll('\r\n', '\n');
    try {
      await this.runner('wsl.exe', ['-d', this.profile.distribution, '-u', 'root', '--exec', 'sh', '-s'], script);
    } catch (error) {
      throw new Error('Docker setup in ' + this.profile.distribution + ' failed. ' + error.message);
    }
    if (!keepalive) return 'Docker Engine setup completed.';
    try {
      await this.ensureKeepalive();
    } catch (error) {
      throw new Error('Docker setup completed, but the Windows keepalive task ' + this.profile.taskName + ' failed. ' + error.message);
    }
    return 'Docker installed. ' + this.profile.taskName + ' logon task keeps services alive when the panel closes.';
  }

  /** Keep WSL alive independently of the panel even when Docker was already installed. */
  async ensureKeepalive() {
    this.requireWindows();
    const script = await readFile(path.join(this.resources, 'runtime', this.profile.development ? 'keepalive-dev.ps1' : 'keepalive.ps1'), 'utf8');
    await this.runner('powershell.exe', encodedPowerShell(script), '', 60000);
  }

  /** Explicit irreversible removal of only the main-owned distro/task, never global WSL; SQL cleanup must finish before unregister. */
  async uninstallRuntime(input) {
    this.requireWindows();
    if (input?.confirmed !== true || input?.distributionConfirmation !== this.profile.distribution) {
      throw new Error('Confirm deletion by typing the exact WSL distribution name.');
    }
    await this.setup.run('uninstall', async () => {
      const list = await this.runner('wsl.exe', ['--list', '--quiet'], '', 30000);
      const exists = list.replaceAll('\u0000', '').split(/\r?\n/).some(line => line.trim() === this.profile.distribution);
      if (exists) {
        try { await this.activeLog?.append(await this.runtime({ action: 'runtimeLogs' })); }
        catch { await this.activeLog?.append('Existing WSL logs were unavailable before uninstall.'); }
        const cleanup = await this.runtime({ action: 'uninstallDatabase', sqlRemoval: input.sqlRemoval });
        if (cleanup?.ok !== true || !['uninstalled', 'not_installed'].includes(cleanup.code)) {
          const codes = new Set(['confirmation_required', 'invalid_input', 'target_mismatch', 'protected_database', 'protected_login', 'sysadmin_required', 'privileged_login', 'shared_login', 'shared_database', 'cannot_verify_shared_login', 'unverified_web_database', 'database_unavailable', 'sql_operation_failed', 'uninstall_failed', 'command_unavailable']);
          const statuses = new Set(['not_checked', 'retained', 'removed', 'already_absent', 'unknown']);
          const code = codes.has(cleanup?.code) ? cleanup.code : 'command_unavailable';
          const database = statuses.has(cleanup?.database) ? cleanup.database : 'unknown';
          const login = statuses.has(cleanup?.login) ? cleanup.login : 'unknown';
          throw new Error('SQL cleanup incomplete: code=' + code + '; database=' + database + '; login=' + login);
        }
      }
      const script = "$ErrorActionPreference='Stop'; $task=Get-ScheduledTask | Where-Object { $_.TaskName -eq '" + this.profile.taskName + "' -and $_.TaskPath -eq '\\' }; if($task){ $task | Stop-ScheduledTask; $task | Unregister-ScheduledTask -Confirm:$false }";
      await this.runner('powershell.exe', encodedPowerShell(script), '', 60000);
      if (exists) await this.runner('wsl.exe', ['--unregister', this.profile.distribution], '', 120000);
    });
    await this.setup.write({ schema: 1, distribution: this.profile.distribution, completed: [], configuration: {} });
    return { removed: true, distribution: this.profile.distribution };
  }

  /** Inspect the persisted WSL version; never invent an installed version in preview mode. */
  async installedApplication() {
    if (process.platform !== 'win32') {
      return { known: false, version: null };
    }
    try {
      const state = await this.runtime({ action: 'status' });
      return { known: true, version: state.installed ? state.version : null, phase: state.phase };
    } catch (error) {
      return { known: false, version: null, error: error.message };
    }
  }

  /** Refresh the latest tag and signed manifest without downloading or applying code. */
  async refreshWebRelease() {
    this.webRelease = null;
    const installed = await this.installedApplication();
    try {
      const result = await discoverWebRelease(this.settings, this.trust);
      const common = { latestVersion: result.latest.version, installedVersion: installed.version, installationKnown: installed.known, statusError: installed.error, newTag: installed.known && installed.version !== null && newer(result.latest.version, installed.version) };
      if (!result.manifest) {
        return { ...common, available: false, ready: false, error: result.error };
      }
      this.webRelease = result.manifest;
      return { ...common, version: result.manifest.version, profiles: result.manifest.profiles, ready: true, available: installed.known && installed.phase === 'ready' && installed.version !== null && newer(result.manifest.version, installed.version) };
    } catch (error) {
      return { installedVersion: installed.version, installationKnown: installed.known, ready: false, available: false, error: error.message };
    }
  }

  /** Check independent application/manager versions; applying updates always needs a button. */
  async updates() {
    const results = { web: await this.refreshWebRelease() };
    try {
      const manifest = await checkRelease(this.settings, this.trust, 'manager');
      this.managerRelease = manifest;
      results.manager = { version: manifest.version, available: newer(manifest.version, MANAGER_VERSION), ready: true };
    } catch (error) {
      this.managerRelease = null;
      results.manager = { available: false, ready: false, error: error.message };
    }
    return results;
  }

  /** Download authenticated artifacts, translate fixed local paths, and clean desktop staging afterward. */
  async deploy(action, input) {
    const candidate = await this.refreshWebRelease();
    const manifest = this.webRelease;
    if (!manifest || !candidate.ready) {
      throw new Error(candidate.error ?? 'Latest application release is not ready for installation.');
    }
    if (action === 'update' && !candidate.installationKnown) {
      throw new Error('Installed application version could not be determined.');
    }
    if (action === 'update' && !candidate.available) {
      throw new Error('No newer application version is available.');
    }
    await this.prerequisites();
    await this.ensureKeepalive();
    const folder = await mkdtemp(path.join(os.tmpdir(), 'muonline-release-'));
    try {
      const windowsPaths = await downloadRelease(manifest, folder);
      const paths = {};
      for (const [name, filename] of Object.entries(windowsPaths)) {
        paths[name] = (await this.runner('wsl.exe', ['-d', this.profile.distribution, '-u', 'root', '--exec', 'wslpath', '-u', filename], '', 30000)).trim();
      }
      return await this.runtime({ ...input, action, release: manifest, paths });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /** Download a signed manager installer and start it only after explicit Update. */
  async updateManager() {
    this.requireWindows();
    if (this.profile.development) throw new Error('Manager installer updates are disabled in dev mode.');
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
    // This read-only endpoint remains available while Install owns the mutation lock.
    if (action === 'setupStatus') return this.setup.read();
    if (this.busy) {
      throw new Error('Another operation is running. Wait for it to finish.');
    }
    this.busy = true;
    this.logUnavailable = false;
    const loggedActions = new Set(['install', 'resumeInstall', 'installWsl', 'installDocker', 'setGameWrites', 'uninstallRuntime', 'start', 'stop', 'restart', 'access', 'backup', 'update', 'admin', 'adminUpdate', 'adminDelete', 'sqlDiagnose', 'sqlApply']);
    if (loggedActions.has(action)) {
      try { this.activeLog = await this.supportLogs.begin(action, input); } catch { this.activeLog = null; this.logUnavailable = true; }
    }
    try {
      switch (action) {
        case 'uninstallRuntime':
          return await this.uninstallRuntime(input);
        case 'openLogs':
          await mkdir(this.supportLogs.directory, { recursive: true });
          return { logsDirectory: this.supportLogs.directory };
        case 'logs': {
          if (!this.activeLog) this.activeLog = await this.supportLogs.begin('logs', input);
          try { await this.activeLog.append(await this.runtime({ action: 'runtimeLogs' })); }
          catch (error) { await this.activeLog.append('Could not collect the current WSL snapshot: ' + error.message); }
          return { logsDirectory: this.supportLogs.directory };
        }
        case 'setGameWrites':
          if (typeof input.gameWrites?.enabled !== 'boolean' || input.gameWrites?.confirmed !== true || !['enabled', 'disabled', 'unknown'].includes(input.gameWrites?.expectedMode)) {
            throw new Error('Confirm the game write change and project restart.');
          }
          await this.ensureKeepalive();
          return await this.runtime({ action: 'setGameWrites', gameWrites: { enabled: input.gameWrites.enabled, confirmed: true, expectedMode: input.gameWrites.expectedMode } });
        case 'openWebsite':
          return await this.websiteUrl();
        case 'openAdmin':
          return await this.websiteUrl(true);
        case 'sqlInspect':
          this.requireWindows();
          return await this.sql.inspect();
        case 'sqlDiagnose':
          this.requireWindows();
          this.sqlReport = await this.sql.diagnose(input);
          return this.sqlReport;
        case 'sqlPlan':
          this.requireWindows();
          return await this.sql.plan(input);
        case 'sqlApply': {
          this.requireWindows();
          if (this.profile.development) throw new Error('Windows SQL changes are disabled in dev mode.');
          this.sqlReport = null;
          const result = await this.sql.apply(input);
          return result;
        }
        case 'sqlCopyReport':
          if (!this.sqlReport) {
            throw new Error('Run SQL troubleshooting before copying a report.');
          }
          return this.sqlReport;
        case 'sqlCopyPlan': {
          const stored = this.sql.plans.get(input.planId);
          if (!stored || stored.public.expiresAt < Date.now()) {
            throw new Error('SQL change needs a current preview and explicit confirmation.');
          }
          return stored.public.command;
        }
        case 'settings':
          return { ...this.settings, setup: await this.setup.read(), development: this.profile.development, distribution: this.profile.distribution, language: this.language, managerVersion: MANAGER_VERSION, trustedKeys: Object.keys(this.trust.keys) };
        case 'setLanguage':
          if (!languages.includes(input.language)) {
            throw new Error('Invalid language.');
          }
          await this.savePreferences(this.settings, input.language);
          this.language = input.language;
          return { language: this.language };
        case 'saveSettings': {
          const settings = this.validateSettings({ ...this.settings, ...input });
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
          await this.ensureEnvironment();
          return 'WSL2, Linux account, Docker and keepalive are ready.';
        case 'updates':
          return await this.updates();
        case 'install':
        case 'resumeInstall':
          return await this.install(input);
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
        case 'doctor':
        case 'admin':
        case 'adminList':
        case 'adminUpdate':
        case 'adminDelete':
        case 'access':
        case 'backup':
          return await this.runtime({ ...input, action });
        default:
          throw new Error('Unsupported manager operation.');
      }
    } catch (error) {
      try {
        if (!this.activeLog) this.activeLog = await this.supportLogs.begin(action, input);
        await this.activeLog.append('ERROR: ' + error.message);
        if (this.activeLog.failed) error.logUnavailable = true;
        else error.logFile = this.activeLog.file;
      } catch { error.logUnavailable = true; }
      throw error;
    } finally {
      if (this.activeLog) {
        try { await this.activeLog.append('Operation ended: ' + new Date().toISOString()); } catch { /* Preserve operation result. */ }
        this.logUnavailable ||= this.activeLog.failed;
      }
      this.activeLog = null;
      this.busy = false;
    }
  }
}
