param([string]$RequestPath = '', [string]$ResultPath = '', [string]$InlineRequest = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Every operation resolves an instance from the registry again. No caller supplies registry paths or service names.
function Get-SqlInstances {
    $items = @()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
        try {
            $map = $base.OpenSubKey('SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL')
            if ($null -eq $map) { continue }
            try {
                foreach ($name in $map.GetValueNames()) {
                    $id = [string]$map.GetValue($name)
                    if ($name -notmatch '^[A-Za-z0-9_.-]{1,128}$' -or $id -notmatch '^[A-Za-z0-9_.-]+$') { continue }
                    if (@($items | Where-Object { $_.name -eq $name }).Count -gt 0) { continue }
                    $serviceName = if ($name -eq 'MSSQLSERVER') { 'MSSQLSERVER' } else { 'MSSQL$' + $name }
                    $service = Get-CimInstance Win32_Service -Filter ("Name='" + $serviceName + "'") -ErrorAction SilentlyContinue
                    $path = 'SOFTWARE\Microsoft\Microsoft SQL Server\' + $id + '\MSSQLServer'
                    $server = $base.OpenSubKey($path)
                    $setup = $base.OpenSubKey('SOFTWARE\Microsoft\Microsoft SQL Server\' + $id + '\Setup')
                    $tcp = $base.OpenSubKey($path + '\SuperSocketNetLib\Tcp')
                    $sections = @()
                    if ($null -ne $tcp) {
                        foreach ($sectionName in $tcp.GetSubKeyNames()) {
                            if ($sectionName -notmatch '^IP(All|[0-9]+)$') { continue }
                            $section = $tcp.OpenSubKey($sectionName)
                            try {
                                $sections += @{name=$sectionName; address=[string]$section.GetValue('IpAddress',''); enabled=([int]$section.GetValue('Enabled',0) -eq 1); active=([int]$section.GetValue('Active',0) -eq 1); dynamicPort=[string]$section.GetValue('TcpDynamicPorts',''); port=[string]$section.GetValue('TcpPort','')}
                            } finally { $section.Dispose() }
                        }
                    }
                    $mode = if ($null -ne $server) { $server.GetValue('LoginMode',$null) } else { $null }
                    $version = if ($null -ne $setup) { [string]$setup.GetValue('Version','') } else { '' }
                    $items += @{name=$name; id=$id; view=[string]$view; service=$serviceName; state=$(if ($service) { [string]$service.State } else { 'Unknown' }); pid=$(if ($service) { [int]$service.ProcessId } else { 0 }); version=$version; loginMode=$mode; tcp=@{unknown=($null -eq $tcp); enabled=($null -ne $tcp -and [int]$tcp.GetValue('Enabled',0) -eq 1); listenAll=($null -ne $tcp -and [int]$tcp.GetValue('ListenOnAllIPs',0) -eq 1); sections=@($sections)}}
                    if ($null -ne $server) { $server.Dispose() }
                    if ($null -ne $tcp) { $tcp.Dispose() }
                    if ($null -ne $setup) { $setup.Dispose() }
                }
            } finally { $map.Dispose() }
        } finally { $base.Dispose() }
    }
    return @($items)
}

# Active-store rules explicitly mentioning the SQL port; other policies still need end-to-end tests.
function Get-SqlPortRules([int]$port) {
    $filters = @(Get-NetFirewallPortFilter -Protocol TCP -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { @($_.LocalPort) -contains [string]$port })
    return @($filters | Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Where-Object { [string]$_.Direction -eq 'Inbound' })
}

# NetSecurity accepts prefix lengths and dotted masks; compare address sets, not spelling.
function ConvertTo-CanonicalFirewallAddress([string]$value) {
    $parts = $value.Trim().Split('/')
    if ($parts.Count -gt 2) { return $null }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($parts[0],[ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $address.ToString() -cne $parts[0]) { return $null }
    $prefix = 32
    if ($parts.Count -eq 2) {
        if ($parts[1] -match '^\d{1,2}$') { $prefix = [int]$parts[1] }
        else {
            $maskAddress = $null
            if (-not [Net.IPAddress]::TryParse($parts[1],[ref]$maskAddress) -or $maskAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $maskAddress.ToString() -cne $parts[1]) { return $null }
            $prefix = 0; $zeroSeen = $false
            foreach ($octet in $maskAddress.GetAddressBytes()) {
                for ($bit=7; $bit -ge 0; $bit--) {
                    if (($octet -band (1 -shl $bit)) -ne 0) {
                        if ($zeroSeen) { return $null }
                        $prefix += 1
                    } else { $zeroSeen=$true }
                }
            }
        }
    }
    if ($prefix -lt 0 -or $prefix -gt 32) { return $null }
    $bytes = $address.GetAddressBytes(); $remaining = $prefix
    for ($index=0; $index -lt 4; $index++) {
        $bits = [Math]::Max(0,[Math]::Min(8,$remaining))
        $mask = if ($bits -eq 0) { 0 } else { (255 -shl (8-$bits)) -band 255 }
        $bytes[$index] = $bytes[$index] -band $mask
        $remaining -= 8
    }
    return ($bytes -join '.') + '/' + $prefix
}

function Test-FirewallAddressMatch([string]$actual,[string]$expected) {
    $canonical = ConvertTo-CanonicalFirewallAddress $actual
    return $null -ne $canonical -and $canonical -ceq (ConvertTo-CanonicalFirewallAddress $expected)
}

function Get-EquivalentSqlRule($scope,[int]$port) {
    foreach ($rule in @(Get-SqlPortRules $port)) {
        if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Action -ne 'Allow' -or [string]$rule.Profile -ne 'Any') { continue }
        $addresses = $rule | Get-NetFirewallAddressFilter
        $ports = $rule | Get-NetFirewallPortFilter
        $application = $rule | Get-NetFirewallApplicationFilter
        $service = $rule | Get-NetFirewallServiceFilter
        if ((Test-FirewallAddressMatch ($addresses.LocalAddress -join ',') $scope.localAddress) -and (Test-FirewallAddressMatch ($addresses.RemoteAddress -join ',') $scope.remoteAddress) -and ($ports.LocalPort -join ',') -eq [string]$port -and [string]$application.Program -eq 'Any' -and [string]$service.Service -eq 'Any') { return $rule }
    }
    return $null
}

# Read facts only. SQL passwords and connection strings are never inventory fields.
function Get-Inventory($request) {
    $result = @{instances=@(); addresses=@(); listeners=@(); firewallRules=@(); firewallProfiles=@()}
    try { $result.instances = @(Get-SqlInstances) } catch { $result.error='inventoryUnavailable' }
    try {
        $adapters = @(Get-NetAdapter -IncludeHidden)
        foreach ($address in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)) {
            if ($address.IPAddress -eq '127.0.0.1' -or $address.AddressState -notin @('Preferred','Tentative')) { continue }
            $adapter = $adapters | Where-Object { $_.InterfaceIndex -eq $address.InterfaceIndex } | Select-Object -First 1
            $result.addresses += @{address=[string]$address.IPAddress; prefixLength=[int]$address.PrefixLength; interface=[string]$address.InterfaceAlias; virtual=($null -ne $adapter -and -not $adapter.HardwareInterface)}
        }
    } catch { $result.addressError='addressesUnavailable' }
    try {
        foreach ($listener in @(Get-NetTCPConnection -State Listen -ErrorAction Stop)) {
            $result.listeners += @{address=[string]$listener.LocalAddress; port=[int]$listener.LocalPort; pid=[int]$listener.OwningProcess}
        }
    } catch { $result.listenerError='listenersUnavailable' }
    try {
        $result.firewallProfiles = @(Get-NetFirewallProfile | ForEach-Object { @{name=[string]$_.Name; enabled=[bool]$_.Enabled; defaultInboundAction=[string]$_.DefaultInboundAction} })
        $port = if ([int]$request.port -ge 1 -and [int]$request.port -le 65535) { [int]$request.port } else { 1433 }
        $managed = @(Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.Group -eq 'MuOnline Web Manager SQL' })
        $rules = @(@($managed) + @(Get-SqlPortRules $port) | Sort-Object -Property Name -Unique)
        $result.firewallPartial = $rules.Count -gt 100
        foreach ($rule in @($rules | Select-Object -First 100)) {
            $addresses = $rule | Get-NetFirewallAddressFilter
            $ports = $rule | Get-NetFirewallPortFilter
            $application = $rule | Get-NetFirewallApplicationFilter
            $service = $rule | Get-NetFirewallServiceFilter
            $result.firewallRules += @{name=[string]$rule.Name; managed=($rule.Group -eq 'MuOnline Web Manager SQL'); profile=[string]$rule.Profile; program=[string]$application.Program; service=[string]$service.Service; enabled=([string]$rule.Enabled -eq 'True'); localAddress=($addresses.LocalAddress -join ','); remoteAddress=($addresses.RemoteAddress -join ','); port=($ports.LocalPort -join ','); action=[string]$rule.Action; direction=[string]$rule.Direction; protocol=[string]$ports.Protocol}
        }
    } catch { $result.firewallError='firewallUnavailable' }
    $selectedName = [string]$request.instance
    $selected = @($result.instances | Where-Object { $_.name -eq $selectedName })
    if ($selected.Count -eq 1) {
        $result.localSqlMetadata = Get-LocalSqlMetadata $selected[0] @($request.loginNames)
    }
    return $result
}

# Shared-memory Windows authentication supplies optional local facts even when SQL authentication fails.
function Get-LocalSqlMetadata($instance, $loginNames) {
    $connection = $null
    try {
        $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
        $builder.DataSource = if ($instance.name -eq 'MSSQLSERVER') { 'lpc:.' } else { 'lpc:.\' + $instance.name }
        $builder.InitialCatalog = 'master'
        $builder.IntegratedSecurity = $true
        $builder.ConnectTimeout = 3
        $builder.Pooling = $false
        $builder.ApplicationName = 'MuOnline read-only local SQL metadata'
        $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
        $connection.Open()
        $query = $connection.CreateCommand()
        $query.CommandTimeout = 5
        $query.CommandText = "SELECT CONVERT(int,SERVERPROPERTY('IsIntegratedSecurityOnly')) AS windowsOnly, CONVERT(varchar(64),SERVERPROPERTY('ProductVersion')) AS version, IS_SRVROLEMEMBER('sysadmin') AS isAdmin, HAS_PERMS_BY_NAME(NULL,NULL,'VIEW ANY DEFINITION') AS viewDefinitions"
        $reader = $query.ExecuteReader()
        $null = $reader.Read()
        $facts = @{windowsOnly=[int]$reader['windowsOnly']; version=[string]$reader['version']; visible=([int]$reader['isAdmin'] -eq 1); logins=@()}
        $reader.Close()
        foreach ($name in @($loginNames | Select-Object -Unique | Select-Object -First 4)) {
            if ([string]::IsNullOrWhiteSpace($name) -or ([string]$name).Length -gt 128 -or ([string]$name) -match '[\x00-\x1f]') { continue }
            $query = $connection.CreateCommand()
            $query.CommandTimeout = 5
            $query.CommandText = "SELECT p.is_disabled, s.state_desc FROM sys.server_principals p LEFT JOIN sys.server_permissions s ON s.grantee_principal_id=p.principal_id AND s.permission_name='CONNECT SQL' WHERE p.name=@login"
            $null = $query.Parameters.Add('@login',[System.Data.SqlDbType]::NVarChar,128)
            $query.Parameters['@login'].Value = [string]$name
            $reader = $query.ExecuteReader()
            $found = $reader.Read()
            $facts.logins += @{name=[string]$name; found=$found; enabled=$(if ($found) { [int]$reader['is_disabled'] -eq 0 } else { $null }); explicitConnect=$(if ($found -and -not $reader.IsDBNull(1)) { [string]$reader['state_desc'] } else { '' }); metadataVisible=$facts.visible}
            $reader.Close()
        }
        return $facts
    } catch { return @{unknown=$true; logins=@()} } finally { if ($null -ne $connection) { $connection.Dispose() } }
}

function Assert-PrivateScope($scope) {
    $local = $null
    if (-not [System.Net.IPAddress]::TryParse([string]$scope.localAddress,[ref]$local) -or $local.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { throw 'Invalid scope' }
    $parts = ([string]$scope.remoteAddress).Split('/')
    if ($parts.Count -ne 2 -or [int]$parts[1] -lt 8 -or [int]$parts[1] -gt 30 -or $parts[0] -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)') { throw 'Unsafe scope' }
    $minimumPrivatePrefix = if ($parts[0].StartsWith('10.')) { 8 } elseif ($parts[0].StartsWith('172.')) { 12 } else { 16 }
    if ([int]$parts[1] -lt $minimumPrivatePrefix) { throw 'Scope includes public addresses' }
    $base = $null
    if (-not [System.Net.IPAddress]::TryParse($parts[0],[ref]$base)) { throw 'Invalid subnet' }
    $current = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq [string]$scope.localAddress -and $_.PrefixLength -eq [int]$parts[1] })
    if ($current.Count -ne 1) { throw 'Stale scope' }
    $adapter = Get-NetAdapter -InterfaceIndex $current[0].InterfaceIndex -IncludeHidden
    if ($adapter.HardwareInterface) { throw 'Not a virtual adapter' }
    $ipBytes = $local.GetAddressBytes()
    $baseBytes = $base.GetAddressBytes()
    $remaining = [int]$parts[1]
    for ($index=0; $index -lt 4; $index++) {
        $bits = [Math]::Max(0,[Math]::Min(8,$remaining))
        $mask = if ($bits -eq 0) { 0 } else { (255 -shl (8-$bits)) -band 255 }
        if (($ipBytes[$index] -band $mask) -ne $baseBytes[$index]) { throw 'Subnet mismatch' }
        $remaining -= 8
    }
}

# Caller approved a preview. Elevation still revalidates the exact instance, observed values and scope.
function Invoke-Change($request) {
    if ($request.action -notin @('restart','mixedMode','tcpPort','firewall') -or $request.confirmed -ne $true) { throw 'Unconfirmed change' }
    $selected = @(Get-SqlInstances | Where-Object { $_.name -eq [string]$request.instance })
    if ($selected.Count -ne 1) { throw 'Unknown instance' }
    $instance = $selected[0]
    if ($instance.id -ne $request.expected.id -or $instance.service -ne $request.expected.service) { throw 'Changed instance' }
    $port = [int]$request.port
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid port' }
    if ($request.action -eq 'restart') {
        $dependents = @(Get-Service -Name $instance.service -DependentServices | Where-Object { $_.Status -eq 'Running' })
        if ($dependents.Count -gt 0) { return @{ok=$false; code='dependentServices'; changed=$false} }
        Restart-Service -Name $instance.service -ErrorAction Stop
        (Get-Service -Name $instance.service).WaitForStatus('Running',[TimeSpan]::FromSeconds(60))
        return @{ok=$true; code='serviceRestarted'; changed=$true}
    }
    if ($request.action -in @('tcpPort','firewall')) {
        $occupied = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port -and $_.OwningProcess -ne $instance.pid })
        if ($occupied.Count -gt 0) { return @{ok=$false; code='portOccupied'; changed=$false} }
    }
    if ($request.action -eq 'firewall') {
        Assert-PrivateScope $request.scope
        if ($request.installation -eq $true) {
            if ($instance.state -ne 'Running' -or -not $instance.tcp.enabled -or $instance.pid -ne $request.expected.pid) { throw 'SQL listener changed' }
            $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $port -and $_.OwningProcess -eq $instance.pid -and $_.LocalAddress -in @('0.0.0.0','::',[string]$request.scope.localAddress) })
            if ($listeners.Count -eq 0) { throw 'SQL listener missing' }
        }
        if ([string]$request.ruleName -notmatch '^MuOnlineSql-[a-f0-9]{16}$') { throw 'Invalid rule name' }
        $existing = @(Get-NetFirewallRule -Name $request.ruleName -ErrorAction SilentlyContinue)
        if ($existing.Count -gt 0) {
            $addresses = $existing[0] | Get-NetFirewallAddressFilter
            $ports = $existing[0] | Get-NetFirewallPortFilter
            $application = $existing[0] | Get-NetFirewallApplicationFilter
            $serviceFilter = $existing[0] | Get-NetFirewallServiceFilter
            $script:changeEvidence = @{expectedScope=$request.scope; observed=@{name=[string]$existing[0].Name; profile=[string]$existing[0].Profile; program=[string]$application.Program; service=[string]$serviceFilter.Service; group=[string]$existing[0].Group; localAddress=($addresses.LocalAddress -join ','); remoteAddress=($addresses.RemoteAddress -join ','); port=($ports.LocalPort -join ','); protocol=[string]$ports.Protocol; action=[string]$existing[0].Action; direction=[string]$existing[0].Direction}}
            if ([string]$existing[0].Profile -ne 'Any' -or [string]$application.Program -ne 'Any' -or [string]$serviceFilter.Service -ne 'Any' -or [string]$existing[0].Group -ne 'MuOnline Web Manager SQL' -or -not (Test-FirewallAddressMatch ($addresses.LocalAddress -join ',') $request.scope.localAddress) -or -not (Test-FirewallAddressMatch ($addresses.RemoteAddress -join ',') $request.scope.remoteAddress) -or ($ports.LocalPort -join ',') -ne [string]$port -or [string]$existing[0].Action -ne 'Allow' -or [string]$existing[0].Direction -ne 'Inbound' -or [string]$ports.Protocol -notin @('TCP','6')) { throw 'Existing rule mismatch' }
            $changed = [string]$existing[0].Enabled -ne 'True'
            if ($changed) { Enable-NetFirewallRule -Name $request.ruleName | Out-Null }
            return @{ok=$true; code='firewallExists'; changed=$changed}
        }
        if ($null -ne (Get-EquivalentSqlRule $request.scope $port)) { return @{ok=$true; code='firewallExists'; changed=$false} }
        New-NetFirewallRule -Name $request.ruleName -DisplayName ('SQL Server ' + $port + ' from WSL') -Group 'MuOnline Web Manager SQL' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -LocalAddress $request.scope.localAddress -RemoteAddress $request.scope.remoteAddress -Profile Any | Out-Null
        return @{ok=$true; code='firewallApplied'; changed=$true}
    }
    $view = [Enum]::Parse([Microsoft.Win32.RegistryView],[string]$instance.view)
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
    $path = 'SOFTWARE\Microsoft\Microsoft SQL Server\' + $instance.id + '\MSSQLServer'
    try {
        if ($request.action -eq 'mixedMode') {
            $key = $base.OpenSubKey($path,$true)
            try {
                if ($key.GetValue('LoginMode',$null) -ne $request.expected.loginMode) { throw 'Changed login mode' }
                $key.SetValue('LoginMode',2,[Microsoft.Win32.RegistryValueKind]::DWord)
            } finally { $key.Dispose() }
            return @{ok=$true; code='restartRequired'; changed=$true}
        }
        if ([string]$request.section -notmatch '^IP(All|[0-9]+)$') { throw 'Invalid section' }
        if ($instance.tcp.listenAll -ne $request.expected.tcp.listenAll) { throw 'Changed Listen All' }
        if ($instance.tcp.listenAll -and $request.section -ne 'IPAll') { throw 'Use IPAll' }
        if (-not $instance.tcp.listenAll -and $request.section -eq 'IPAll') { throw 'Use specific IP section' }
        $section = @($instance.tcp.sections | Where-Object { $_.name -eq $request.section })
        if ($section.Count -ne 1) { throw 'Missing section' }
        if ($section[0].dynamicPort -ne $request.expectedSection.dynamicPort -or $section[0].port -ne $request.expectedSection.port -or $instance.tcp.enabled -ne $request.expected.tcp.enabled) { throw 'Changed TCP settings' }
        $tcp = $base.OpenSubKey($path + '\SuperSocketNetLib\Tcp',$true)
        $ip = $tcp.OpenSubKey($request.section,$true)
        try {
            $tcp.SetValue('Enabled',1,[Microsoft.Win32.RegistryValueKind]::DWord)
            $ip.SetValue('TcpDynamicPorts','',[Microsoft.Win32.RegistryValueKind]::String)
            $ip.SetValue('TcpPort',[string]$port,[Microsoft.Win32.RegistryValueKind]::String)
        } catch {
            try {
                $tcp.SetValue('Enabled',[int]$request.expected.tcp.enabled,[Microsoft.Win32.RegistryValueKind]::DWord)
                $ip.SetValue('TcpDynamicPorts',[string]$request.expectedSection.dynamicPort,[Microsoft.Win32.RegistryValueKind]::String)
                $ip.SetValue('TcpPort',[string]$request.expectedSection.port,[Microsoft.Win32.RegistryValueKind]::String)
            } catch { return @{ok=$false; code='configurationRecoveryFailed'; changed=$true} }
            return @{ok=$false; code='configurationRestored'; changed=$false}
        } finally { $ip.Dispose(); $tcp.Dispose() }
        return @{ok=$true; code='restartRequired'; changed=$true}
    } finally { $base.Dispose() }
}

$script:changeEvidence = $null
try {
    $inputText = if ($InlineRequest) { $InlineRequest } elseif ($RequestPath) { [IO.File]::ReadAllText($RequestPath) } else { [Console]::In.ReadToEnd() }
    $request = $inputText | ConvertFrom-Json
    $result = if ($request.operation -eq 'inventory') { @{ok=$true; result=(Get-Inventory $request)} } elseif ($request.operation -eq 'change') { Invoke-Change $request } else { @{ok=$false; code='unsupportedOperation'} }
} catch {
    $code = if ($_.Exception.Message -eq 'Existing rule mismatch') { 'firewallRuleMismatch' } else { 'windowsDiagnosticUnavailable' }
    $detail = if ($request.operation -eq 'change') { $_.Exception.Message.Substring(0,[Math]::Min(600,$_.Exception.Message.Length)) } else { $null }
    # Change requests contain public Windows metadata only, never SQL credentials.
    $result = @{ok=$false; code=$code; changed=$false; evidence=$script:changeEvidence; detail=$detail}
}
$json = ConvertTo-Json -InputObject $result -Depth 20 -Compress
if ($ResultPath) { [IO.File]::WriteAllText($ResultPath,$json,(New-Object System.Text.UTF8Encoding($false))) } else { [Console]::Out.WriteLine($json) }
