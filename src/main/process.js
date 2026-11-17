import { spawn } from 'node:child_process';

/** Execute a bounded command with argument arrays and no command-line secrets. */
export function execute(file, args, input = '', timeout = 1800000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let exceeded = false;
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) {
        exceeded = true;
        child.kill();
      }
    });
    // Runtime stderr can include secrets from dependencies. Never forward it to the renderer.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot start required executable: ' + file));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) {
        reject(new Error('Command failed or timed out: ' + file + '. Output withheld to protect credentials.'));
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
