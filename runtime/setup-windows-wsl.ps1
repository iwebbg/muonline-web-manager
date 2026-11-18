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
