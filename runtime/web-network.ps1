param([string]$RequestPath = '', [string]$ResultPath = '', [switch]$Refresh)
# Only fixed web ports and manager-owned IPv4 proxies/rules are changed. No SQL secrets enter this script.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:WebScriptPath = $PSCommandPath

function Get-WebProgramFiles {
    return [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
}

function Test-WebIPv4 {
    param([string]$Address)
    $parsed = $null
    return ($Address -match '^\d{1,3}(\.\d{1,3}){3}$' -and [Net.IPAddress]::TryParse($Address, [ref]$parsed) -and $parsed.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $parsed.ToString() -eq $Address)
}

function Invoke-NativeWebCommand {
    param([string]$File, [string[]]$Arguments)
    $prior = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $File @Arguments 2>&1 | Out-String) -replace '\x00', ''
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prior }
    if ($code -ne 0) { throw 'Web network command failed. Check Windows networking permissions and services.' }
    return $output
}

function Get-WebProxies {
    $rows = @()
    $output = Invoke-NativeWebCommand 'netsh.exe' @('interface','portproxy','show','v4tov4')
    foreach ($line in ($output -split '\r?\n')) {
        if ($line -match '^\s*(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$') {
            $rows += [pscustomobject]@{listen=$Matches[1]; port=[int]$Matches[2]; target=$Matches[3]; targetPort=[int]$Matches[4]}
        }
    }
    return $rows
}

function Get-WebTarget {
    param([string]$Distribution)
    $mode = (Invoke-NativeWebCommand 'wsl.exe' @('-d',$Distribution,'-u','root','--exec','wslinfo','--networking-mode')).Trim()
    if ($mode -ne 'nat') { throw 'Automatic public web access requires verified NAT networking. Mirrored or unknown networking needs a separate verified configuration.' }
    $addresses = Invoke-NativeWebCommand 'wsl.exe' @('-d',$Distribution,'-u','root','--exec','ip','-j','-4','address','show','scope','global') | ConvertFrom-Json
    $routes = Invoke-NativeWebCommand 'wsl.exe' @('-d',$Distribution,'-u','root','--exec','ip','-j','-4','route','show','default') | ConvertFrom-Json
    $devices = @($routes | Select-Object -ExpandProperty dev -Unique)
    if ($devices.Count -ne 1) { throw 'The website environment has an ambiguous default network interface.' }
    $ips = @($addresses | Where-Object { $_.ifname -eq $devices[0] } | ForEach-Object { $_.addr_info } | Where-Object { $_.family -eq 'inet' } | Select-Object -ExpandProperty local -Unique)
    if ($ips.Count -ne 1 -or -not (Test-WebIPv4 $ips[0]) -or $ips[0] -notmatch '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)') { throw 'A unique private website environment address could not be verified.' }
    return [string]$ips[0]
}

function Assert-WebOwnership {
    param($Before, $After, [string]$Group)
    $proxies = @(Get-WebProxies)
    $ports = @(@($Before.ports) + @($After.ports) | Where-Object { $_ } | Select-Object -Unique)
    foreach ($port in $ports) {
        $entries = @($proxies | Where-Object { $_.port -eq $port })
        foreach ($entry in $entries) {
            if ($entry.listen -ne '0.0.0.0' -or $entry.targetPort -ne $port -or $port -notin @($Before.ports) -or $entry.target -ne $Before.target) { throw 'Web port forwarding conflicts with an existing non-manager configuration. No unrelated forwarding will be replaced.' }
        }
        $rule = Get-NetFirewallRule -Name ($Group + '-' + $port) -ErrorAction SilentlyContinue
        if ($rule -and $rule.Group -ne $Group) { throw 'A web firewall rule name is owned by another configuration.' }
        if ($port -in @($After.ports)) {
            foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
                $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
                # WSL's existing localhost relay is compatible with the documented NAT portproxy setup.
                $relay = $listener.LocalAddress -in @('127.0.0.1','::1') -and $process.ProcessName -in @('wslhost','wslrelay','wslservice')
                # Windows can host portproxy in System or the live IP Helper service.
                # A matching owned mapping is required in either case; PID alone is not ownership.
                $proxyService = Get-CimInstance -ClassName Win32_Service -Filter "Name='iphlpsvc'"
                $proxyPids = @(4)
                if ($proxyService.State -eq 'Running' -and [int]$proxyService.ProcessId -gt 0) { $proxyPids += [int]$proxyService.ProcessId }
                $ownedProxy = $entries.Count -eq 1 -and $listener.LocalAddress -eq '0.0.0.0' -and $proxyService.State -eq 'Running' -and $listener.OwningProcess -in $proxyPids
                if (-not $relay -and -not $ownedProxy) { throw 'A required web port is already used by another Windows service. Stop that service or use a separate hosting machine.' }
            }
        }
    }
}

function Test-WebFirewall {
    param($Rule, [int]$Port, [string]$Group)
    if (-not $Rule -or $Rule.Group -ne $Group -or $Rule.Enabled -ne 'True' -or $Rule.Action -ne 'Allow' -or $Rule.Direction -ne 'Inbound' -or $Rule.Profile -ne 'Any') { return $false }
    $filters = @($Rule | Get-NetFirewallPortFilter)
    $addresses = @($Rule | Get-NetFirewallAddressFilter)
    return ($filters.Count -eq 1 -and $filters[0].Protocol -in @('TCP','6') -and [string]$filters[0].LocalPort -eq [string]$Port -and $addresses.Count -eq 1 -and [string]$addresses[0].LocalAddress -eq 'Any' -and [string]$addresses[0].RemoteAddress -eq 'Any')
}

function Set-WebForwarding {
    param($Before, $After, [string]$Group)
    foreach ($port in @($Before.ports)) {
        if (-not $port) { continue }
        $owned = @(Get-WebProxies | Where-Object { $_.listen -eq '0.0.0.0' -and $_.port -eq $port -and $_.target -eq $Before.target -and $_.targetPort -eq $port })
        if ($owned.Count) { Invoke-NativeWebCommand 'netsh.exe' @('interface','portproxy','delete','v4tov4','listenaddress=0.0.0.0',('listenport=' + $port)) | Out-Null }
        $rule = Get-NetFirewallRule -Name ($Group + '-' + $port) -ErrorAction SilentlyContinue
        if ($rule -and $rule.Group -eq $Group) { $rule | Remove-NetFirewallRule }
    }
    if (@($After.ports).Count) {
        Start-Service -Name iphlpsvc
        foreach ($port in @($After.ports)) {
            Invoke-NativeWebCommand 'netsh.exe' @('interface','portproxy','add','v4tov4','listenaddress=0.0.0.0',('listenport=' + $port),('connectaddress=' + $After.target),('connectport=' + $port)) | Out-Null
            New-NetFirewallRule -Name ($Group + '-' + $port) -DisplayName ('MuOnline Web TCP ' + $port) -Group $Group -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -LocalAddress Any -Profile Any | Out-Null
            # Verify the effective filter instead of assuming New-NetFirewallRule
            # preserved an address expression (Windows normalizes 0.0.0.0/0 to 0.0.0.0).
            $active = Get-NetFirewallRule -PolicyStore ActiveStore -Name ($Group + '-' + $port) -ErrorAction Stop
            if (-not (Test-WebFirewall $active $port $Group)) { throw 'The web firewall rule could not be verified in active Windows policy. Check firewall policy before retrying.' }
        }
    }
}

function Protect-WebDirectory {
    param([string]$Directory)
    # Scheduled elevated code/configuration must never live in a user-writable app directory.
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Save-WebConfiguration {
    param([string]$Path, $Value)
    [IO.File]::WriteAllText(($Path + '.tmp'), ($Value | ConvertTo-Json -Depth 6 -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath ($Path + '.tmp') -Destination $Path -Force
}

function Get-WebOwner {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Invoke-WebNetwork {
    param($Request)
    if ($Request.profile -notin @('production','development') -or $Request.mode -notin @('local','ip','domain')) { throw 'Invalid web network request.' }
    $development = $Request.profile -eq 'development'
    $distribution = if ($development) { 'MuOnline-Dev' } else { 'Ubuntu-24.04' }
    $group = if ($development) { 'MuOnline-Web-Dev' } else { 'MuOnline-Web' }
    $taskName = $group + '-Network'
    $directory = Join-Path (Get-WebProgramFiles) ($group + '-Network')
    foreach ($candidate in @($directory)) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Web network storage must not be a redirected directory.' }
            $owner = (Get-Acl -LiteralPath $candidate).GetOwner([Security.Principal.SecurityIdentifier]).Value
            if ($owner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Web network storage is not owned by Windows administrators.' }
        }
    }
    $configPath = Join-Path $directory 'configuration.json'
    $scriptPath = Join-Path $directory 'web-network.ps1'
    $sid = Get-WebOwner
    $before = [pscustomobject]@{mode='local'; ports=@(); target=''; owner=$sid; profile=$Request.profile}
    if (Test-Path -LiteralPath $configPath) { $before = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json }
    if ($before.owner -ne $sid -or $before.profile -ne $Request.profile) { throw 'Web network configuration belongs to another Windows user or runtime.' }
    $expectedBefore = @(switch ($before.mode) { 'domain' { 80;443 } 'ip' { 80 } 'local' { } default { throw 'Invalid saved web network configuration.' } })
    if ((@($before.ports) -join ',') -ne ($expectedBefore -join ',')) { throw 'Invalid saved web forwarding ports.' }
    if ($expectedBefore.Count -and -not (Test-WebIPv4 $before.target)) { throw 'Invalid saved web environment address.' }
    $ports = @(switch ($Request.mode) { 'domain' { 80; 443 } 'ip' { 80 } default { } })
    $target = if (@($ports).Count) { Get-WebTarget $distribution } else { '' }
    $after = [pscustomobject]@{mode=$Request.mode; ports=@($ports); target=$target; owner=$sid; profile=$Request.profile}
    Assert-WebOwnership $before $after $group
    $unchanged = $before.mode -eq $after.mode -and $before.target -eq $after.target
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        $actions = @($task.Actions)
        $taskOwner = $task.Principal.UserId
        if ($taskOwner -notmatch '^S-1-') {
            try { $taskOwner = (New-Object Security.Principal.NTAccount($taskOwner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { throw 'Web refresh task owner cannot be verified.' }
        }
        $expectedArguments = '-File "' + $scriptPath + '" -Refresh'
        if ($actions.Count -ne 1 -or $actions[0].Execute -ne (Join-Path $PSHOME 'powershell.exe') -or -not $actions[0].Arguments.Contains($expectedArguments) -or $taskOwner -ne $sid) { throw 'The web refresh task name is owned by another configuration.' }
    }
    $proxies = @(Get-WebProxies)
    $healthy = $unchanged
    foreach ($port in @($ports)) {
        $rule = Get-NetFirewallRule -PolicyStore ActiveStore -Name ($group + '-' + $port) -ErrorAction SilentlyContinue
        if (-not ($proxies | Where-Object { $_.port -eq $port -and $_.listen -eq '0.0.0.0' -and $_.target -eq $target -and $_.targetPort -eq $port }) -or -not (Test-WebFirewall $rule $port $group)) { $healthy = $false }
    }
    if ($healthy -and $task -and -not $Refresh) {
        if (-not (Test-Path -LiteralPath $scriptPath) -or (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $script:WebScriptPath -Algorithm SHA256).Hash) { $healthy = $false }
    }
    if ($healthy -and ((@($ports).Count -eq 0) -or $task)) { return @{previousMode=$before.mode; mode=$after.mode; target=$target; changed=$false} }
    foreach ($candidate in @($directory)) { Protect-WebDirectory $candidate }
    try {
        Set-WebForwarding $before $after $group
        Save-WebConfiguration $configPath $after
        if (@($ports).Count) {
            if (-not $Refresh) { Copy-Item -LiteralPath $script:WebScriptPath -Destination $scriptPath -Force }
            $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Refresh'
            if ($development) { $arguments += ' -RequestPath development' }
            $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $arguments
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
            $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 2)
            $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Highest
            $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger,$repeat) -Principal $principal -Settings $settings -Description 'Refresh only manager-owned web forwarding after website environment address changes.' -Force | Out-Null
        } elseif ($task) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
    } catch {
        $original = $_
        try {
            Assert-WebOwnership $after $before $group
            Set-WebForwarding $after $before $group
            Save-WebConfiguration $configPath $before
        } catch { throw 'Web networking failed and could not be restored. Inspect manager-owned forwarding before retrying.' }
        throw $original
    }
    return @{previousMode=$before.mode; mode=$after.mode; target=$target; changed=$true}
}

try {
    if ($Refresh) {
        $profile = if ($RequestPath -eq 'development') { 'development' } else { 'production' }
        $group = if ($profile -eq 'development') { 'MuOnline-Web-Dev' } else { 'MuOnline-Web' }
        $configPath = Join-Path (Join-Path (Get-WebProgramFiles) ($group + '-Network')) 'configuration.json'
        $request = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($request.mode -eq 'local') { exit 0 }
    } else {
        $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
    }
    $result = Invoke-WebNetwork $request
    if ($ResultPath) { [IO.File]::WriteAllText($ResultPath, (@{ok=$true; result=$result} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) }
    exit 0
} catch {
    if ($ResultPath) { [IO.File]::WriteAllText($ResultPath, (@{ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false))) }
    exit 1
}
