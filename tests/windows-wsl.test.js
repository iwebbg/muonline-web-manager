import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Execute only mocked feature/WSL commands; never enable real Windows features in CI. */
async function featureContract({ initial = 'Enabled', pendingAfterEnable = false, nativeCode = 0, legacy = false, upgradeWorks = false, updateCode = 0, nullHelp = false, webDownload = false, fallback = 'success', updateStderr = false, featureError = false, report = false }) {
  const script = await readFile(new URL('../runtime/setup-windows-wsl.ps1', import.meta.url), 'utf8');
  const digest = createHash('sha256').update('fixture').digest('hex');
  const fixture = `
$global:fixtureStates = @{'Microsoft-Windows-Subsystem-Linux'='${initial}';'VirtualMachinePlatform'='${initial}'}
function Get-WindowsOptionalFeature {
    param([switch]$Online, [string]$FeatureName)
    ${featureError ? "throw 'Fixture optional feature not found.'" : ''}
    [pscustomobject]@{State=$global:fixtureStates[$FeatureName]}
}
function Enable-WindowsOptionalFeature {
    param([switch]$Online, [string]$FeatureName, [switch]$All, [switch]$NoRestart)
    if (-not $NoRestart) { throw 'Automatic restart is forbidden in the contract test.' }
    $global:fixtureStates[$FeatureName] = '${pendingAfterEnable ? 'EnablePending' : 'Enabled'}'
    [pscustomobject]@{RestartNeeded=$false}
}
function Get-ItemProperty {
    param([string]$Path)
    if ($Path -ne 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion') { throw 'Unexpected registry query.' }
    [pscustomobject]@{CurrentBuildNumber='${fallback === 'oldWindows' ? '19041' : '19045'}'}
}
function Invoke-RestMethod {
    param([string]$Uri, $Headers, [int]$TimeoutSec, [int]$MaximumRedirection)
    if ($Uri -cne 'https://api.github.com/repos/microsoft/WSL/releases/latest') { throw 'Unexpected metadata host.' }
    ${fallback === 'download' ? "throw 'Fixture download failed.'" : ''}
    [pscustomobject]@{draft=$false; prerelease=$false; tag_name='3.0.5'; assets=@([pscustomobject]@{
        name='wsl.3.0.5.0.x64.msi'; size=7;
        browser_download_url='${fallback === 'url' ? 'https://untrusted.invalid/installer.msi' : 'https://github.com/microsoft/WSL/releases/download/3.0.5/wsl.3.0.5.0.x64.msi'}';
        digest='sha256:${fallback === 'hash' ? '0'.repeat(64) : digest}'
    })}
}
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [switch]$PassThru, [int]$TimeoutSec, [int]$MaximumRedirection)
    if ($Uri -cne 'https://github.com/microsoft/WSL/releases/download/3.0.5/wsl.3.0.5.0.x64.msi') { throw 'Unexpected asset host.' }
    [IO.File]::WriteAllBytes($OutFile, [Text.Encoding]::ASCII.GetBytes('fixture'))
    [pscustomobject]@{BaseResponse=[pscustomobject]@{ResponseUri=[uri]'https://release-assets.githubusercontent.com/fixture'}}
}
function Get-AuthenticodeSignature {
    param([string]$LiteralPath)
    [pscustomobject]@{Status='${fallback === 'signature' ? 'NotSigned' : 'Valid'}'; SignerCertificate=[pscustomobject]@{Subject='CN=Fixture, O=${fallback === 'publisher' ? 'Other Company' : 'Microsoft Corporation'}, C=US'}}
}
function Start-Process {
    param([string]$FilePath, $ArgumentList, [string]$WindowStyle, [switch]$Wait, [switch]$PassThru)
    if ($FilePath -ne 'msiexec.exe' -or -not $Wait -or $ArgumentList -notcontains '/qn' -or $ArgumentList -notcontains '/norestart') { throw 'Unexpected process or installer flags.' }
    $global:fixtureModern = $${fallback === 'unchanged' ? 'false' : 'true'}
    [pscustomobject]@{ExitCode=${fallback === 'msi' ? 1603 : fallback === 'reboot' ? 3010 : 0}}
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
        ${updateStderr ? "Write-Error 'Fixture native updater stderr.'" : ''}
        $global:LASTEXITCODE = ${updateCode}
        $global:fixtureModern = $${upgradeWorks ? 'true' : 'false'}
        return
    }
    if (-not $global:fixtureModern -or $args -notcontains '--no-distribution' -or $args -contains '-d') { throw 'Unsupported elevated distro install is forbidden.' }
    $global:LASTEXITCODE = ${nativeCode}
    'The requested operation is successful. Changes will not be effective until the system is rebooted.'
}

`;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-wsl-contract-'));
  const filename = path.join(directory, 'fixture.ps1');
  const resultPath = path.join(directory, 'result.json');
  const resultBase64 = Buffer.from(resultPath, 'utf8').toString('base64');
  const source = `$ResultPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${resultBase64}'))\n` + fixture + script.replace(/^param\([^\n]*\)\r?\n/, '');
  try {
    // File transport keeps expanded fixtures below Windows' argv limit; BOM is for PS 5.1.
    await writeFile(filename, '\ufeff' + source, 'utf8');
    const code = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filename], { shell: false, windowsHide: true });
      child.stdout.resume();
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', resolve);
    });
    return report ? { code, report: JSON.parse(await readFile(resultPath, 'utf8')) } : code;
  } finally { await rm(directory, { recursive: true, force: true }); }

}

for (const [name, settings, expected] of [
  ['feature activation forces reboot even when native WSL exits zero', { initial: 'Disabled' }, 3010],
  ['pending features stop before distro installation', { initial: 'EnablePending' }, 3010],
  ['already active features permit installation after the actual reboot', { initial: 'Enabled' }, 0],
  ['native reboot exit remains a reboot boundary', { initial: 'Enabled', nativeCode: 3010 }, 3010],
  ['native WSL failure is not treated as readiness', { initial: 'Enabled', nativeCode: 7 }, 7],
  ['legacy kernel-only update falls back to a verified full runtime MSI', { legacy: true }, 0],
  ['legacy WSL upgrade rechecks flags before using no-distribution', { legacy: true, upgradeWorks: true }, 0],
  ['failed WSL update falls back to the verified runtime package', { legacy: true, updateCode: 7 }, 0],
  ['UTF-16 style null-separated native help still detects flags', { nullHelp: true }, 0],
  ['legacy Windows 10 uses advertised web download to upgrade the runtime', { legacy: true, upgradeWorks: true, webDownload: true }, 0],
  ['older Windows blocks MSI fallback before downloading', { legacy: true, fallback: 'oldWindows' }, 50],
  ['unavailable official download fails without running an installer', { legacy: true, fallback: 'download' }, 51],
  ['redirected metadata cannot select an arbitrary installer URL', { legacy: true, fallback: 'url' }, 51],
  ['checksum mismatch blocks execution', { legacy: true, fallback: 'hash' }, 52],
  ['unsigned installer is refused despite a matching checksum', { legacy: true, fallback: 'signature' }, 52],
  ['valid signature from a different publisher is refused', { legacy: true, fallback: 'publisher' }, 52],
  ['MSI failure does not advance to distro installation', { legacy: true, fallback: 'msi' }, 53],
  ['MSI success with missing modern commands reports activation failure', { legacy: true, fallback: 'unchanged' }, 54],
  ['MSI reboot requirement is returned without rebooting', { legacy: true, fallback: 'reboot' }, 3010]
]) {
  test(name, { skip: process.platform !== 'win32' }, async () => {
    assert.equal(await featureContract(settings), expected);
  });
}


test('native updater stderr does not bypass the signed MSI fallback on PowerShell 5.1', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(await featureContract({ legacy: true, updateCode: 7, updateStderr: true }), 0);
});

test('elevated setup records the failing stage and bounded error before exiting', { skip: process.platform !== 'win32' }, async () => {
  const result = await featureContract({ featureError: true, report: true });
  assert.equal(result.code, 1);
  assert.equal(result.report.failureCode, 1);
  assert.equal(result.report.stage, 'windows-features');
  assert.equal(result.report.detail, 'Fixture optional feature not found.');
});

test('PowerShell elevation wrapper handles quoted Unicode paths and transports the child failure report', { skip: process.platform !== 'win32' }, async () => {
  const { Backend } = await import('../src/main/backend.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'muonline-elevation-contract-'));
  const resources = path.join(directory, 'MuOnline Web Manager', 'Файлове');
  const logged = [];
  let scenario = 'reported-failure';
  const backend = new Backend(resources, directory, undefined, 'en', undefined, async (file, args, input) => {
    if (file === 'wsl.exe') throw new Error('Fixture legacy WSL');
    assert.equal(file, 'powershell.exe');
    const wrapper = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const fixture = `
function Start-Process {
    param([string]$FilePath, $ArgumentList, [string]$Verb, [string]$WindowStyle, [switch]$Wait, [switch]$PassThru)
    ${scenario === 'uac-failure' ? "throw 'Fixture UAC launch failure'" : ''}
    if ($FilePath -ne 'powershell.exe' -or $Verb -ne 'RunAs' -or -not $Wait) { throw 'Incorrect elevation invocation' }
    if ($ArgumentList[5] -cne ('"'+$payload.path+'"') -or $ArgumentList[7] -cne ('"'+$payload.result+'"')) { throw 'Incorrect file path quoting' }
    [IO.File]::WriteAllText($payload.result, '{"failureCode":1,"restartRequired":false,"stage":"windows-features","detail":"Fixture feature lookup failed"}', (New-Object Text.UTF8Encoding($false)))
    $process=[pscustomobject]@{ExitCode=${scenario === 'wait-for-exit' ? '$null' : '1'}}
    $process|Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {$this.ExitCode=1}
    $process|Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $process
}
`;
    const filename = path.join(directory, 'wrapper.ps1');
    await writeFile(filename, '\ufeff' + fixture + wrapper, 'utf8');
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filename], { shell: false, windowsHide: true });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.resume();
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(output) : reject(new Error('Wrapper fixture exit ' + code)));
      child.stdin.end(input);
    });
  });
  backend.activeLog = { append: async line => logged.push(line) };
  try {
    for (scenario of ['reported-failure', 'wait-for-exit', 'uac-failure']) {
      logged.length = 0;
      await assert.rejects(backend.ensureDistribution(), /support logs.*setup stage/);
      assert.ok(logged.some(line => line.includes(scenario === 'uac-failure' ? 'Fixture UAC launch failure' : 'Fixture feature lookup failed')));
      if (scenario === 'uac-failure') assert.ok(logged.some(line => line.includes('elevation-start')));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
