import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** Execute only mocked feature/WSL commands; never enable real Windows features in CI. */
async function featureContract({ initial = 'Enabled', pendingAfterEnable = false, nativeCode = 0 }) {
  const script = await readFile(new URL('../runtime/setup-windows-wsl.ps1', import.meta.url), 'utf8');
  const fixture = `
$global:fixtureStates = @{'Microsoft-Windows-Subsystem-Linux'='${initial}';'VirtualMachinePlatform'='${initial}'}
function Get-WindowsOptionalFeature {
    param([switch]$Online, [string]$FeatureName)
    [pscustomobject]@{State=$global:fixtureStates[$FeatureName]}
}
function Enable-WindowsOptionalFeature {
    param([switch]$Online, [string]$FeatureName, [switch]$All, [switch]$NoRestart)
    if (-not $NoRestart) { throw 'Automatic restart is forbidden in the contract test.' }
    $global:fixtureStates[$FeatureName] = '${pendingAfterEnable ? 'EnablePending' : 'Enabled'}'
    [pscustomobject]@{RestartNeeded=$false}
}
function wsl.exe {
    if ($args -notcontains '--no-distribution' -or $args -contains '-d') { throw 'Elevated distro install is forbidden.' }
    $global:LASTEXITCODE = ${nativeCode}
    'The requested operation is successful. Changes will not be effective until the system is rebooted.'
}
`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(fixture + script, 'utf16le').toString('base64')], { shell: false, windowsHide: true });
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', resolve);
  });
}

for (const [name, settings, expected] of [
  ['feature activation forces reboot even when native WSL exits zero', { initial: 'Disabled' }, 3010],
  ['pending features stop before distro installation', { initial: 'EnablePending' }, 3010],
  ['already active features permit installation after the actual reboot', { initial: 'Enabled' }, 0],
  ['native reboot exit remains a reboot boundary', { initial: 'Enabled', nativeCode: 3010 }, 3010],
  ['native WSL failure is not treated as readiness', { initial: 'Enabled', nativeCode: 7 }, 7]
]) {
  test(name, { skip: process.platform !== 'win32' }, async () => {
    assert.equal(await featureContract(settings), expected);
  });
}
