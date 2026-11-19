import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** Execute only mocked feature/WSL commands; never enable real Windows features in CI. */
async function featureContract({ initial = 'Enabled', pendingAfterEnable = false, nativeCode = 0, legacy = false, upgradeWorks = false, updateCode = 0, nullHelp = false, webDownload = false }) {
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
$global:fixtureModern = $${legacy ? 'false' : 'true'}
function wsl.exe {
    if ($args -contains '--help') {
        $global:LASTEXITCODE = 0
        if (-not $global:fixtureModern) { 'Usage: wsl.exe --exec --list --update --import --version${webDownload ? ' --web-download' : ''}'; return }
        $help = '--version --install --no-distribution --no-launch --update'
        ${nullHelp ? '$help = $help.Replace("-", "-`0")' : ''}
        $help
        return
    }
    if ($args -contains '--update') {
        if (($args -contains '--web-download') -ne $${webDownload ? 'true' : 'false'}) { throw 'Incorrect legacy update flags.' }
        $global:LASTEXITCODE = ${updateCode}
        $global:fixtureModern = $${upgradeWorks ? 'true' : 'false'}
        return
    }
    if (-not $global:fixtureModern -or $args -notcontains '--no-distribution' -or $args -contains '-d') { throw 'Unsupported elevated distro install is forbidden.' }
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
  ['native WSL failure is not treated as readiness', { initial: 'Enabled', nativeCode: 7 }, 7],
  ['legacy inbox updater that only updates the kernel requires modern WSL', { legacy: true }, 50],
  ['legacy WSL upgrade rechecks flags before using no-distribution', { legacy: true, upgradeWorks: true }, 0],
  ['failed WSL update never attempts unsupported installation', { legacy: true, updateCode: 7 }, 7],
  ['UTF-16 style null-separated native help still detects flags', { nullHelp: true }, 0],
  ['legacy Windows 10 uses advertised web download to upgrade the runtime', { legacy: true, upgradeWorks: true, webDownload: true }, 0]
]) {
  test(name, { skip: process.platform !== 'win32' }, async () => {
    assert.equal(await featureContract(settings), expected);
  });
}
