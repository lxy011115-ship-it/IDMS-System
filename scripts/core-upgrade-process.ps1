param([ValidateSet('Capture','Inspect','Retire','Stopped')][string]$Mode='Inspect',[string]$PlanFile,[int]$ProcessIdToCapture=0,[int]$ListenerPort=0,[int]$DatabasePort=0,[string]$RetirementFile)
$ErrorActionPreference='Stop'
function Read-TaskIdentity($taskPid){
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
 if(-not $p){throw 'Expected process is absent'}
 return @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;createdAt=$p.CreationDate.ToString('o');name=$p.Name;executable=$p.ExecutablePath;commandLine=$p.CommandLine}
}
function Assert-TaskIdentity($e){
 $p=Read-TaskIdentity $e.pid
 if($p.parentPid -ne $e.parentPid -or ([DateTimeOffset]$p.createdAt).UtcDateTime.Ticks -ne ([DateTimeOffset]$e.createdAt).UtcDateTime.Ticks -or $p.name -cne $e.name -or $p.executable -cne $e.executable -or $p.commandLine -cne $e.commandLine){throw 'Pinned process identity differs'}
 return $p
}
function Test-TaskExact($e){
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($e.pid)"
 return ($null -ne $p -and $p.CreationDate.ToUniversalTime().Ticks -eq ([DateTimeOffset]$e.createdAt).UtcDateTime.Ticks)
}
function Get-TaskPorts($taskPid,$pgPort){return @(Get-NetTCPConnection -OwningProcess $taskPid -State Established -ErrorAction SilentlyContinue | Where-Object {$_.RemotePort -eq $pgPort -and $_.RemoteAddress -in @('127.0.0.1','::1')} | Select-Object -ExpandProperty LocalPort -Unique)}
if($Mode -eq 'Capture'){
 $identity=Read-TaskIdentity $ProcessIdToCapture
 @{identity=$identity;postgresClientPorts=@(Get-TaskPorts $identity.pid $DatabasePort)} | ConvertTo-Json -Depth 8
 exit 0
}
$plan=Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
if($plan.format -ne 'idms-core-process-plan-v1' -or $plan.listenerPort -lt 1 -or $plan.databasePort -lt 1){throw 'Invalid process plan'}
foreach($e in $plan.protected){[void](Assert-TaskIdentity $e)}
if($Mode -eq 'Stopped'){
 if((Test-TaskExact $plan.core) -or @(Get-NetTCPConnection -State Listen -LocalPort $plan.listenerPort -ErrorAction SilentlyContinue).Count){throw 'Old exact core or listener still present'}
 if($plan.coordinator -and (Test-TaskExact $plan.coordinator)){throw 'Old exact core coordinator remains live; keep observing'}
 @{oldExactIdentityTerminal=$true;listenerAbsent=$true;protectedCount=@($plan.protected).Count;verifiedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json
 exit 0
}
$core=Assert-TaskIdentity $plan.core
if($plan.coordinator){[void](Assert-TaskIdentity $plan.coordinator)}
$coreBirth=([DateTimeOffset]$core.createdAt).UtcDateTime.Ticks
$descendants=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($core.pid)" | Where-Object {$_.CreationDate.ToUniversalTime().Ticks -ge $coreBirth})
if($descendants.Count){throw ('Core has unexpected current descendants: '+(($descendants | ForEach-Object {$_.Name+':'+$_.ProcessId}) -join ','))}
$owners=@(Get-NetTCPConnection -State Listen -LocalPort $plan.listenerPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if($owners.Count -ne 1 -or $owners[0] -ne $core.pid){throw 'Listener ownership differs'}
$ports=@(Get-TaskPorts $core.pid $plan.databasePort)
if($Mode -eq 'Retire'){
 $request=Get-Content -LiteralPath $RetirementFile -Raw -Encoding UTF8 | ConvertFrom-Json
 $hash=[System.Security.Cryptography.SHA256]::Create()
 try{$planHash=[System.BitConverter]::ToString($hash.ComputeHash([System.IO.File]::ReadAllBytes($PlanFile))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
 if($request.phase -ne 'RETIREMENT_REQUESTED' -or $request.operation -ne $plan.operation -or $request.processPlanSha256 -ne $planHash -or $request.oldCorePid -ne $core.pid -or $request.oldCoreCreatedAt -ne $core.createdAt -or -not $request.sourceGateVerified -or -not $request.actualBeforeArchivesRestored -or -not $request.oldSessionRechecked){throw 'Retirement request must be durably recorded before action'}
 $age=([DateTime]::UtcNow-([DateTimeOffset]$request.recordedAt).UtcDateTime).TotalSeconds
 if($age -lt 0 -or $age -gt 30){throw 'Retirement request is stale'}
 $handle=Get-Process -Id $core.pid
 try{
  [void]$handle.Handle
  $delta=$handle.StartTime.ToUniversalTime().Ticks-([DateTimeOffset]$core.createdAt).UtcDateTime.Ticks
  if($delta -lt 0 -or $delta -ge 10){throw 'Pinned kernel handle creation time differs'}
  [void](Assert-TaskIdentity $plan.core)
  $handle.Kill()
  if(-not $handle.WaitForExit(10000)){throw 'Old kernel handle exit has not been observed'}
 }finally{$handle.Dispose()}
 if((Test-TaskExact $plan.core) -or @(Get-NetTCPConnection -State Listen -LocalPort $plan.listenerPort -ErrorAction SilentlyContinue).Count){throw 'Old exact core or listener still present after kernel exit'}
}
@{identity=$core;postgresClientPorts=$ports;protectedCount=@($plan.protected).Count;retirementRequested=($Mode -eq 'Retire');oldKernelHandleExitObserved=($Mode -eq 'Retire');verifiedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 8
