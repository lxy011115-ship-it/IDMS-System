param(
 [Parameter(Mandatory=$true)][ValidateSet('Identity','Wait','Publish','Journal','Release','Rearm','Archive')][string]$Mode,
 [Parameter(Mandatory=$true)][int]$OwnerPid,
 [string]$OwnerStartTicks,
 [string]$GateName,
 [string]$HostId,
 [string]$ControlFile,
 [string]$Source,
 [string]$Destination,
 [string]$ExpectedSha256,
 [string]$ArchiveRoot,
 [string]$BackupId,
 [string]$TenantId,
 [string]$SourceSha256,
 [switch]$Replace
)
$ErrorActionPreference='Stop'
function Assert-Owner {
 $owner=[Diagnostics.Process]::GetProcessById($OwnerPid)
 if($owner.HasExited -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $OwnerStartTicks){throw 'Recovery owner is no longer the same live process'}
}
function Get-ExactHash([string]$Path){
 $stream=$null
 $hash=$null
 try{
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
  $hash=[Security.Cryptography.SHA256]::Create()
  return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()
 }finally{
  if($hash){$hash.Dispose()}
  if($stream){$stream.Dispose()}
 }
}
if($Mode -eq 'Identity'){
 [Console]::Out.Write([Diagnostics.Process]::GetProcessById($OwnerPid).StartTime.ToUniversalTime().Ticks.ToString())
 exit 0
}
if($Mode -eq 'Wait'){
 if($OwnerStartTicks -notmatch '^\d{17,20}$'){throw 'Invalid native helper identity'}
 try{$helper=[Diagnostics.Process]::GetProcessById($OwnerPid)}catch [ArgumentException]{[Console]::Out.Write('TERMINAL');exit 0}
 try{
  if(-not $helper.HasExited -and $helper.StartTime.ToUniversalTime().Ticks.ToString() -ceq $OwnerStartTicks){$helper.WaitForExit()}
  [Console]::Out.Write('TERMINAL')
 }finally{$helper.Dispose()}
 exit 0
}
if($OwnerStartTicks -notmatch '^\d{17,20}$' -or $GateName -notmatch '^idms-field-recovery-commit-[a-f0-9]{64}$' -or $HostId -notmatch '^[a-f0-9]{64}$'){throw 'Invalid recovery owner or gate'}
$control=[IO.Path]::GetFullPath($ControlFile)
$sourcePath=[IO.Path]::GetFullPath($Source)
$destinationPath=[IO.Path]::GetFullPath($Destination)
$parent=[IO.Path]::GetDirectoryName($control)
$leaf=[IO.Path]::GetFileName($control)
if($leaf -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$' -or $leaf.EndsWith('.')){throw 'Invalid control file name'}
$operations=[IO.Path]::Combine($parent,$leaf+'.operations')
if($Mode -eq 'Archive'){
 $archiveParent=[IO.Path]::GetFullPath($ArchiveRoot)
 if($BackupId -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $TenantId -notmatch '^[A-Za-z0-9_-]{1,80}$' -or $SourceSha256 -notmatch '^[a-f0-9]{64}$' -or $Replace -or $ExpectedSha256 -cne 'MISSING'){throw 'Invalid archive publication identity'}
 if([IO.Path]::GetDirectoryName($sourcePath) -ine $archiveParent -or [IO.Path]::GetDirectoryName($destinationPath) -ine $archiveParent -or [IO.Path]::GetFileName($sourcePath) -cne ('.'+$TenantId+'-'+$BackupId+'.idmsfieldpartial') -or [IO.Path]::GetFileName($destinationPath) -cne ($TenantId+'-'+$BackupId+'.idmsfieldbackup')){throw 'Archive publication is outside declared output workspace'}
}elseif($Mode -eq 'Journal'){
 if([IO.Path]::GetDirectoryName($sourcePath) -ine $operations -or [IO.Path]::GetDirectoryName($destinationPath) -ine $operations -or [IO.Path]::GetFileName($sourcePath) -notmatch '^([a-f0-9-]{36})\.(intent|result|source-freeze-intent|source-freeze-result|archive-intent|archive-ready|archive-result|restore-intent|restore-roles|restore-provision|restore-run-[a-f0-9-]{36}|restore-tool-[a-f0-9-]{36}|restore-phase-(?:pre-data|data|post-data)|restore-verification|restore-result|review-(?:baseline|plan|submit|approve|result)-[a-f0-9-]{36}|activation-(?:publication|baseline|attempt|prepared|result)-[a-f0-9-]{36}|archive-tool-[a-f0-9-]{36})\.tmp$' -or $Replace){throw 'Recovery journal paths are outside the operation workspace'}
 if([IO.Path]::GetFileName($destinationPath) -cne ($Matches[1]+'.'+$Matches[2]+'.json')){throw 'Recovery journal operation does not match'}
}elseif($Mode -eq 'Publish'){
 if([IO.Path]::GetDirectoryName($sourcePath) -ine $operations -or [IO.Path]::GetFileName($sourcePath) -notmatch '^[a-f0-9-]{36}\.(control|lock|activation-(?:active|restoring)-[a-f0-9-]{36})\.tmp$' -or ($destinationPath -ine $control -and $destinationPath -ine ($control+'.operation.lock'))){throw 'Recovery publish paths are outside the declared control workspace'}
 if([IO.Path]::GetFileName($sourcePath) -match '\.activation-' -and ($destinationPath -ine $control -or -not $Replace -or $ExpectedSha256 -notmatch '^[a-f0-9]{64}$')){throw 'Activation control publication requires replacing the exact declared control'}
}elseif($Mode -eq 'Rearm'){
 if([IO.Path]::GetDirectoryName($sourcePath) -ine $operations -or [IO.Path]::GetFileName($sourcePath) -notmatch '^[a-f0-9-]{36}\.activation-released-[a-f0-9-]{36}\.json$' -or $destinationPath -ine ($control+'.operation.lock') -or $Replace -or $ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or (Test-Path -LiteralPath $destinationPath)){throw 'Recovery rearm paths or marker state are outside the declared operation'}
}else{
 if($sourcePath -ine ($control+'.operation.lock') -or [IO.Path]::GetDirectoryName($destinationPath) -ine $operations -or [IO.Path]::GetFileName($destinationPath) -notmatch '^[a-f0-9-]{36}\.(?:released|activation-released-[a-f0-9-]{36})\.json$' -or $Replace){throw 'Recovery release paths are outside the declared control workspace'}
}
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IdmsRecoveryMove {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outBytes, uint inBytes, uint timeout, IntPtr security);
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool MoveFileEx(string source, string destination, int flags);
}
'@
$gate=[IntPtr]::Zero
try{
 $gate=[IdmsRecoveryMove]::CreateNamedPipe('\\.\pipe\'+$GateName,0x00080003,0,255,1,1,0,[IntPtr]::Zero)
 if($gate -eq [IntPtr]::new(-1)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 Assert-Owner
 foreach($path in @($parent,$operations,$sourcePath)){
  if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Recovery paths cannot be reparse points'}
 }
 if(Test-Path -LiteralPath $destinationPath){
  if((Get-Item -LiteralPath $destinationPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Recovery destination cannot be a reparse point'}
 }
 if($ExpectedSha256 -eq 'MISSING'){
  if(Test-Path -LiteralPath $destinationPath){throw 'Recovery destination already exists'}
 }else{
  $checkPath=if($Mode -eq 'Release' -or $Mode -eq 'Rearm'){$sourcePath}else{$destinationPath}
  if($ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-ExactHash $checkPath) -cne $ExpectedSha256){throw 'Recovery compare-and-swap failed'}
 }

 $stamp=[IO.Path]::Combine($operations,'native-helper.json')
 $stampTemp=[IO.Path]::Combine($operations,'native-helper-'+$PID+'.tmp')
 $stampBytes=[Text.Encoding]::UTF8.GetBytes('{"hostId":"'+$HostId+'","pid":'+$PID+',"startTicks":"'+[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()+'"}')
 $stampStream=[IO.File]::Open($stampTemp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try{$stampStream.Write($stampBytes,0,$stampBytes.Length);$stampStream.Flush($true)}finally{$stampStream.Dispose()}
 if(-not [IdmsRecoveryMove]::MoveFileEx($stampTemp,$stamp,9)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 # QA_HOLD_BEFORE_MOVE
 Assert-Owner
 if($Mode -eq 'Archive'){if((Get-Item -LiteralPath $archiveParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Archive root cannot be a reparse point'};if((Get-ExactHash $sourcePath) -cne $SourceSha256){throw 'Archive source hash changed'}}
 Assert-Owner
 $flags=8
 if($Replace){$flags=$flags -bor 1}
 if(-not [IdmsRecoveryMove]::MoveFileEx($sourcePath,$destinationPath,$flags)){
  throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
 }
 # QA_HOLD_AFTER_MOVE
}finally{
 if($gate -ne [IntPtr]::Zero -and $gate -ne [IntPtr]::new(-1)){[void][IdmsRecoveryMove]::CloseHandle($gate)}
}
