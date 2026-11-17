import { spawn } from 'node:child_process';

/** Execute a bounded command with argument arrays and no command-line secrets. */
export function execute(file, args, input = '', timeout = 1800000, diagnostics = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) {
        exceeded = true;
        child.kill();
      }
    });
    // Runtime stderr can include secrets from dependencies. Never forward it to the renderer.
    if (diagnostics?.onDiagnostics) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-1024 * 1024); });
    } else child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot start required executable: ' + file));
    });
    child.on('close', async code => {
      clearTimeout(timer);
      if (diagnostics?.onDiagnostics) {
        try { await diagnostics.onDiagnostics({ executable: file, code, stdout: output, stderr: errorOutput }); } catch { /* Logging never changes the command result. */ }
      }
      if (code !== 0 || exceeded) {
        const knownWslErrors = ['Wsl/E_ACCESSDENIED', 'Wsl/WSL_E_DISTRO_NOT_FOUND', 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND', 'Wsl/Service/CreateInstance/WSL_E_DISTRO_NOT_FOUND'];
        const diagnostic = file === 'wsl.exe' ? knownWslErrors.find(value => output.replaceAll('\u0000', '').includes(value)) : undefined;
        const reason = timedOut ? 'timeout' : exceeded ? 'output limit exceeded' : 'exit ' + code;
        reject(new Error('Command failed: ' + file + ' (' + reason + ')' + (diagnostic ? ' [' + diagnostic + ']' : '') + '. Output withheld to protect credentials.'));
      } else {
        resolve(output.replaceAll('\u0000', ''));
      }
    });
    child.stdin.end(input);
  });
}

/** Hand off an authenticated installer to Windows without keeping the panel alive. */
export function launchDetached(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Cannot launch the verified manager installer.')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
