param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This adapter runs only the fixed verifier. It accepts no PID, account,
# password, arbitrary executable, script, command line or elevation request.
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeExecutable = 'C:\Program Files\nodejs\node.exe'
$nodeSha256 = '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'
$entryFile = Join-Path $PSScriptRoot 'verify-controlled-cold-diagnostic-windows-v2.mjs'
if ((Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeSha256) { throw 'PG_RESTRICTED_NODE_HASH_CHANGED' }
$adapterSource = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;

public sealed class IdmsRestrictedColdDiagnosticsV2 {
 [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
  public uint cb; public string reserved,desktop,title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
  public ushort show,reserved2; public IntPtr reservedPtr,input,output,error;
 }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disableCount,[In]SidAndAttributes[] disable,uint deletePrivileges,IntPtr privileges,uint restrictedCount,IntPtr restricted,out IntPtr result);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr buffer,uint size,out uint needed);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr buffer,uint size);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string executable,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
 IntPtr processHandle,threadHandle,tokenHandle; bool resumed,completed;
 public uint Pid { get; private set; }
 public string CreatedFileTime { get; private set; }
 public bool AdminEnabled { get; private set; }
 public bool PowerUsersEnabled { get; private set; }
 static void Need(bool v,string code) { if(!v) throw new InvalidOperationException(code+"_"+Marshal.GetLastWin32Error()); }
 static IntPtr Sid(SecurityIdentifier value) { byte[] b=new byte[value.BinaryLength];value.GetBinaryForm(b,0);IntPtr p=Marshal.AllocHGlobal(b.Length);Marshal.Copy(b,0,p,b.Length);return p; }
 static string Quote(string value) { if(String.IsNullOrWhiteSpace(value)||value.IndexOf('"')>=0||value.IndexOf('\n')>=0||value.IndexOf('\r')>=0||value.EndsWith("\\"))throw new InvalidOperationException("PG_RESTRICTED_PATH");return "\""+value+"\""; }
 // PostgreSQL adds the current user to the restricted token's default DACL so
 // children can open their own process tokens after the admin groups are denied.
 static void AddUserDefaultDacl(IntPtr token) {
  uint n;GetTokenInformation(token,1,IntPtr.Zero,0,out n);IntPtr user=Marshal.AllocHGlobal((int)n),dacl=IntPtr.Zero,aclMemory=IntPtr.Zero,newDacl=IntPtr.Zero;
  try {
   Need(GetTokenInformation(token,1,user,n,out n),"PG_RESTRICTED_TOKEN_USER");SecurityIdentifier sid=new SecurityIdentifier(Marshal.ReadIntPtr(user));
   GetTokenInformation(token,6,IntPtr.Zero,0,out n);dacl=Marshal.AllocHGlobal((int)n);Need(GetTokenInformation(token,6,dacl,n,out n),"PG_RESTRICTED_TOKEN_DACL");IntPtr acl=Marshal.ReadIntPtr(dacl);RawAcl raw;
   if(acl==IntPtr.Zero)raw=new RawAcl(GenericAcl.AclRevision,1);else{int len=(ushort)Marshal.ReadInt16(acl,2);byte[] old=new byte[len];Marshal.Copy(acl,old,0,len);raw=new RawAcl(old,0);}
   raw.InsertAce(0,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,unchecked((int)0x10000000),sid,false,null));byte[] output=new byte[raw.BinaryLength];raw.GetBinaryForm(output,0);aclMemory=Marshal.AllocHGlobal(output.Length);Marshal.Copy(output,0,aclMemory,output.Length);newDacl=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(newDacl,aclMemory);Need(SetTokenInformation(token,6,newDacl,(uint)IntPtr.Size),"PG_RESTRICTED_SET_DACL");
  } finally {Marshal.FreeHGlobal(user);if(dacl!=IntPtr.Zero)Marshal.FreeHGlobal(dacl);if(aclMemory!=IntPtr.Zero)Marshal.FreeHGlobal(aclMemory);if(newDacl!=IntPtr.Zero)Marshal.FreeHGlobal(newDacl);}
 }
 public static IdmsRestrictedColdDiagnosticsV2 CreateSuspended(string executable,string entry,string directory) {
  IntPtr original=IntPtr.Zero,token=IntPtr.Zero,admin=IntPtr.Zero,power=IntPtr.Zero,input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero;ProcessInfo pi=new ProcessInfo();bool transferred=false;
  try {
   Need(OpenProcessToken(GetCurrentProcess(),0xF01FF,out original),"PG_RESTRICTED_OPEN_TOKEN");admin=Sid(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null));power=Sid(new SecurityIdentifier(WellKnownSidType.BuiltinPowerUsersSid,null));
   Need(CreateRestrictedToken(original,1,2,new SidAndAttributes[]{new SidAndAttributes{Sid=admin,Attributes=0},new SidAndAttributes{Sid=power,Attributes=0}},0,IntPtr.Zero,0,IntPtr.Zero,out token),"PG_RESTRICTED_CREATE_TOKEN");AddUserDefaultDacl(token);
   bool isAdmin,isPower;using(WindowsIdentity id=new WindowsIdentity(token)){WindowsPrincipal p=new WindowsPrincipal(id);isAdmin=p.IsInRole(WindowsBuiltInRole.Administrator);isPower=p.IsInRole(WindowsBuiltInRole.PowerUser);}Need(!isAdmin&&!isPower,"PG_RESTRICTED_GROUPS_ENABLED");
   Need(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-10),GetCurrentProcess(),out input,0,true,2),"PG_RESTRICTED_STDIN");Need(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-11),GetCurrentProcess(),out output,0,true,2),"PG_RESTRICTED_STDOUT");Need(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-12),GetCurrentProcess(),out error,0,true,2),"PG_RESTRICTED_STDERR");
   StartupInfo si=new StartupInfo();si.cb=(uint)Marshal.SizeOf(typeof(StartupInfo));si.flags=0x100;si.input=input;si.output=output;si.error=error;
   Need(CreateProcessAsUser(token,executable,new StringBuilder(Quote(executable)+" "+Quote(entry)),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,directory,ref si,out pi),"PG_RESTRICTED_CREATE_PROCESS");
   FileTime created,exited,kernel,user;Need(GetProcessTimes(pi.process,out created,out exited,out kernel,out user),"PG_RESTRICTED_CREATION_TIME");
   IdmsRestrictedColdDiagnosticsV2 result=new IdmsRestrictedColdDiagnosticsV2();result.processHandle=pi.process;result.threadHandle=pi.thread;result.tokenHandle=token;result.Pid=pi.pid;result.CreatedFileTime=(((ulong)created.high<<32)|created.low).ToString();result.AdminEnabled=isAdmin;result.PowerUsersEnabled=isPower;transferred=true;return result;
  } finally {
   if(original!=IntPtr.Zero)CloseHandle(original);if(admin!=IntPtr.Zero)Marshal.FreeHGlobal(admin);if(power!=IntPtr.Zero)Marshal.FreeHGlobal(power);if(input!=IntPtr.Zero)CloseHandle(input);if(output!=IntPtr.Zero)CloseHandle(output);if(error!=IntPtr.Zero)CloseHandle(error);
   if(!transferred){if(pi.process!=IntPtr.Zero){TerminateProcess(pi.process,99);WaitForSingleObject(pi.process,10000);CloseHandle(pi.process);}if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(token!=IntPtr.Zero)CloseHandle(token);}
  }
 }
 public void Resume() { Need(!resumed&&!completed,"PG_RESTRICTED_STATE");Need(ResumeThread(threadHandle)!=0xFFFFFFFF,"PG_RESTRICTED_RESUME");resumed=true;CloseHandle(threadHandle);threadHandle=IntPtr.Zero; }
 public uint Wait() { Need(resumed&&!completed,"PG_RESTRICTED_STATE");Need(WaitForSingleObject(processHandle,0xFFFFFFFF)==0,"PG_RESTRICTED_WAIT");uint code;Need(GetExitCodeProcess(processHandle,out code),"PG_RESTRICTED_EXIT");completed=true;CloseHandle(processHandle);CloseHandle(tokenHandle);processHandle=tokenHandle=IntPtr.Zero;return code; }
 public void CancelBeforeResume() { Need(!resumed&&!completed,"PG_RESTRICTED_STATE");Need(TerminateProcess(processHandle,99),"PG_RESTRICTED_CANCEL");WaitForSingleObject(processHandle,10000);CloseHandle(threadHandle);CloseHandle(processHandle);CloseHandle(tokenHandle);completed=true;threadHandle=processHandle=tokenHandle=IntPtr.Zero; }
}
'@
Add-Type -TypeDefinition $adapterSource -Language CSharp
if ($CheckOnly) { Write-Output 'CORE_RESTRICTED_ADAPTER_COMPILED'; exit 0 }
$wrapperRunId = [Guid]::NewGuid().ToString()
$wrapperDirectory = Join-Path $projectRoot ('work\controlled-cold-diagnostic-windows-v2-20261024\' + $wrapperRunId)
New-Item -ItemType Directory -Path $wrapperDirectory -ErrorAction Stop | Out-Null
& icacls.exe $wrapperDirectory /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(OI)(CI)(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PG_RESTRICTED_PRIVATE_DIRECTORY' }
$sourcePins = @('verify-controlled-cold-diagnostic-windows-v2.ps1','verify-runtime-application-suite-v22.mjs','verify-runtime-application-suite-cleanup-v23.mjs','fixtures/runtime-controlled-cold-portable-r4-v2-qa.mjs','fixtures/controlled-cold-stage-diagnostic-v2-qa.mjs','../tests/controlled-cold-stage-diagnostic-v2.test.mjs','../.github/workflows/controlled-cold-diagnostic-verification.yml','ci-source-policy-v2.mjs','verify-ci-source-policy-v2.mjs','../docs/validation/ci-source-parent-v2.json','../docs/validation/ci-source-policy-v2.json','platform-ci-source-v1.mjs','fixtures/application-startup-diagnostic-v1-qa.mjs','verify-runtime-application-suite-v19.mjs','verify-runtime-application-suite-cleanup-v20.mjs','verify-platform-core-windows-v12.ps1','fixtures/platform-core-v11-qa.mjs','fixtures/platform-core-v12-qa.mjs','fixtures/platform-core-faults-v5-qa.mjs','fixtures/platform-core-predictor-v2-qa.mjs','verify-runtime-application-suite-v15.mjs','verify-runtime-application-suite-cleanup-v16.mjs','verify-controlled-cold-diagnostic-windows-v2.mjs','verify-platform-core-windows-v10.ps1','verify-platform-predictor-pre-core-failure-cleanup-v1.mjs','verify-runtime-application-suite-v14.mjs','verify-runtime-application-suite-cleanup-v15.mjs','verify-platform-core-windows-v9.ps1','platform-dependency-config-v2.mjs','platform-dependency-controller-v6.mjs','fixtures/platform-core-v9-qa.mjs','fixtures/platform-core-v10-qa.mjs','fixtures/platform-core-faults-v4-qa.mjs','fixtures/platform-core-predictor-v1-qa.mjs','fixtures/platform-core-cancellation-cleanup-v2-qa.mjs','fixtures/platform-core-faults-cleanup-v4-qa.mjs','fixtures/platform-predictor-cleanup-v1-qa.mjs','verify-runtime-application-suite-v13.mjs','verify-runtime-application-suite-cleanup-v14.mjs','verify-controlled-cold-diagnostic-windows-v2.mjs','verify-platform-core-windows-v8.ps1') | ForEach-Object { @{ name = $_; sha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant() } }
$env:NODE_OPTIONS = ''
$env:NODE_PATH = ''
$ownedNode = [IdmsRestrictedColdDiagnosticsV2]::CreateSuspended($nodeExecutable, $entryFile, $projectRoot)
try {
    $launch = @{ format = 'IDMS_RESTRICTED_NODE_LAUNCH_V2'; wrapperRunId = $wrapperRunId; pid = $ownedNode.Pid; createdFileTime = $ownedNode.CreatedFileTime; adminEnabled = $ownedNode.AdminEnabled; powerUsersEnabled = $ownedNode.PowerUsersEnabled; actualCreationHandleRetained = $true; nodeSha256 = $nodeSha256; wrapperSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); sources = $sourcePins; at = [DateTime]::UtcNow.ToString('o') }
    $launch | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $wrapperDirectory 'launch.json') -Encoding UTF8
    foreach ($pin in $sourcePins) { if ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $pin.name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'PG_RESTRICTED_SOURCE_CHANGED' } }
    $ownedNode.Resume()
} catch {
    $ownedNode.CancelBeforeResume()
    throw
}
$actualExitCode = $ownedNode.Wait()
@{ format = 'IDMS_RESTRICTED_NODE_EXIT_V2'; wrapperRunId = $wrapperRunId; pid = $launch.pid; createdFileTime = $launch.createdFileTime; actualNativeWaitCompleted = $true; code = $actualExitCode; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $wrapperDirectory 'exit.json') -Encoding UTF8
Write-Output (@{ wrapperRunId = $wrapperRunId; code = $actualExitCode; adminEnabled = $launch.adminEnabled; actualNativeWaitCompleted = $true } | ConvertTo-Json -Compress)
exit $actualExitCode
