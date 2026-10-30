param(
 [Parameter(Mandatory=$true)][string]$JobFile,
 [Parameter(Mandatory=$true)][string]$NodeExecutable,
 [switch]$RestrictedChild
)
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'VERIFICATION_JOB_WINDOWS_REQUIRED' }
$jobItem=Get-Item -LiteralPath $JobFile
$nodeItem=Get-Item -LiteralPath $NodeExecutable
$supervisorItem=Get-Item -LiteralPath (Join-Path $PSScriptRoot 'owned-verification-job-v1.mjs')
$jobSpec=Get-Content -LiteralPath $jobItem.FullName -Raw -Encoding utf8 | ConvertFrom-Json
if ($jobSpec.format -ne 1 -or $jobSpec.purpose -ne 'IDMS_OWNED_VERIFICATION_JOB_V1' -or $jobSpec.jobId -notmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$') { throw 'VERIFICATION_JOB_ENVELOPE' }
if ((Get-FileHash -LiteralPath $nodeItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $jobSpec.nodeSha256 -or (Get-FileHash -LiteralPath $supervisorItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $jobSpec.supervisorSha256) { throw 'VERIFICATION_JOB_SOURCE_CHANGED' }
foreach ($taskPath in @($nodeItem.FullName,$supervisorItem.FullName,$jobItem.FullName,$PSCommandPath)) {
 if ($taskPath.Contains('"') -or $taskPath -match '[\x00-\x1f\x7f]') { throw 'VERIFICATION_JOB_COMMAND_PATH' }
}
if (-not $RestrictedChild) {
 $environmentPairs=@()
 foreach ($environmentName in @('SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATH','USERDOMAIN','USERNAME','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramFiles','ProgramData','HOMEDRIVE','HOMEPATH')) {
  $environmentValue=[Environment]::GetEnvironmentVariable($environmentName)
  if ($null -ne $environmentValue) { $environmentPairs+=($environmentName+'='+$environmentValue) }
 }
 $hostPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
 $startupInfo=New-CimInstance -ClassName Win32_ProcessStartup -Namespace 'root/cimv2' -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]8;EnvironmentVariables=[string[]]$environmentPairs}
 $commandLine='"'+$hostPath+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -JobFile "'+$jobItem.FullName+'" -NodeExecutable "'+$nodeItem.FullName+'" -RestrictedChild'
 $created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine;CurrentDirectory=[string]$jobSpec.workingDirectory;ProcessStartupInformation=$startupInfo}
 if ($created.ReturnValue -ne 0 -or $created.ProcessId -le 0) { throw 'VERIFICATION_JOB_RESTRICTED_PARENT_CREATE_FAILED' }
 [ordered]@{format='IDMS_VERIFICATION_RESTRICTED_OS_PARENT_V1';jobId=$jobSpec.jobId;launcherPid=[int]$created.ProcessId;win32ReturnValue=[int]$created.ReturnValue;hidden=$true;accountChanged=$false;administratorPrivilegesRequested=$false} | ConvertTo-Json -Compress
 exit 0
}
# Create only the pinned Node supervisor, under a restricted copy of this account's token.
# No alternate credentials, service, scheduled task, arbitrary command, or process adoption.
$source=@'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
public sealed class IdmsRestrictedLaunchV1 {
 public int Pid;
 public string CreatedFileTime;
 public bool SameAccount,AdministratorsEnabled,PowerUsersEnabled;
}
public static class IdmsRestrictedSupervisorV1 {
 [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid;public uint Attributes; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo { public int cb;public string reserved,desktop,title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public ushort show,cbReserved;public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread;public uint pid,threadId; }
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out FileTime a,out FileTime b,out FileTime c,out FileTime d);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disableCount,[In] SidAndAttributes[] disable,uint deleteCount,IntPtr delete,uint restrictCount,IntPtr restrict,out IntPtr result);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr result);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CheckTokenMembership(IntPtr token,IntPtr sid,out bool member);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
 static void Need(bool value) { if(!value)throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static IdmsRestrictedLaunchV1 Start(string executable,string command,string directory) {
  IntPtr original=IntPtr.Zero,restricted=IntPtr.Zero,impersonation=IntPtr.Zero;ProcessInfo process=new ProcessInfo();
  SidAndAttributes[] groups=new SidAndAttributes[2];
  try {
   string user=WindowsIdentity.GetCurrent().User.Value;
   string[] ids={"S-1-5-32-544","S-1-5-32-547"};
   for(int i=0;i<ids.Length;i++){SecurityIdentifier sid=new SecurityIdentifier(ids[i]);byte[] bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);groups[i].Sid=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,groups[i].Sid,bytes.Length);}
   Need(OpenProcessToken(GetCurrentProcess(),0xB,out original));
   Need(CreateRestrictedToken(original,1,2,groups,0,IntPtr.Zero,0,IntPtr.Zero,out restricted));
   Need(DuplicateToken(restricted,2,out impersonation));
   bool admin,power;Need(CheckTokenMembership(impersonation,groups[0].Sid,out admin));Need(CheckTokenMembership(impersonation,groups[1].Sid,out power));
   bool same=new WindowsIdentity(restricted).User.Value==user;
   if(admin||power||!same)throw new InvalidOperationException("VERIFICATION_JOB_RESTRICTED_TOKEN_NOT_PROVEN");
   StartupInfo startup=new StartupInfo();startup.cb=Marshal.SizeOf(typeof(StartupInfo));startup.flags=1;startup.show=0;
   Need(CreateProcessAsUserW(restricted,executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000400,IntPtr.Zero,directory,ref startup,out process));
   FileTime a,b,c,d;Need(GetProcessTimes(process.process,out a,out b,out c,out d));
   return new IdmsRestrictedLaunchV1{Pid=(int)process.pid,CreatedFileTime=(((ulong)a.high<<32)|a.low).ToString(),SameAccount=same,AdministratorsEnabled=admin,PowerUsersEnabled=power};
  } finally {
   if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);
   if(impersonation!=IntPtr.Zero)CloseHandle(impersonation);if(restricted!=IntPtr.Zero)CloseHandle(restricted);if(original!=IntPtr.Zero)CloseHandle(original);
   foreach(SidAndAttributes g in groups)if(g.Sid!=IntPtr.Zero)Marshal.FreeHGlobal(g.Sid);
  }
 }
}
'@
$restrictedStage='COMPILE'
try {
Add-Type -TypeDefinition $source -Language CSharp
$restrictedStage='CREATE_RESTRICTED_SUPERVISOR'
$commandLine='"'+$nodeItem.FullName+'" "'+$supervisorItem.FullName+'" --supervise "'+$jobItem.FullName+'"'
$launched=[IdmsRestrictedSupervisorV1]::Start($nodeItem.FullName,$commandLine,[string]$jobSpec.workingDirectory)
$receipt=[ordered]@{format='IDMS_VERIFICATION_JOB_RESTRICTED_OS_LAUNCH_V1';jobId=$jobSpec.jobId;inputSha256=(Get-FileHash -LiteralPath $jobItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant();launcherSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();supervisorPid=$launched.Pid;createdFileTime=$launched.CreatedFileTime;hidden=$true;independentOsParent=$true;sameAccount=$launched.SameAccount;administratorsEnabled=$launched.AdministratorsEnabled;powerUsersEnabled=$launched.PowerUsersEnabled;genericKillUsed=$false;at=[DateTimeOffset]::Now.ToString('o')}
$receiptPath=Join-Path $jobItem.DirectoryName 'os-launch.private.json'
$receiptBytes=[Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Compress))
$stream=[IO.FileStream]::new($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($receiptBytes,0,$receiptBytes.Length);$stream.Flush($true) } finally { $stream.Dispose() }
$receipt | ConvertTo-Json -Compress

} catch {
 $nativeError=$null
 $failureException=$_.Exception
 while ($null -ne $failureException) {
  if ($failureException -is [ComponentModel.Win32Exception]) { $nativeError=$failureException.NativeErrorCode }
  $failureException=$failureException.InnerException
 }
 $failure=[ordered]@{format='IDMS_VERIFICATION_RESTRICTED_LAUNCH_FAILURE_V1';jobId=$jobSpec.jobId;stage=$restrictedStage;nativeErrorCode=$nativeError;errorKind=$_.Exception.GetType().Name;sourceLine=$_.InvocationInfo.ScriptLineNumber;at=[DateTimeOffset]::Now.ToString('o')}
 $failureFile=Join-Path $jobItem.DirectoryName 'os-launch-failure.private.json'
 [IO.File]::WriteAllText($failureFile,($failure | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 throw
}
