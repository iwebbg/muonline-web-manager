import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend } from '../src/main/backend.js';
import { developmentProfile } from '../src/main/runtime-profile.js';

// Fixed dev distribution, read only: no bootstrap, Docker build, migrations or secret arguments.
try {
  const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const backend = new Backend(resources, 'unused', undefined, 'en', developmentProfile);
  console.log(await backend.runtime({ action: 'developmentLogs' }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
