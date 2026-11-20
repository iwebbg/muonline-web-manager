import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { encodedPowerShell } from './sql-troubleshooting.js';

const ELEVATE = `[Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; foreach($v in @($p.script,$p.request,$p.result)){if($v -match '["\\r\\n]'){throw 'Invalid path'}}; $a=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$p.script+'"'),'-RequestPath',('"'+$p.request+'"'),'-ResultPath',('"'+$p.result+'"')); $process=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $a -Verb RunAs -Wait -PassThru; exit $process.ExitCode`;

/** Prepare only fixed Windows web ports. Domain/SQL identities and credentials never enter elevation. */
export class WebNetwork {
  constructor(resources, userData, runner, profile) {
    this.resources = resources;
    this.runner = runner;
    this.profile = profile;
    this.marker = path.join(userData, 'web-network.json');
  }

  async read() {
    try {
      const saved = JSON.parse(await readFile(this.marker, 'utf8'));
      if (!['ip', 'domain'].includes(saved.mode)) throw new Error('Invalid web network state.');
      return { mode: saved.mode, pending: saved.pending === true };
    } catch (error) {
      if (error.code === 'ENOENT') return { mode: 'local' };
      throw error;
    }
  }

  /** Local installs never request network elevation; leaving public mode removes only owned rules. */
  async configure(access) {
    if (!['local', 'ip', 'domain'].includes(access?.mode)) throw new Error('Invalid web access mode.');
    const previous = await this.read();
    if (access.mode === 'local' && previous.mode === 'local') return { changed: false, previousMode: 'local' };
    // Journal intent before elevation so an interrupted change cannot become untracked.
    if (access.mode !== 'local') {
      await writeFile(this.marker + '.tmp', JSON.stringify({ mode: access.mode, pending: true }), { mode: 0o600 });
      await rename(this.marker + '.tmp', this.marker);
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-web-network-'));
    const request = path.join(directory, 'request.json');
    const resultPath = path.join(directory, 'result.json');
    try {
      // Public configuration only; never forward the caller's access object to an elevated file.
      await writeFile(request, JSON.stringify({ mode: access.mode, profile: this.profile.development ? 'development' : 'production' }), { mode: 0o600 });
      let processError;
      try {
        await this.runner('powershell.exe', encodedPowerShell(ELEVATE), JSON.stringify({ script: path.join(this.resources, 'runtime/web-network.ps1'), request, result: resultPath }), 180000);
      } catch (error) { processError = error; }
      let response;
      try { response = JSON.parse(await readFile(resultPath, 'utf8')); } catch {
        throw new Error('Windows web access setup did not complete. Accept the UAC request and inspect the support log before retrying.');
      }
      if (!response.ok || processError) throw new Error('Windows web access setup failed: ' + String(response.error ?? 'Check the support log.').slice(0, 600));
      if (!['local', 'ip', 'domain'].includes(response.result?.previousMode) || response.result.mode !== access.mode) throw new Error('Windows returned an invalid web network result.');
      if (access.mode === 'local') await rm(this.marker, { force: true });
      else {
        await writeFile(this.marker + '.tmp', JSON.stringify({ mode: access.mode }), { mode: 0o600 });
        await rename(this.marker + '.tmp', this.marker);
      }
      return response.result;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async refresh() {
    const access = await this.read();
    if (access.pending) throw new Error('Previous Windows web access setup is incomplete. Retry installation or Access settings before starting.');
    if (access.mode !== 'local') return this.configure(access);
    return { changed: false, previousMode: 'local' };
  }

  async restore(ticket) {
    if (ticket?.changed) await this.configure({ mode: ticket.previousMode });
  }
}
