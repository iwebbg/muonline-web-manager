# Machine-wide feature preparation only. Linux distro installation remains in the original user's session.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$featureNames = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')
$changed = $false
$restartRequired = $false

# Install only the stable x64 WSL asset from Microsoft's fixed upstream repository.
function Install-ModernWslRuntime {
    $directory = $null
    $lockedPackage = $null
    $failureCode = 51
    try {
        $windows = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        if ([int]$windows.CurrentBuildNumber -lt 19044) {
            return 50
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
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
            exit 3010
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
        exit 3010
    }

    # Older Windows 10 inbox executables advertise different flags. Never guess their syntax.
    $helpText = ((& wsl.exe --help 2>&1 | Out-String) -replace '\x00', '')
    $requiredFlags = @('--version', '--install', '--no-distribution', '--no-launch')
    $missingFlags = @($requiredFlags | Where-Object { $helpText -notmatch [regex]::Escape($_) })
    if ($missingFlags.Count -gt 0 -and $helpText -match '--update') {
        if ($helpText -match '--web-download') {
            & wsl.exe --update --web-download | Out-Null
        } else {
            & wsl.exe --update | Out-Null
        }
        $updateCode = $LASTEXITCODE
        if ($updateCode -in @(3010, 1641)) {
            exit 3010
        }
        $helpText = ((& wsl.exe --help 2>&1 | Out-String) -replace '\x00', '')
        $missingFlags = @($requiredFlags | Where-Object { $helpText -notmatch [regex]::Escape($_) })
    }
    if ($missingFlags.Count -gt 0) {
        # Kernel-only updates and Store failures fall back to Microsoft's signed full runtime.
        $runtimeCode = Install-ModernWslRuntime
        if ($runtimeCode -ne 0) {
            exit $runtimeCode
        }
        $helpText = ((& wsl.exe --help 2>&1 | Out-String) -replace '\x00', '')
        $missingFlags = @($requiredFlags | Where-Object { $helpText -notmatch [regex]::Escape($_) })
        if ($missingFlags.Count -gt 0) {
            exit 54
        }
    }

    # WSL can print "reboot required" and still return zero; check actual feature state as well.
    & wsl.exe --install --no-distribution | Out-Null
    $installCode = $LASTEXITCODE
    if ($installCode -notin @(0, 3010, 1641)) {
        exit $installCode
    }
    foreach ($featureName in $featureNames) {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
        if ($feature.State -in @('EnablePending', 'DisablePending')) {
            $restartRequired = $true
        }
    }
    if ($changed -or $restartRequired -or $installCode -in @(3010, 1641)) {
        exit 3010
    }
    exit 0
} catch {
    Write-Error 'Windows WSL preparation failed. Check Windows optional feature availability and permissions.'
    exit 1
}
