param([Parameter(Mandatory=$true)][ValidateSet('Identity','Owner','Inspect','Stop','Wait')][string]$Mode,[Parameter(Mandatory=$true)][int]$OwnerPid,[string]$OwnerStartTicks,[string]$ToolIntentFile,[string]$ExpectedSha256,[int]$TargetPid,[string]$TargetStartTicks)
$ErrorActionPreference='Stop'
if($Mode -eq 'Identity'){$p=[Diagnostics.Process]::GetProcessById($OwnerPid);try{[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString())}finally{$p.Dispose()};exit 0}
if($Mode -eq 'Owner'){
 try{$p=[Diagnostics.Process]::GetProcessById($OwnerPid)}catch [ArgumentException]{[Console]::Out.Write('TERMINAL');exit 0}
 try{if(-not $p.HasExited -and $p.StartTime.ToUniversalTime().Ticks.ToString() -ceq $OwnerStartTicks){[Console]::Out.Write('LIVE')}else{[Console]::Out.Write('TERMINAL')}}finally{$p.Dispose()};exit 0
}
$owner=[Diagnostics.Process]::GetProcessById($OwnerPid)
try{if($owner.HasExited -or $owner.StartTime.ToUniversalTime().Ticks.ToString() -cne $OwnerStartTicks){throw 'Workflow archive controller identity changed'}}finally{$owner.Dispose()}
$path=[IO.Path]::GetFullPath($ToolIntentFile)
if([IO.Path]::GetFileName($path) -notmatch '^workflow-[a-f0-9-]{36}-tool-[a-f0-9-]{36}\.json$' -or (Get-Item -LiteralPath $path -Force).Length -gt 16384 -or (Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Invalid workflow native tool record'}
$bytes=[IO.File]::ReadAllBytes($path);$hash=[Security.Cryptography.SHA256]::Create()
try{$actual=[BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
if($ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or $actual -cne $ExpectedSha256){throw 'Workflow native record changed'}
$intent=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
if($intent.format -cne 'idms-workflow-archive-tool-v2' -or [IO.Path]::GetFileName($intent.program) -ine 'pg_dump.exe' -or $intent.args.Count -ne 9 -or $intent.args[0] -cne '--format=custom' -or $intent.args[1] -cne '--no-owner' -or $intent.args[2] -cne '--no-acl' -or $intent.args[3] -cne '--no-password' -or $intent.args[4] -cne '--strict-names' -or $intent.args[5] -cne '--schema=public' -or $intent.args[6] -notmatch '^--snapshot=[a-fA-F0-9-]{1,64}$' -or $intent.args[7] -cne ('--file='+$intent.dumpFile) -or $intent.args[8] -cne '--lock-wait-timeout=30s'){throw 'Invalid workflow native arguments'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IdmsWorkflowArgv {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string text,out int argc);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static string[] Parse(string text){int count;IntPtr p=CommandLineToArgvW(text,out count);if(p==IntPtr.Zero)throw new Exception("Cannot parse workflow process arguments");try{var a=new string[count];for(int i=0;i<count;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);}}
}
'@
$rows=New-Object Collections.Generic.List[object];$self=[IO.Path]::GetFullPath($PSCommandPath)
foreach($item in Get-CimInstance Win32_Process -Filter "Name='pg_dump.exe' OR Name='powershell.exe'"){
 if($item.ProcessId -eq $PID){continue}
 if(-not $item.CommandLine){if($item.ExecutablePath -ieq $intent.program){throw 'Cannot inspect potentially owned workflow dump'};continue}
 $argv=[IdmsWorkflowArgv]::Parse($item.CommandLine);$kind=$null
 if($item.ExecutablePath -ieq $intent.program -and $argv.Length -eq $intent.args.Count+1){$match=$true;for($n=0;$n -lt $intent.args.Count;$n++){if($argv[$n+1] -cne $intent.args[$n]){$match=$false;break}};if($match){$kind='dump'}}
 elseif($item.Name -ieq 'powershell.exe'){
  $f=[Array]::IndexOf($argv,'-File');$t=[Array]::IndexOf($argv,'-ToolIntentFile');$e=[Array]::IndexOf($argv,'-ExpectedSha256');$o=[Array]::IndexOf($argv,'-OwnerPid');$s=[Array]::IndexOf($argv,'-OwnerStartTicks')
  if($f -ge 0 -and $t -ge 0 -and $e -ge 0 -and $o -ge 0 -and $s -ge 0 -and $argv[$f+1] -ieq $self -and $argv[$t+1] -ieq $path -and $argv[$e+1] -ceq $ExpectedSha256 -and $argv[$o+1] -match '^[1-9][0-9]*$' -and $argv[$s+1] -match '^\d{17,20}$'){$kind='helper'}
 }
 if($kind){try{$p=[Diagnostics.Process]::GetProcessById($item.ProcessId);try{$rows.Add([pscustomobject]@{pid=[int]$item.ProcessId;startTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();kind=$kind})}finally{$p.Dispose()}}catch [ArgumentException]{}}
}
if($Mode -eq 'Inspect'){[Console]::Out.Write((ConvertTo-Json -InputObject @($rows.ToArray()) -Compress));exit 0}
$target=@($rows|Where-Object {$_.pid -eq $TargetPid -and $_.startTicks -ceq $TargetStartTicks})
if($target.Count -eq 0){[Console]::Out.Write('TERMINAL');exit 0}
if($target.Count -ne 1 -or $Mode -eq 'Stop' -and $target[0].kind -cne 'dump'){throw 'Workflow native target ownership differs'}
$p=[Diagnostics.Process]::GetProcessById($TargetPid)
try{if(-not $p.HasExited -and $p.StartTime.ToUniversalTime().Ticks.ToString() -ceq $TargetStartTicks){if($Mode -eq 'Stop'){$p.Kill()};if(-not $p.WaitForExit(15000)){throw 'Workflow native process terminal state unconfirmed'}};[Console]::Out.Write('TERMINAL')}finally{$p.Dispose()}
