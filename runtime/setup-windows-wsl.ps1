param([string]$ResultPath = '')

# Machine-wide feature preparation only. Linux distro installation remains in the original user's session.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$featureNames = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')
$changed = $false
$restartRequired = $false

# Only this machine-setup script writes this optional main-owned result file.
$script:preparationStage = 'windows-features'
$script:preparationFailure = ''
function Complete-WslPreparation {
    param([int]$Code)
    if ($ResultPath) {
        $report = @{failureCode=$Code; restartRequired=($Code -in @(3010,1641)); stage=$script:preparationStage; detail=$script:preparationFailure}
        [IO.File]::WriteAllText($ResultPath, ($report | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    }
    exit $Code
}

# Windows PowerShell 5.1 turns redirected native stderr into ErrorRecords.
# A failed updater must reach the signed MSI fallback rather than aborting on stderr.
function Invoke-WslSetupCommand {
    param([string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $text = (& wsl.exe @Arguments 2>&1 | Out-String) -replace '\x00', ''
        $code = $LASTEXITCODE
        if ($null -eq $code) { throw 'WSL did not return an exit code.' }
        return [pscustomobject]@{Text=$text; ExitCode=$code}
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

# Install only the stable x64 WSL asset from Microsoft's fixed upstream repository.
function Install-ModernWslRuntime {
    $directory = $null
    $lockedPackage = $null
    $failureCode = 51
    try {
        $script:preparationStage = 'runtime-windows-version'
        $windows = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        if ([int]$windows.CurrentBuildNumber -lt 19044) {
            return 50
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $script:preparationStage = 'runtime-metadata'
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/microsoft/WSL/releases/latest' -Headers @{'User-Agent'='MuOnline-Web-Manager'; 'Accept'='application/vnd.github+json'} -TimeoutSec 60 -MaximumRedirection 0
        if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
            return 51
        }
        $assets = @($release.assets | Where-Object { $_.name -cmatch '^wsl\.\d+\.\d+\.\d+\.\d+\.x64\.msi$' })
        if ($assets.Count -ne 1) {
            return 51
        }
        $asset = $assets[0]
        $expectedUrl = 'https://github.com/microsoft/WSL/releases/download/' + $release.tag_name + '/' + $asset.name
        if ($asset.browser_download_url -cne $expectedUrl -or $asset.size -le 0 -or $asset.size -gt 1GB -or $asset.digest -notmatch '^sha256:[a-fA-F0-9]{64}$') {
            return 51
        }
        $directory = Join-Path ([IO.Path]::GetTempPath()) ('muonline-wsl-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $directory | Out-Null
        $package = Join-Path $directory 'wsl.x64.msi'
        $script:preparationStage = 'runtime-download'
        $download = Invoke-WebRequest -Uri $expectedUrl -OutFile $package -UseBasicParsing -PassThru -TimeoutSec 300 -MaximumRedirection 5
        $finalUri = $download.BaseResponse.ResponseUri
        if ($finalUri.Scheme -ne 'https' -or $finalUri.Host -notin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) {
            return 51
        }
        # Deny writes/replacement while checking the file and while Windows Installer reads it.
        $lockedPackage = [IO.File]::Open($package, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($lockedPackage.Length -ne [long]$asset.size) {
            return 52
        }
        $script:preparationStage = 'runtime-verification'
        $failureCode = 52
        $actualHash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash
        if ($actualHash -ine $asset.digest.Substring(7)) {
            return 52
        }
        # SHA256 is integrity only. Windows must independently validate Microsoft's signature.
        $signature = Get-AuthenticodeSignature -LiteralPath $package
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
            return 52
        }
        $script:preparationStage = 'runtime-msi'
        $failureCode = 53
        $installation = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', ('"' + $package + '"'), '/qn', '/norestart') -WindowStyle Hidden -Wait -PassThru
        if ($installation.ExitCode -in @(3010, 1641)) {
            return 3010
        }
        if ($installation.ExitCode -ne 0) {
            return 53
        }
        return 0
    } catch {
        $script:preparationFailure = $_.Exception.Message.Substring(0, [Math]::Min(600, $_.Exception.Message.Length))
        return $failureCode
    } finally {
        if ($null -ne $lockedPackage) {
            $lockedPackage.Dispose()
        }
        if ($null -ne $directory) {
            Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    foreach ($featureName in $featureNames) {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
        if ($feature.State -in @('EnablePending', 'DisablePending')) {
            Complete-WslPreparation -Code 3010
        }
        if ($feature.State -ne 'Enabled') {
            $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart
            $changed = $true
            if ($result.RestartNeeded) {
                $restartRequired = $true
            }
        }
    }

    # Newly enabled machine features must be activated before continuing WSL installation.
    if ($changed) {
        Complete-WslPreparation -Code 3010
    }

    # Older Windows 10 inbox executables advertise different flags. Never guess their syntax.
    $script:preparationStage = 'wsl-help'
    $helpText = (Invoke-WslSetupCommand -Arguments @('--help')).Text
    $requiredFlags = @('--version', '--install', '--no-distribution', '--no-launch')
    $missingFlags = @($requiredFlags | Where-Object { $helpText -notmatch [regex]::Escape($_) })
    if ($missingFlags.Count -gt 0 -and $helpText -match '--update') {
        $script:preparationStage = 'wsl-update'
        if ($helpText -match '--web-download') {
            $update = Invoke-WslSetupCommand -Arguments @('--update', '--web-download')
        } else {
            $update = Invoke-WslSetupCommand -Arguments @('--update')
        }
        $updateCode = $update.ExitCode
        if ($updateCode -in @(3010, 1641)) {
            Complete-WslPreparation -Code 3010
        }
        $script:preparationStage = 'wsl-help'
        $helpText = (Invoke-WslSetupCommand -Arguments @('--help')).Text
        $missingFlags = @($requiredFlags | Where-Object { $helpText -notmatch [regex]::Escape($_) })
    }
    if ($missingFlags.Count -gt 0) {
        # Kernel-only updates and Store failures fall back to Microsoft's signed full runtime.
        $runtimeCode = Install-ModernWslRuntime
        if ($runtimeCode -ne 0) {
            Complete-WslPreparation -Code $runtimeCode
        }
        $script:preparationStage = 'wsl-help'
        $helpText = (Invoke-WslSetupCommand -Arguments @('--help')).Text
        $missingFlags = @($requiredFlags | Where-Object { $helpText -notmatch [regex]::Escape($_) })
        if ($missingFlags.Count -gt 0) {
            Complete-WslPreparation -Code 54
        }
    }

    # WSL can print "reboot required" and still return zero; check actual feature state as well.
    $script:preparationStage = 'wsl-install'
    $installation = Invoke-WslSetupCommand -Arguments @('--install', '--no-distribution')
    $installCode = $installation.ExitCode
    if ($installCode -notin @(0,3010,1641)) { $script:preparationFailure = $installation.Text.Substring(0, [Math]::Min(600, $installation.Text.Length)) }
    if ($installCode -notin @(0, 3010, 1641)) {
        Complete-WslPreparation -Code $installCode
    }
    foreach ($featureName in $featureNames) {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
        if ($feature.State -in @('EnablePending', 'DisablePending')) {
            $restartRequired = $true
        }
    }
    if ($changed -or $restartRequired -or $installCode -in @(3010, 1641)) {
        Complete-WslPreparation -Code 3010
    }
    Complete-WslPreparation -Code 0
} catch {
    $script:preparationFailure = $_.Exception.Message.Substring(0, [Math]::Min(600, $_.Exception.Message.Length))
    Complete-WslPreparation -Code 1
}
