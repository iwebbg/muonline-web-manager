# Contract test: every Windows/network/task effect is a mock. No real firewall, WSL or portproxy is touched.
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../runtime/web-network.ps1') -Raw
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)) }
}
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('mu-web-contract-' + [guid]::NewGuid().ToString('N'))
function Get-WebProgramFiles { return $temporary }
$script:WebScriptPath = $PSCommandPath
$Refresh = $false
$script:target = '172.25.16.10'
$script:proxies = @()
$script:rules = @{}
$script:tasks = @{}
$script:effects = 0
$script:conflict = $false
$script:failRule = $false
$script:mode = 'nat'
function Get-WebOwner { 'S-1-5-21-111-222-333-1000' }
function Get-Acl { param($LiteralPath) $value=New-Object psobject; $value | Add-Member ScriptMethod GetOwner { param($Type) [pscustomobject]@{Value='S-1-5-32-544'} }; return $value }
function Protect-WebDirectory { param($Directory) New-Item -ItemType Directory -Path $Directory -Force | Out-Null }
function Copy-Item { param($LiteralPath,$Destination,[switch]$Force) [IO.File]::WriteAllText($Destination, [IO.File]::ReadAllText($LiteralPath)) }
function Invoke-NativeWebCommand {
    param($File,$Arguments)
    if ($File -eq 'wsl.exe') {
        if ($Arguments -contains 'wslinfo') { return $script:mode }
        if ($Arguments -contains 'address') { return ('[{"ifname":"eth0","addr_info":[{"family":"inet","local":"' + $script:target + '"}]}]') }
        if ($Arguments -contains 'route') { return '[{"dev":"eth0","gateway":"172.25.16.1"}]' }
        throw 'Unexpected WSL command'
    }
    Assert ($File -eq 'netsh.exe') 'Unexpected native executable'
    switch ($Arguments[2]) {
        'show' { return (($script:proxies | ForEach-Object { $_.listen + ' ' + $_.port + ' ' + $_.target + ' ' + $_.targetPort }) -join "`n") }
        'add' {
            $script:effects++
            $port=[int](($Arguments | Where-Object { $_ -like 'listenport=*' }) -split '=')[1]
            $target=([string]($Arguments | Where-Object { $_ -like 'connectaddress=*' }) -split '=')[1]
            $script:proxies += [pscustomobject]@{listen='0.0.0.0';port=$port;target=$target;targetPort=$port}
        }
        'delete' { $script:effects++; $port=[int](($Arguments | Where-Object { $_ -like 'listenport=*' }) -split '=')[1]; $script:proxies=@($script:proxies | Where-Object { $_.port -ne $port }) }
        default { throw 'Unexpected netsh action' }
    }
    return ''
}
function Get-NetFirewallRule { param($Name) if ($script:rules.ContainsKey($Name)) { return $script:rules[$Name] } }
function New-NetFirewallRule {
    param($Name,$DisplayName,$Group,$Direction,$Action,$Protocol,$LocalPort,$LocalAddress,$Profile)
    Assert ($Protocol -eq 'TCP' -and $LocalPort -in @(80,443) -and $LocalAddress -eq '0.0.0.0/0') 'Only fixed TCP web ports are allowed'
    if ($script:failRule -and $LocalPort -eq 443) { $script:failRule=$false; throw 'Fixture firewall refusal' }
    $script:rules[$Name]=[pscustomobject]@{Name=$Name;Group=$Group;Enabled='True';Action=$Action;Direction=$Direction;Profile=$Profile}
}
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline)]$InputObject) process { [pscustomobject]@{Protocol='TCP';LocalPort=([string]$InputObject.Name -split '-')[-1]} } }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline)]$InputObject) process { [pscustomobject]@{LocalAddress='0.0.0.0/0';RemoteAddress='Any'} } }
function Remove-NetFirewallRule { param([Parameter(ValueFromPipeline)]$InputObject) process { $script:rules.Remove($InputObject.Name) } }
function Get-NetTCPConnection { param($State,$LocalPort) if ($script:conflict) { [pscustomobject]@{LocalAddress='0.0.0.0';OwningProcess=999} } }
function Get-Process { param($Id) [pscustomobject]@{ProcessName='UnrelatedServer'} }
function Start-Service { param($Name) Assert ($Name -eq 'iphlpsvc') 'Only IP Helper may be started' }
function Get-ScheduledTask { param($TaskName) if ($script:tasks.ContainsKey($TaskName)) { $script:tasks[$TaskName] } }
function New-ScheduledTaskAction { param($Execute,$Argument) [pscustomobject]@{Execute=$Execute;Arguments=$Argument} }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User,[switch]$Once,$At,$RepetitionInterval) [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) Assert ($RunLevel -eq 'Highest' -and $LogonType -eq 'Interactive') 'No stored task password or SYSTEM principal'; [pscustomobject]@{UserId=$UserId} }
function New-ScheduledTaskSettingsSet { param($ExecutionTimeLimit,$MultipleInstances,[switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) [pscustomobject]@{} }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force) $script:tasks[$TaskName]=[pscustomobject]@{Actions=@($Action);Principal=$Principal} }
function Stop-ScheduledTask { param($TaskName) }
function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm) $script:tasks.Remove($TaskName) }
try {
    New-Item -ItemType Directory -Path $temporary -Force | Out-Null
    $script:conflict=$true
    try { Invoke-WebNetwork @{profile='production';mode='domain'}; throw 'Expected service conflict' } catch { Assert ($_.Exception.Message -like '*already used*') 'A foreign listener must refuse configuration' }
    Assert ($script:effects -eq 0) 'Conflict must precede all changes'
    $script:conflict=$false
    $result=Invoke-WebNetwork @{profile='production';mode='domain'}
    Assert ($result.changed -and $result.previousMode -eq 'local') 'Initial domain setup'
    Assert ($script:proxies.Count -eq 2 -and $script:rules.Count -eq 2) 'Both fixed ports must be prepared'
    $count=$script:effects
    $result=Invoke-WebNetwork @{profile='production';mode='domain'}
    Assert (-not $result.changed -and $script:effects -eq $count) 'Healthy preparation must be idempotent'
    $script:target='172.25.16.20'
    $Refresh=$true
    $result=Invoke-WebNetwork @{profile='production';mode='domain'}
    Assert (@($script:proxies | Where-Object { $_.target -ne $script:target }).Count -eq 0) 'Refresh must update only owned targets'
    $Refresh=$false
    $result=Invoke-WebNetwork @{profile='production';mode='ip'}
    Assert ($script:proxies.Count -eq 1 -and $script:proxies[0].port -eq 80) 'IP mode must remove its old TLS forwarding'
    $script:failRule=$true
    try { Invoke-WebNetwork @{profile='production';mode='domain'}; throw 'Expected firewall refusal' } catch { Assert ($_.Exception.Message -like '*Fixture firewall refusal*') 'Original failure must survive successful recovery' }
    Assert ($script:proxies.Count -eq 1 -and $script:proxies[0].port -eq 80) 'Partial firewall failure must restore prior forwarding'
    $script:mode='mirrored'
    try { Invoke-WebNetwork @{profile='production';mode='domain'}; throw 'Expected unverified mode refusal' } catch { Assert ($_.Exception.Message -like '*verified NAT*') 'Unknown/mirrored networking must fail closed' }
    $script:mode='nat'
    $script:proxies[0].target='192.168.55.44'
    $count=$script:effects
    try { Invoke-WebNetwork @{profile='production';mode='local'}; throw 'Expected lost ownership refusal' } catch { Assert ($_.Exception.Message -like '*non-manager*') 'A changed proxy must never be deleted as manager-owned' }
    Assert ($script:effects -eq $count) 'Lost ownership must cause no effects'
    $script:proxies[0].target=$script:target
    $result=Invoke-WebNetwork @{profile='production';mode='local'}
    Assert ($script:proxies.Count -eq 0 -and $script:rules.Count -eq 0 -and $script:tasks.Count -eq 0) 'Local mode must remove owned public exposure and task'
    'PASS: Windows web network contracts (all OS effects mocked)'
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
