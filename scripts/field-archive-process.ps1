param([Parameter(Mandatory=$true)][ValidateSet('Inspect','Stop','Wait')][string]$Mode,[Parameter(Mandatory=$true)][string]$ToolIntentFile,[Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][string]$OwnerStartTicks,[int]$TargetPid,[string]$TargetStartTicks)
$ErrorActionPreference='Stop'
$owner=[Diagnostics.Process]::GetProcessById($OwnerPid)
if($owner.HasExited -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $OwnerStartTicks){throw 'Archive controller is no longer the same live process'}
$file=[IO.Path]::GetFullPath($ToolIntentFile)
if([IO.Path]::GetFileName($file) -notmatch '^[a-f0-9-]{36}\.(?:archive|restore)-tool-[a-f0-9-]{36}\.json$' -or (Get-Item -LiteralPath $file -Force).Length -gt 8192 -or (Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Invalid archive tool intent path'}
$bytes=[IO.File]::ReadAllBytes($file);$hash=[Security.Cryptography.SHA256]::Create()
try{$actual=[BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
if($ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or $actual -cne $ExpectedSha256){throw 'Archive tool intent changed'}
$intent=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IdmsArchiveArgv {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string[] Parse(string text) { int count; IntPtr p=CommandLineToArgvW(text,out count);if(p==IntPtr.Zero)throw new Exception("Cannot inspect owned archive arguments");try{var a=new string[count];for(int i=0;i<count;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);} }
}
'@
$rows=New-Object Collections.Generic.List[object]
$selfScript=[IO.Path]::GetFullPath($PSCommandPath)
foreach($item in Get-CimInstance Win32_Process -Filter "Name='pg_dump.exe' OR Name='pg_restore.exe' OR Name='psql.exe' OR Name='powershell.exe'"){
 if($item.ProcessId -eq $PID){continue}
 if(-not $item.CommandLine){if($item.ExecutablePath -ieq $intent.program){throw 'Cannot inspect a potentially owned archive process'};continue}
 $argv=[IdmsArchiveArgv]::Parse($item.CommandLine)
 $kind=$null
 if($item.ExecutablePath -ieq $intent.program -and $argv.Length -eq ($intent.args.Count+1)){
  $match=$true
  for($n=0;$n -lt $intent.args.Count;$n++){if($argv[$n+1] -cne $intent.args[$n]){$match=$false;break}}
  if($match){$kind='dump'}
 }elseif($item.Name -ieq 'powershell.exe'){
  $f=[Array]::IndexOf($argv,'-File');$t=[Array]::IndexOf($argv,'-ToolIntentFile');$o=[Array]::IndexOf($argv,'-OwnerPid');$e=[Array]::IndexOf($argv,'-ExpectedSha256');$s=[Array]::IndexOf($argv,'-OwnerStartTicks')
  # A retry can itself die. Its inspector belongs to the same durable tool
  # record even though that retry's PID differs from the original dump owner.
  if($f -ge 0 -and $t -ge 0 -and $o -ge 0 -and $e -ge 0 -and $s -ge 0 -and $argv[$f+1] -ieq $selfScript -and $argv[$t+1] -ieq $file -and $argv[$e+1] -ceq $ExpectedSha256 -and $argv[$o+1] -match '^[1-9][0-9]*$' -and $argv[$s+1] -match '^\d{17,20}$'){$kind='helper'}
 }
 if($kind){try{$process=[Diagnostics.Process]::GetProcessById($item.ProcessId);$ticks=$process.StartTime.ToUniversalTime().Ticks.ToString();$rows.Add([pscustomobject]@{pid=[int]$item.ProcessId;startTicks=$ticks;kind=$kind});$process.Dispose()}catch [ArgumentException] {}}
}
if($Mode -eq 'Inspect'){[Console]::Out.Write((ConvertTo-Json -InputObject @($rows.ToArray()) -Compress));exit 0}
$target=@($rows|Where-Object {$_.pid -eq $TargetPid -and $_.startTicks -ceq $TargetStartTicks})
if($target.Count -eq 0){[Console]::Out.Write('TERMINAL');exit 0}
if($target.Count -ne 1 -or ($Mode -eq 'Stop' -and $target[0].kind -cne 'dump')){throw 'Archive target is not an identified owned dump process'}
$process=[Diagnostics.Process]::GetProcessById($TargetPid)
try{if(-not $process.HasExited -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ceq $TargetStartTicks){if($Mode -eq 'Stop'){$process.Kill()};$process.WaitForExit()};[Console]::Out.Write('TERMINAL')}finally{$process.Dispose()}
