$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wsl.exe" -Argument '-d Ubuntu-24.04 -u root --exec /bin/sleep infinity'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'MuOnline-Web-WSL' -Action $action -Trigger $trigger -Settings $settings -Description 'Keep MuOnline Docker services alive independently of the control panel.' -Force | Out-Null
Start-ScheduledTask -TaskName 'MuOnline-Web-WSL'
