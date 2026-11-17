import { spawn } from 'node:child_process';

/** Windows installs commonly expose python.exe while Linux exposes python3. */
const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], { shell: false, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
