$ErrorActionPreference = 'Stop'
# Task Scheduler must keep the child attached to a hidden waiting host, not an interactive console.
$keepaliveSource = '$ErrorActionPreference = ''Stop''; $p = Start-Process -FilePath (Join-Path $env:SystemRoot ''System32\wsl.exe'') -ArgumentList ''-d'',''Ubuntu-24.04'',''-u'',''root'',''--exec'',''/bin/sleep'',''infinity'' -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode'
$encodedKeepalive = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($keepaliveSource))
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encodedKeepalive)
# A running legacy direct-wsl task would otherwise survive replacement (IgnoreNew).
$existing = Get-ScheduledTask -TaskName 'MuOnline-Web-WSL' -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running' -and @($existing.Actions | Where-Object { $_.Execute -match '(?i)(^|[\\/])wsl\.exe$' }).Count -gt 0) {
    Stop-ScheduledTask -InputObject $existing
}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'MuOnline-Web-WSL' -Action $action -Trigger $trigger -Settings $settings -Description 'Keep MuOnline Docker services alive independently of the control panel.' -Force | Out-Null
Start-ScheduledTask -TaskName 'MuOnline-Web-WSL'
