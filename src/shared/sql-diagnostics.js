/** Stable diagnostic categories. Raw driver exceptions never belong in reports. */
export function classifySqlError(value) {
  const message = String(value?.message ?? value ?? '').toLowerCase();
  const native = Number(value?.nativeCode ?? value?.number ?? 0);
  if (/ee certificate key too weak|legacy sigalg|no suitable signature algorithm|unsupported protocol|tlsv1 alert protocol version|dh key too small/.test(message)) {
    return { category: 'tls', reason: 'legacyTls' };
  }
  if (/certificate verify failed|self.signed|certificate chain|certificate.*not trusted|unable to get local issuer|hostname.*mismatch|target principal name is incorrect/.test(message)) {
    return { category: 'tls', reason: 'certificate' };
  }
  if (/ssl provider|tls handshake|pre.login handshake/.test(message)) {
    return { category: 'tls', reason: 'tlsHandshake' };
  }
  if ([4060, 916, 229, 230, 262, 297, 300].includes(native) || /cannot open database|permission.*denied|not able to access.*database/.test(message)) {
    return { category: 'permissions', reason: 'databaseAccess' };
  }
  if (native === 18456 || /18456|login failed/.test(message)) {
    return { category: 'authentication', reason: 'loginRejected' };
  }
  if (/getaddrinfo|name or service not known|no such host|could not resolve/.test(message)) {
    return { category: 'network', reason: 'dns' };
  }
  if (/timed out|timeout|refused|network.related|server.*not found|tcp provider|10061|10060/.test(message)) {
    return { category: 'network', reason: 'tcpFailed' };
  }
  return { category: 'unknown', reason: 'unclassified' };
}

/** Parse canonical IPv4 without octal ambiguity or command metacharacters. */
export function ipv4(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) {
    return null;
  }
  const octets = value.split('.').map(Number);
  if (octets.some(octet => octet > 255)) {
    return null;
  }
  return octets.reduce((result, octet) => result * 256 + octet, 0);
}

/** Derive a network from a measured interface address AND its measured prefix length. */
export function ipv4Network(address, prefix) {
  const numeric = ipv4(address);
  if (numeric === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
    throw new Error('Invalid measured IPv4 interface.');
  }
  const block = 2 ** (32 - prefix);
  let network = Math.floor(numeric / block) * block;
  const octets = [];
  for (const divisor of [16777216, 65536, 256, 1]) {
    octets.push(Math.floor(network / divisor));
    network %= divisor;
  }
  return octets.join('.') + '/' + prefix;
}

/** Check subnet membership without inferring a netmask from a gateway address. */
export function inSubnet(address, subnet) {
  if (typeof subnet !== 'string') {
    return false;
  }
  const [base, text] = subnet.split('/');
  const prefix = Number(text);
  try {
    return ipv4Network(address, prefix) === ipv4Network(base, prefix);
  } catch {
    return false;
  }
}

/** Restrict proposed WSL firewall rules to an actually measured private NAT network. */
export function firewallScope(windows, wsl, port) {
  if (wsl?.mode !== 'nat' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Measured WSL NAT scope is required.');
  }
  for (const route of wsl.routes ?? []) {
    const host = (windows.addresses ?? []).find(item => item.address === route.gateway && item.virtual === true);
    if (!host) {
      continue;
    }
    for (const address of wsl.addresses ?? []) {
      if (address.interface !== route.interface || address.family !== 'inet') {
        continue;
      }
      const subnet = ipv4Network(address.address, address.prefixLength);
      const windowsSubnet = ipv4Network(host.address, host.prefixLength);
      const privateAddress = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host.address);
      const minimumPrivatePrefix = host.address.startsWith('10.') ? 8 : host.address.startsWith('172.') ? 12 : 16;
      if (subnet === windowsSubnet && privateAddress && address.prefixLength >= minimumPrivatePrefix && address.prefixLength <= 30 && inSubnet(route.gateway, subnet)) {
        return { localAddress: host.address, remoteAddress: subnet, wslAddress: address.address, port, interface: address.interface };
      }
    }
  }
  throw new Error('Measured WSL NAT scope is required.');
}

/** Validate only the diagnostic inputs that are allowed across IPC. */
export function validateSqlInput(input = {}) {
  const result = { useInstalled: input.useInstalled !== false };
  for (const name of ['instance', 'host', 'applicationDatabase', 'gameDatabase', 'rankingDatabase', 'battleCoreDatabase', 'appUsername', 'gameUsername', 'adminUsername', 'gameAdminUsername']) {
    const value = input[name] ?? '';
    if (typeof value !== 'string' || value.length > 255 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Invalid SQL troubleshooting input.');
    }
    result[name] = value;
  }
  if (result.instance && !/^[A-Za-z0-9_.-]{1,128}$/.test(result.instance)) {
    throw new Error('Invalid SQL instance.');
  }
  if (result.host && !/^[A-Za-z0-9_.:-]+$/.test(result.host)) {
    throw new Error('Invalid SQL host.');
  }
  for (const name of ['applicationDatabase', 'gameDatabase', 'rankingDatabase', 'battleCoreDatabase']) {
    if (result[name] && !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(result[name])) {
      throw new Error('Invalid SQL identifier.');
    }
  }
  for (const name of ['appPassword', 'gamePassword', 'adminPassword', 'gameAdminPassword']) {
    const value = input[name] ?? '';
    if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('Invalid SQL troubleshooting input.');
    }
    result[name] = value;
  }
  result.port = Number(input.port ?? 1433);
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error('Invalid SQL port.');
  }
  result.encrypt = input.encrypt !== false;
  result.trustCertificate = input.trustCertificate === true;
  return result;
}

/** Redact reports defensively; raw configuration/credentials are never report fields. */
export function redactDiagnostic(value, secrets = []) {
  if (Array.isArray(value)) {
    return value.map(item => redactDiagnostic(item, secrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|secret|private.?key|connection.?string|app.?key|credential/i.test(key)).map(([key, item]) => [key, redactDiagnostic(item, secrets)]));
  }
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(item => typeof item === 'string' && item.length > 0).sort((left, right) => right.length - left.length)) {
      text = text.replaceAll(secret, '[REDACTED]');
    }
    text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]');
    return text.replace(/\b(password|pwd|access_token|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^;\r\n]*)/gi, '$1=[REDACTED]');
  }
  return value;
}

/** Describe one result using stable keys translated by the renderer. */
export function sqlStep(id, status, category, reason, evidence = {}, action = reason) {
  return { id, status, category, reason, evidence, action };
}

/** Build layered conclusions from measured facts without equating TCP success with SQL access. */
export function buildSqlReport(windows, wsl, target) {
  const steps = [];
  const selected = (windows.instances ?? []).find(instance => instance.name === target.instance);
  steps.push(sqlStep('windows.instances', windows.error ? 'notChecked' : selected ? 'passed' : 'warning', 'windows', windows.error ? 'windowsUnavailable' : selected ? 'instanceFound' : 'selectInstance', { instances: windows.instances ?? [], selected: target.instance }));
  if (selected) {
    steps.push(sqlStep('windows.service', selected.state === 'Running' ? 'passed' : 'failed', 'windows', selected.state === 'Running' ? 'serviceRunning' : 'serviceStopped', { service: selected.service, state: selected.state, version: selected.version }));
    const mode = selected.loginMode;
    const effective = windows.localSqlMetadata?.windowsOnly;
    const pending = (mode === 2 && effective === 1) || (mode === 1 && effective === 0);
    steps.push(sqlStep('windows.authentication', pending ? 'warning' : effective === 0 ? 'passed' : mode === 1 || effective === 1 ? 'failed' : mode === 2 ? 'warning' : 'notChecked', 'authentication', pending ? 'restartRequired' : effective === 0 ? 'mixedEffective' : mode === 1 || effective === 1 ? 'windowsOnly' : mode === 2 ? 'mixedConfigured' : 'metadataUnknown', { configuredMode: mode, effectiveWindowsOnly: effective, instance: selected.name }));
    for (const login of windows.localSqlMetadata?.logins ?? []) {
      const denied = login.explicitConnect === 'DENY';
      const missing = !login.found && login.metadataVisible;
      const failed = login.found && (!login.enabled || denied);
      const granted = login.explicitConnect === 'GRANT' || login.explicitConnect === 'GRANT_WITH_GRANT_OPTION';
      steps.push(sqlStep('windows.login.' + login.name, missing || failed ? 'failed' : login.found && granted ? 'passed' : 'notChecked', 'authentication', missing ? 'loginMissing' : failed ? (denied ? 'loginConnectDenied' : 'loginDisabled') : login.found && granted ? 'loginEnabled' : 'metadataUnknown', login));
    }
    const sections = selected.tcp?.listenAll ? (selected.tcp.sections ?? []).filter(section => section.name === 'IPAll') : (selected.tcp?.sections ?? []).filter(section => section.name !== 'IPAll' && section.enabled === true);
    const dynamic = sections.some(section => section.dynamicPort !== '');
    const correct = selected.tcp?.enabled === true && sections.length > 0 && sections.every(section => section.dynamicPort === '' && section.port === String(target.port));
    steps.push(sqlStep('windows.tcpConfiguration', selected.tcp?.unknown ? 'notChecked' : correct ? 'passed' : 'warning', 'network', selected.tcp?.unknown ? 'metadataUnknown' : dynamic ? 'dynamicPort' : correct ? 'staticConfigured' : 'tcpConfiguration', { tcp: selected.tcp, requestedPort: target.port }));
    const listeners = (windows.listeners ?? []).filter(listener => listener.port === target.port);
    const owned = listeners.filter(listener => listener.pid === selected.pid && selected.pid > 0);
    steps.push(sqlStep('windows.listener', windows.listenerError ? 'notChecked' : owned.length ? 'passed' : 'failed', 'network', windows.listenerError ? 'metadataUnknown' : owned.length ? 'listenerFound' : listeners.length ? 'portOccupied' : 'noListener', { listeners, selectedPid: selected.pid, observedInstancePorts: (windows.listeners ?? []).filter(listener => listener.pid === selected.pid) }));
  }
  steps.push(sqlStep('windows.browser', 'passed', 'network', 'browserOptional'));
  for (const probe of windows.probes ?? []) {
    steps.push(sqlStep('windows.tcp.' + probe.host, probe.notChecked ? 'notChecked' : probe.ok ? 'passed' : 'failed', 'network', probe.ok ? 'tcpPassed' : probe.code ?? 'tcpFailed', { host: probe.host, port: probe.port }));
  }
  steps.push(sqlStep('wsl.addresses', wsl.error ? 'notChecked' : 'passed', 'network', wsl.error ? 'wslUnavailable' : 'wslAddresses', { mode: wsl.mode, addresses: wsl.addresses ?? [], routes: wsl.routes ?? [] }));
  steps.push(sqlStep('wsl.mode', wsl.error || !wsl.mode || wsl.mode === 'unknown' ? 'notChecked' : 'passed', 'network', wsl.error ? 'wslUnavailable' : !wsl.mode || wsl.mode === 'unknown' ? 'networkModeUnknown' : 'networkModeFound', { mode: wsl.mode }));
  for (const probe of wsl.probes ?? []) {
    steps.push(sqlStep('wsl.tcp.' + probe.host, probe.notChecked ? 'notChecked' : probe.ok ? 'passed' : 'failed', 'network', probe.ok ? 'tcpPassed' : probe.code ?? 'tcpFailed', { host: probe.host, port: probe.port }));
  }
  const diagnosticHost = target.host || (wsl.mode === 'mirrored' ? '127.0.0.1' : wsl.routes?.[0]?.gateway);
  const windowsPassed = (windows.probes ?? []).some(probe => probe.ok && probe.host === diagnosticHost && probe.port === target.port);
  const wslFailed = (wsl.probes ?? []).some(probe => !probe.ok && !probe.notChecked && probe.host === diagnosticHost && probe.port === target.port);
  if (target.useInstalled && wsl.mode === 'nat' && ipv4(target.host) !== null && !(windows.addresses ?? []).some(address => address.address === target.host) && (wsl.probes ?? []).some(probe => probe.host === target.host && !probe.ok && !probe.notChecked)) {
    steps.push(sqlStep('configuration.host', 'warning', 'network', 'staleTarget', { configuredHost: target.host, currentGateways: (wsl.routes ?? []).map(route => route.gateway) }));
  }
  steps.push(sqlStep('windows.firewall', windows.firewallError ? 'notChecked' : windowsPassed && wslFailed ? 'warning' : 'passed', 'network', windows.firewallError ? 'metadataUnknown' : windowsPassed && wslFailed ? 'firewallRouting' : 'firewallInspected', { rules: windows.firewallRules ?? [], profiles: windows.firewallProfiles ?? [] }));
  try {
    const scope = firewallScope(windows, wsl, target.port);
    const stale = (windows.firewallRules ?? []).filter(rule => rule.managed !== false).filter(rule => rule.localAddress !== scope.localAddress || rule.remoteAddress !== scope.remoteAddress || Number(rule.port) !== scope.port);
    steps.push(sqlStep('windows.firewallScope', stale.length ? 'warning' : 'passed', 'network', stale.length ? 'staleFirewall' : 'scopedFirewall', { scope, staleRules: stale }));
  } catch {
    steps.push(sqlStep('windows.firewallScope', 'notChecked', 'network', 'noFirewallScope'));
  }
  for (const step of wsl.steps ?? []) {
    steps.push(step);
  }
  return { schema: 1, createdAt: new Date().toISOString(), selectedInstance: target.instance, target: { host: target.host, port: target.port, source: target.useInstalled ? 'installed' : 'manual' }, steps };
}
