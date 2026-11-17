import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodedPowerShell } from '../src/main/sql-troubleshooting.js';
import { execute } from '../src/main/process.js';
import { developmentProfile } from '../src/main/runtime-profile.js';
import { acquireDevLock } from '../src/main/dev-lock.js';
import { Backend } from '../src/main/backend.js';
import { SetupJournal } from '../src/main/setup-journal.js';

const { distribution, taskName } = developmentProfile;
const setupSteps = Object.freeze({
  install: ['--install', '-d', 'Ubuntu-24.04', '--name', distribution, '--no-launch'],
  version: ['--set-version', distribution, '2']
});

/** Only these fixed, credential-free WSL setup commands may stream their output.
 * Runtime, Docker and SQL commands retain the private process runner.
 */
export function runDevSetupStep(step, { spawnProcess = spawn, report = console.log } = {}) {
  const args = setupSteps[step];
  if (!Object.hasOwn(setupSteps, step)) throw new Error('Unsupported public WSL setup step.');
  report('WSL setup: wsl.exe ' + args.join(' '));
  return new Promise((resolve, reject) => {
    const child = spawnProcess('wsl.exe', [...args], { shell: false, windowsHide: true, stdio: 'inherit' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 900000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Cannot start wsl.exe for dev setup (' + step + ').'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) {
        reject(new Error('WSL dev setup step "' + step + '" failed (' + (timedOut ? 'timeout' : 'exit ' + code) + '). See the WSL message above. No automatic reset or fallback was performed.'));
      } else {
        resolve();
      }
    });
  });
}

/** This CLI can delete only the fixed dev distro/task. It has no renderer or production reset API. */
export async function manageDevWsl(action, { runner = execute, prepareLinux, confirm, report = console.log, appData = process.env.APPDATA, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('Dev WSL setup/reset requires Windows.');
  if (!['setup', 'reset'].includes(action)) throw new Error('Use setup or reset; distribution overrides are not supported.');
  if (!appData || !path.isAbsolute(appData)) throw new Error('An absolute APPDATA directory is required.');
  const release = acquireDevLock(appData);
  try {
    const list = await runner('wsl.exe', ['--list', '--quiet'], '', 30000);
    const exists = list.replaceAll('\u0000', '').split(/\r?\n/).some(line => line.trim() === distribution);
    if (action === 'setup') {
      const setup = runner === execute ? runDevSetupStep : step => runner('wsl.exe', setupSteps[step], '', 900000);
      if (exists) {
        report('MuOnline-Dev already exists. Skipping installation; continuing WSL2 setup without deleting data.');
      } else {
        await setup('install');
      }
      await setup('version');
      const prepare = prepareLinux ?? (() => {
        const resources = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        return new Backend(resources, path.join(appData, 'MuOnline-Web-Manager-Dev'), undefined, 'en', developmentProfile, runner).prepareLinux();
      });
      report('Preparing the Linux account and systemd without an interactive user/password prompt.');
      await prepare();
      return 'MuOnline-Dev WSL2 and Linux account are ready. Run npm run dev. No manual Ubuntu user/password setup is needed.';
    }
    if (!confirm || await confirm('Delete ALL files, Docker containers/volumes and local databases in MuOnline-Dev? External SQL databases are NOT reset. Type MuOnline-Dev to confirm: ') !== distribution) {
      throw new Error('Reset cancelled. Nothing was deleted.');
    }
    // Stop/remove the dev keepalive before unregistering so it cannot relaunch the distro.
    const cleanup = "$ErrorActionPreference='Stop'; $task=Get-ScheduledTask | Where-Object { $_.TaskName -eq 'MuOnline-Web-Dev-WSL' -and $_.TaskPath -eq '\\' }; if($task){ $task | Stop-ScheduledTask; $task | Unregister-ScheduledTask -Confirm:$false }";
    await runner('powershell.exe', encodedPowerShell(cleanup), '', 60000);
    if (exists) await runner('wsl.exe', ['--unregister', distribution], '', 120000);
    await new SetupJournal(path.join(appData, 'MuOnline-Web-Manager-Dev'), distribution).resetRuntime();
    return distribution + ' and ' + taskName + ' removed. Run npm run dev:wsl:setup to start fresh. Panel preferences and external SQL data were retained.';
  } finally {
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Use npm run dev:wsl:setup or npm run dev:wsl:reset without extra arguments.');
    const confirm = async question => {
      if (!stdin.isTTY) throw new Error('Reset requires an interactive terminal and exact-name confirmation.');
      const terminal = createInterface({ input: stdin, output: stdout });
      try { return await terminal.question(question); } finally { terminal.close(); }
    };
    console.log(await manageDevWsl(process.argv[2], { confirm }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
