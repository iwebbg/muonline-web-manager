param([string]$SourcePath = (Join-Path $PSScriptRoot '../runtime/sql-windows.ps1'))
$ErrorActionPreference = 'Stop'
. $SourcePath -InlineRequest '{}' | Out-Null
$script:rules = @{}
$script:added = 0
$script:occupied = $false
$script:listener = $false
$script:instance = @{name='SQLEXPRESS'; id='MSSQL15.SQLEXPRESS'; service='MSSQL$SQLEXPRESS'; pid=42; state='Running'; tcp=@{enabled=$true}}
function Get-SqlInstances { return $script:instance }
function Get-NetTCPConnection {
    [CmdletBinding()] param($State)
    if ($script:occupied) { return @{LocalPort=1433; OwningProcess=999} }
    if ($script:listener) { return @{LocalPort=1433; OwningProcess=42; LocalAddress='0.0.0.0'} }
    return @()
}
function Get-NetIPAddress {
    [CmdletBinding()] param($AddressFamily)
    return @{IPAddress='172.30.176.1'; PrefixLength=20; InterfaceIndex=65}
}
function Get-NetAdapter {
    [CmdletBinding()] param($InterfaceIndex,[switch]$IncludeHidden)
    return @{HardwareInterface=$false}
}
function Get-NetFirewallRule {
    [CmdletBinding()] param($Name,[Parameter(ValueFromPipeline)]$AssociatedNetFirewallPortFilter,$PolicyStore)
    process {
    if ($AssociatedNetFirewallPortFilter) { return $script:rules[$AssociatedNetFirewallPortFilter.RuleName] }
    if ($script:rules.ContainsKey($Name)) { return $script:rules[$Name] }
    return @()
    }
}
function Get-NetFirewallAddressFilter {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject)
    process { return @{LocalAddress=$InputObject.LocalAddress; RemoteAddress=$InputObject.RemoteAddress} }
}
function Get-NetFirewallPortFilter {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject,$Protocol,$PolicyStore)
    process {
      if ($InputObject) { return @{LocalPort=$InputObject.LocalPort; Protocol=$InputObject.Protocol} }
      return @($script:rules.Values | ForEach-Object { @{LocalPort=[string]$_.LocalPort; Protocol=$_.Protocol; RuleName=$_.Name} })
    }
}
function Get-NetFirewallApplicationFilter {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject)
    process { return @{Program='Any'} }
}
function Get-NetFirewallServiceFilter {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject)
    process { return @{Service='Any'} }
}
function New-NetFirewallRule {
    [CmdletBinding()] param($Name,$DisplayName,$Group,$Direction,$Action,$Protocol,$LocalPort,$LocalAddress,$RemoteAddress,$Profile)
    $script:added++
    $script:rules[$Name] = @{Name=$Name; Group=$Group; Profile='Any'; Direction=$Direction; Action=$Action; Protocol=$Protocol; LocalPort=$LocalPort; LocalAddress=$LocalAddress; RemoteAddress=$RemoteAddress; Enabled='True'}
}
function Enable-NetFirewallRule {
    [CmdletBinding()] param($Name)
    $script:rules[$Name].Enabled='True'
}
$request = @{action='firewall'; confirmed=$true; instance='SQLEXPRESS'; port=1433; expected=@{id='MSSQL15.SQLEXPRESS'; service='MSSQL$SQLEXPRESS'}; ruleName='MuOnlineSql-aaaaaaaaaaaaaaaa'; scope=@{localAddress='172.30.176.1'; remoteAddress='172.30.176.0/20'}}
$first = Invoke-Change $request
$second = Invoke-Change $request
if (-not $first.ok -or -not $second.ok -or $script:added -ne 1 -or $second.changed) { throw 'Duplicate firewall contract failed' }
$request.scope.remoteAddress='0.0.0.0/0'
$rejected=$false
try { Invoke-Change $request | Out-Null } catch { $rejected=$true }
if (-not $rejected -or $script:added -ne 1) { throw 'Public firewall scope was not refused' }
$request.scope.remoteAddress='172.30.176.0/20'
$script:occupied=$true
$occupied=Invoke-Change $request
if ($occupied.ok -or $occupied.code -ne 'portOccupied' -or $script:added -ne 1) { throw 'Foreign PID not protected' }
$script:occupied=$false
$script:rules.Clear()
$script:rules['manual-rule'] = @{Name='manual-rule'; Group='manual'; Profile='Any'; Direction='Inbound'; Action='Allow'; Protocol='TCP'; LocalPort='1433'; LocalAddress='172.30.176.1'; RemoteAddress='172.30.176.0/20'; Enabled='True'}
$manual=Invoke-Change $request
if (-not $manual.ok -or $manual.changed -or $script:added -ne 1) { throw 'Equivalent manual rule was duplicated' }
# Install authorizes only the narrow firewall action, with the same observed SQL PID.
$request.installation=$true
$request.expected.pid=42
$script:listener=$true
$automatic=Invoke-Change $request
if (-not $automatic.ok -or $automatic.changed -or $script:added -ne 1) { throw 'Automatic equivalent-rule reuse failed' }
$request.expected.pid=99
$rejected=$false
try { Invoke-Change $request | Out-Null } catch { $rejected=$true }
if (-not $rejected) { throw 'Changed SQL PID was accepted by Install' }
$request.expected.pid=42
$script:listener=$false
$rejected=$false
try { Invoke-Change $request | Out-Null } catch { $rejected=$true }
if (-not $rejected) { throw 'Missing SQL listener was accepted by Install' }
$request.installation=$false
$request.confirmed=$false
$rejected=$false
try { Invoke-Change $request | Out-Null } catch { $rejected=$true }
if (-not $rejected) { throw 'Unconfirmed change was accepted' }
'PASS: real PowerShell functions reject broad scope/foreign PID/unconfirmed changes and never duplicate an exact scoped rule. OS cmdlets were mocked; no Windows settings changed.'
