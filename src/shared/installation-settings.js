/** Persist only a bounded installation draft. Passwords and endpoint-change confirmations are excluded. */
export function publicInstallationSettings(input = {}) {
  if (!input || typeof input !== 'object') return {};
  const result = {};
  for (const key of ['sqlAdmin', 'sqlHost', 'sqlPort', 'profile', 'appEnv', 'gameDatabase', 'webDatabase', 'appLogin', 'gameLogin']) {
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
  if (input.administrator && typeof input.administrator === 'object') {
    result.administrator = {};
    for (const key of ['name', 'email']) {
      if (typeof input.administrator[key] === 'string' && input.administrator[key].length <= 512) result.administrator[key] = input.administrator[key];
    }
  }
  return result;
}

