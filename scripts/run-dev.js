import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('The dev WSL runtime requires Windows. Use npm run test:ui for the simulated UI.');
const require = createRequire(import.meta.url);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.', '--dev-wsl'], { shell: false, stdio: 'inherit', env: environment });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
