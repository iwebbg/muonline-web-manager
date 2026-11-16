import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { execute } from './process.js';
import { buildSqlReport, firewallScope, redactDiagnostic, validateSqlInput } from '../shared/sql-diagnostics.js';

const PYTHON_BOOT = "import sys,json,io; p=json.load(sys.stdin); sys.stdin=io.StringIO(json.dumps({'request':p['request'],'probe':p['probe']})); exec(compile(p['script'],'sql-troubleshooting','exec'),{'__name__':'__main__'})";
const WINDOWS_READ = "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; $payload=[Console]::In.ReadToEnd()|ConvertFrom-Json; & ([scriptblock]::Create($payload.script)) -InlineRequest ($payload.request|ConvertTo-Json -Depth 8 -Compress)";
const ELEVATE = "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; foreach($v in @($p.script,$p.request,$p.result)){if($v -match '[\"\r\n]'){throw 'Invalid path'}}; $a=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('\"'+$p.script+'\"'),'-RequestPath',('\"'+$p.request+'\"'),'-ResultPath',('\"'+$p.result+'\"')); $process=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $a -Verb RunAs -Wait -PassThru; exit $process.ExitCode";

/** Build PowerShell argv from trusted source only; user values belong in private stdin. */
export function encodedPowerShell(source) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
}

/** Measure one Windows socket without spawning a shell or transmitting credentials. */
export function windowsTcpProbe(host, port, createConnection = net.createConnection) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (ok, code) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve({ host, port, ok, ...(code ? { code } : {}) });
    };
    socket.setTimeout(3000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'tcpFailed'));
    socket.once('error', error => finish(false, ['ENOTFOUND', 'EAI_AGAIN'].includes(error.code) ? 'dns' : 'tcpFailed'));
  });
}

/** Retain only measured configuration relevant to a planned privileged change. */
function changeFingerprint(instance, scope) {
  return JSON.stringify({ id: instance.id, service: instance.service, pid: instance.pid, loginMode: instance.loginMode, tcp: instance.tcp, scope });
}

/** Own read-only diagnostics and separately previewed, expiring Windows mutation plans. */
export class SqlTroubleshooter {
  /** Allow process runners to be substituted by isolated contract tests. */
  constructor(resources, userData, runner = execute, tcpProbe = windowsTcpProbe) {
    this.resources = resources;
    this.userData = userData;
    this.runner = runner;
    this.tcpProbe = tcpProbe;
    this.plans = new Map();
  }

  /** Inventory the local machine without reading or persisting SQL passwords. */
  async windows(instance = '', loginNames = [], port = 1433) {
    const source = await readFile(path.join(this.resources, 'runtime/sql-windows.ps1'), 'utf8');
    const raw = await this.runner('powershell.exe', encodedPowerShell(WINDOWS_READ), JSON.stringify({ script: source, request: { operation: 'inventory', instance, loginNames, port } }), 60000);
    const response = JSON.parse(raw.trim());
    if (!response.ok) {
      throw new Error('Windows SQL inventory is unavailable.');
    }
    return response.result;
  }

  /** Invoke only the packaged diagnostic script; probe code and credentials stay on stdin. */
  async wsl(input, addresses = [], networkOnly = false) {
    const script = await readFile(path.join(this.resources, 'runtime/sql-troubleshooting.py'), 'utf8');
    const probe = networkOnly ? '' : await readFile(path.join(this.resources, 'runtime/sql-probe.php'), 'utf8');
    const raw = await this.runner('wsl.exe', ['-d', 'Ubuntu-24.04', '-u', 'root', '--exec', 'python3', '-c', PYTHON_BOOT], JSON.stringify({ script, probe, request: { ...input, windowsAddresses: addresses.slice(0, 8), networkOnly } }), 180000);
    const response = JSON.parse(raw.trim());
    if (!response.ok) {
      throw new Error('SQL troubleshooting could not inspect WSL. No credentials were logged.');
    }
    return response.result;
  }

  /** Expose instance choices and safe public runtime defaults before diagnosis. */
  async inspect() {
    const windows = await this.windows();
    const selected = windows.instances?.find(item => item.name === 'MSSQLSERVER') ?? (windows.instances?.length === 1 ? windows.instances[0] : null);
    return { instances: windows.instances ?? [], selectedInstance: selected?.name ?? '', addresses: windows.addresses ?? [] };
  }

  /** Run independent Windows, WSL and real-container-network checks and return safe facts. */
  async diagnose(input) {
    const target = validateSqlInput(input);
    let windows;
    let wsl;
    try {
      windows = await this.windows(target.instance, [target.appUsername, target.gameUsername, target.adminUsername, target.gameAdminUsername].filter(Boolean), target.port);
    } catch {
      windows = { error: 'windowsUnavailable', instances: [] };
    }
    try {
      wsl = await this.wsl(target, (windows.addresses ?? []).filter(item => !item.virtual).map(item => item.address));
    } catch {
      wsl = { error: 'wslUnavailable', steps: [] };
    }
    if (target.instance && wsl.loginNames?.length) {
      try {
        windows = await this.windows(target.instance, wsl.loginNames.filter(value => typeof value === 'string' && value.length <= 128).slice(0, 4), wsl.target?.port ?? target.port);
      } catch {
        // Retain the earlier safe facts if optional local metadata cannot be refreshed.
      }
    }
    if (target.useInstalled && wsl.target) {
      target.host = wsl.target.host;
      target.port = wsl.target.port;
    }
    const hosts = [...new Set(['127.0.0.1', ...(windows.addresses ?? []).filter(item => !item.virtual).map(item => item.address), ...(wsl.routes ?? []).map(route => route.gateway), target.host].filter(Boolean))].slice(0, 10);
    windows.probes = await Promise.all(hosts.map(host => this.tcpProbe(host, target.port)));
    const report = buildSqlReport(windows, wsl, target);
    const secrets = ['appPassword', 'gamePassword', 'adminPassword', 'gameAdminPassword'].map(key => target[key]);
    return redactDiagnostic(report, secrets);
  }

  /** Prepare a narrowly scoped action without changing services, registry or firewall. */
  async plan(input) {
    const target = validateSqlInput(input);
    const action = input.change;
    if (!['restart', 'mixedMode', 'tcpPort', 'firewall'].includes(action)) {
      throw new Error('Unsupported SQL change.');
    }
    const windows = await this.windows(target.instance, [], target.port);
    const instance = (windows.instances ?? []).find(item => item.name === target.instance);
    if (!instance) {
      throw new Error('Select a discovered SQL instance first.');
    }
    const registry = "HKLM:\\SOFTWARE\\" + (instance.view === 'Registry32' ? 'WOW6432Node\\' : '') + 'Microsoft\\Microsoft SQL Server\\' + instance.id + '\\MSSQLServer';
    let scope = null;
    let section = null;
    let command;
    let changes;
    let ruleName;
    if (['tcpPort', 'firewall'].includes(action) && (windows.listenerError || (windows.listeners ?? []).some(listener => listener.port === target.port && listener.pid !== instance.pid))) {
      throw new Error('Selected SQL port is owned by another process or could not be verified.');
    }
    if (action === 'restart') {
      command = "Restart-Service -Name '" + instance.service + "'";
      changes = [{ name: 'service', before: instance.state, after: 'Restart (disconnects active SQL sessions)' }];
    } else if (action === 'mixedMode') {
      command = "Set-ItemProperty -LiteralPath '" + registry + "' -Name LoginMode -Value 2";
      changes = [{ name: 'LoginMode', before: instance.loginMode, after: 2 }];
    } else if (action === 'tcpPort') {
      if ((windows.listeners ?? []).some(listener => listener.port === target.port && listener.pid !== instance.pid)) {
        throw new Error('Selected SQL port is owned by another process.');
      }
      const name = instance.tcp?.listenAll ? 'IPAll' : input.section;
      section = instance.tcp?.sections?.find(item => item.name === name && (name === 'IPAll' || item.enabled));
      if (!section) {
        throw new Error('Choose an enabled IP section when Listen All is No.');
      }
      command = "Set-ItemProperty -LiteralPath '" + registry + "\\SuperSocketNetLib\\Tcp' -Name Enabled -Value 1; Set-ItemProperty -LiteralPath '" + registry + '\\SuperSocketNetLib\\Tcp\\' + section.name + "' -Name TcpDynamicPorts -Value ''; Set-ItemProperty -LiteralPath '" + registry + '\\SuperSocketNetLib\\Tcp\\' + section.name + "' -Name TcpPort -Value '" + target.port + "'";
      changes = [{ name: 'TCP Enabled', before: instance.tcp.enabled, after: true }, { name: section.name + '.TcpDynamicPorts', before: section.dynamicPort, after: '' }, { name: section.name + '.TcpPort', before: section.port, after: String(target.port) }];
    } else {
      if (windows.firewallError || windows.firewallPartial) {
        throw new Error('Firewall rules could not be inspected. Retest before preparing a change.');
      }
      const wsl = await this.wsl(target, [], true);
      scope = firewallScope(windows, wsl, target.port);
      if ((windows.firewallRules ?? []).some(rule => rule.enabled && rule.localAddress === scope.localAddress && rule.remoteAddress === scope.remoteAddress && Number(rule.port) === scope.port && rule.action === 'Allow' && rule.direction === 'Inbound' && rule.profile === 'Any' && rule.program === 'Any' && rule.service === 'Any' && rule.managed !== true)) {
        throw new Error('An equivalent firewall rule already exists. Retest instead of adding a duplicate.');
      }
      ruleName = 'MuOnlineSql-' + createHash('sha256').update(JSON.stringify({ instance: instance.id, localAddress: scope.localAddress, remoteAddress: scope.remoteAddress, port: scope.port })).digest('hex').slice(0, 16);
      command = "New-NetFirewallRule -Name '" + ruleName + "' -DisplayName 'SQL Server " + target.port + " from WSL' -Group 'MuOnline Web Manager SQL' -Direction Inbound -Action Allow -Protocol TCP -LocalPort " + target.port + " -LocalAddress '" + scope.localAddress + "' -RemoteAddress '" + scope.remoteAddress + "' -Profile Any";
      const existing = (windows.firewallRules ?? []).find(rule => rule.name === ruleName);
      if (existing) {
        if (existing.localAddress !== scope.localAddress || existing.remoteAddress !== scope.remoteAddress || Number(existing.port) !== scope.port || existing.action !== 'Allow' || existing.direction !== 'Inbound' || !['TCP', '6'].includes(existing.protocol)) {
          throw new Error('Existing firewall rule does not match the previewed scope.');
        }
        command = (existing.enabled ? 'Get-NetFirewallRule' : 'Enable-NetFirewallRule') + " -Name '" + ruleName + "'";
      }
      changes = [{ name: 'Inbound TCP', before: existing ? { enabled: existing.enabled, localAddress: existing.localAddress, remoteAddress: existing.remoteAddress, port: existing.port } : null, after: { localAddress: scope.localAddress, remoteAddress: scope.remoteAddress, port: scope.port, enabled: true } }];
    }
    const id = randomUUID();
    const plan = { id, action, instance: instance.name, port: target.port, section: section?.name, scope, changes, command, restartRequired: ['tcpPort', 'mixedMode'].includes(action), disconnectsSessions: action === 'restart', expiresAt: Date.now() + 300000 };
    this.plans.set(id, { public: plan, expected: instance, expectedSection: section, ruleName, fingerprint: changeFingerprint(instance, scope) });
    for (const [key, item] of this.plans) {
      if (item.public.expiresAt < Date.now()) {
        this.plans.delete(key);
      }
    }
    return plan;
  }

  /** Apply only an explicitly confirmed server-owned plan after rechecking current measurements. */
  async apply(input) {
    const stored = this.plans.get(input.planId);
    if (input.confirmed !== true || !stored || stored.public.expiresAt < Date.now()) {
      throw new Error('SQL change needs a current preview and explicit confirmation.');
    }
    this.plans.delete(input.planId);
    const plan = stored.public;
    const windows = await this.windows(plan.instance, [], plan.port);
    const current = windows.instances.find(item => item.name === plan.instance);
    const scope = plan.action === 'firewall' ? firewallScope(windows, await this.wsl({ host: '', port: plan.port }, [], true), plan.port) : null;
    if (!current || changeFingerprint(current, scope) !== stored.fingerprint) {
      throw new Error('SQL configuration or WSL addresses changed. Retest and prepare a new preview.');
    }
    await mkdir(this.userData, { recursive: true });
    const folder = await mkdtemp(path.join(this.userData, 'sql-action-'));
    try {
      const script = path.join(folder, 'action.ps1');
      const request = path.join(folder, 'request.json');
      const result = path.join(folder, 'result.json');
      await writeFile(script, await readFile(path.join(this.resources, 'runtime/sql-windows.ps1')));
      await writeFile(request, JSON.stringify({ operation: 'change', action: plan.action, confirmed: true, instance: plan.instance, port: plan.port, section: plan.section, scope: plan.scope, ruleName: stored.ruleName, expected: stored.expected, expectedSection: stored.expectedSection }), { mode: 0o600 });
      await this.runner('powershell.exe', encodedPowerShell(ELEVATE), JSON.stringify({ script, request, result }), 120000);
      const response = JSON.parse(await readFile(result, 'utf8'));
      return { applied: response.ok === true, reason: response.code, changed: response.changed === true };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
}
