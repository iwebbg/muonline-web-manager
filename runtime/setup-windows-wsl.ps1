# Machine-wide feature preparation only. Linux distro installation remains in the original user's session.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$featureNames = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')
$changed = $false
$restartRequired = $false

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
        if ($updateCode -ne 0) {
            exit $updateCode
        }
        $helpText = ((& wsl.exe --help 2>&1 | Out-String) -replace '\x00', '')
        $missingFlags = @($requiredFlags | Where-Object { $helpText -notmatch [regex]::Escape($_) })
    }
    if ($missingFlags.Count -gt 0) {
        # The old kernel-only updater may succeed without installing modern Store WSL.
        exit 50
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
