param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Internal capability file only. The caller must be the broker's actual creator.
# No arbitrary command, executable argument list, service or process-name lookup.
$requestPath = [IO.Path]::GetFullPath($RequestFile)
$requestInfo = Get-Item -LiteralPath $requestPath
if ($requestInfo.PSIsContainer -or ($requestInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $requestInfo.Length -le 0 -or $requestInfo.Length -gt 65536) { throw 'MQTT_BROKER_CONTROL_REQUEST_FILE' }
$request = [IO.File]::ReadAllText($requestPath) | ConvertFrom-Json
$required = @('format','action','owner','challenge','parentPid','pid','expectedCreatedFileTime','program','configFile','configSha256','port','resultFile')
if ((($request.PSObject.Properties.Name | Sort-Object) -join ',') -cne (($required | Sort-Object) -join ',')) { throw 'MQTT_BROKER_CONTROL_FIELDS' }
if ($request.format -cne 'IDMS_MQTT_BROKER_WIN_CONTROL_V1' -or @('INSPECT','SHUTDOWN') -cnotcontains $request.action -or $request.owner -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$' -or $request.challenge -cnotmatch '^[a-f0-9]{64}$') { throw 'MQTT_BROKER_CONTROL_BINDING' }
if ($request.parentPid -isnot [int] -or $request.pid -isnot [int] -or $request.parentPid -le 0 -or $request.pid -le 0 -or $request.pid -eq $request.parentPid -or $request.port -isnot [int] -or $request.port -le 1024 -or $request.port -gt 65535) { throw 'MQTT_BROKER_CONTROL_IDS' }
if ($null -ne $request.expectedCreatedFileTime -and $request.expectedCreatedFileTime -cnotmatch '^[0-9]{16,21}$') { throw 'MQTT_BROKER_CONTROL_CREATION_TIME' }
if ($request.action -ceq 'SHUTDOWN' -and $null -eq $request.expectedCreatedFileTime) { throw 'MQTT_BROKER_CONTROL_CREATION_TIME_REQUIRED' }
if ($request.configSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'MQTT_BROKER_CONTROL_CONFIG_DIGEST' }
$directory = [IO.Path]::GetDirectoryName($requestPath)
if ([IO.Path]::GetFileName($directory) -cne ('mqtt-broker-process-' + $request.owner) -or [IO.Path]::GetFileName($requestPath) -cnotmatch '^control-[a-f0-9-]{36}\.request\.private\.json$') { throw 'MQTT_BROKER_CONTROL_PRIVATE_DIRECTORY' }
$expectedResult = $requestPath.Replace('.request.private.json','.result.private.json')
if ($request.resultFile -cne $expectedResult -or $request.configFile -cne [IO.Path]::Combine($directory,'mosquitto.conf') -or [IO.Path]::GetFileName($request.program) -ine 'mosquitto.exe') { throw 'MQTT_BROKER_CONTROL_FIXED_PATHS' }
$source = @'
using System;
using System.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Net;

public sealed class IdmsMqttControlResultV1 {
 public bool Delivered,Completed,OwnListener,EventAvailable,CommandLineBound;
 public string CreatedFileTime,ParentCreatedFileTime,ErrorCode;
 public uint? NativeExitCode;
}
public static class IdmsMqttControlV1 {
 [StructLayout(LayoutKind.Sequential)] struct BasicInfo { public IntPtr exitStatus,peb,affinity,priority,pid,parent; }
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint id);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder name,ref uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenEvent(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEvent(IntPtr handle);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle,int kind,ref BasicInfo info,uint size,out uint returned);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 [DllImport("iphlpapi.dll",SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table,ref uint size,bool order,uint family,uint kind,uint reserved);
 static void Need(bool value) { if(!value)throw new InvalidOperationException("MQTT_BROKER_WIN_BINDING"); }
 static BasicInfo Info(IntPtr handle) { BasicInfo value=new BasicInfo();uint size;Need(NtQueryInformationProcess(handle,0,ref value,(uint)Marshal.SizeOf(typeof(BasicInfo)),out size)==0);return value; }
 static ulong Created(IntPtr handle) { FileTime a,b,c,d;Need(GetProcessTimes(handle,out a,out b,out c,out d));return ((ulong)a.high<<32)|a.low; }
 static bool SamePath(string a,string b) { return String.Equals(Path.GetFullPath(a),Path.GetFullPath(b),StringComparison.OrdinalIgnoreCase); }
 static bool CommandBound(string command,string program,string config) {
  int count;IntPtr args=CommandLineToArgvW(command,out count);if(args==IntPtr.Zero)return false;
  try{return count==3&&SamePath(Marshal.PtrToStringUni(Marshal.ReadIntPtr(args)),program)&&Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,IntPtr.Size))=="-c"&&SamePath(Marshal.PtrToStringUni(Marshal.ReadIntPtr(args,2*IntPtr.Size)),config);}finally{LocalFree(args);}
 }
 static bool Listening(uint processId,int port) {
  uint size=0;Need(GetExtendedTcpTable(IntPtr.Zero,ref size,false,2,3,0)==122&&size>=4&&size<=16*1024*1024);IntPtr data=Marshal.AllocHGlobal((int)size);
  try{
   Need(GetExtendedTcpTable(data,ref size,false,2,3,0)==0);int count=Marshal.ReadInt32(data);Need(count>=0&&4L+count*24L<=size);
   for(int i=0;i<count;i++){int at=4+i*24;uint state=(uint)Marshal.ReadInt32(data,at),address=(uint)Marshal.ReadInt32(data,at+4),rawPort=(uint)Marshal.ReadInt32(data,at+8),id=(uint)Marshal.ReadInt32(data,at+20);int actual=(int)((rawPort&255)<<8|((rawPort>>8)&255));if(state==2&&id==processId&&actual==port&&new IPAddress((long)address).ToString()=="127.0.0.1")return true;}
   return false;
  }finally{Marshal.FreeHGlobal(data);}
 }
 public static IdmsMqttControlResultV1 Run(string action,uint processId,uint creatorId,string expectedCreated,string program,string config,string configSha,int port,string command) {
  IdmsMqttControlResultV1 result=new IdmsMqttControlResultV1();IntPtr target=IntPtr.Zero,parent=IntPtr.Zero,shutdown=IntPtr.Zero;
  try{
   Need((uint)Info(GetCurrentProcess()).parent.ToInt64()==creatorId);
   parent=OpenProcess(0x101000,false,creatorId);Need(parent!=IntPtr.Zero&&WaitForSingleObject(parent,0)==258);
   target=OpenProcess(0x101000,false,processId);Need(target!=IntPtr.Zero&&WaitForSingleObject(target,0)==258);
   BasicInfo binding=Info(target);Need((uint)binding.pid.ToInt64()==processId&&(uint)binding.parent.ToInt64()==creatorId);
   ulong created=Created(target),parentCreated=Created(parent);Need(created>=parentCreated);result.CreatedFileTime=created.ToString();result.ParentCreatedFileTime=parentCreated.ToString();
   if(!String.IsNullOrEmpty(expectedCreated))Need(result.CreatedFileTime==expectedCreated);
   uint capacity=32768;StringBuilder image=new StringBuilder((int)capacity);Need(QueryFullProcessImageName(target,0,image,ref capacity)&&SamePath(image.ToString(),program));
   result.CommandLineBound=CommandBound(command,program,config);Need(result.CommandLineBound);
   using(SHA256 hash=SHA256.Create()){string actual=BitConverter.ToString(hash.ComputeHash(File.ReadAllBytes(config))).Replace("-","").ToLowerInvariant();Need(actual==configSha);}
   result.OwnListener=Listening(processId,port);
   shutdown=OpenEvent(0x100002,false,"mosq"+processId.ToString()+"_shutdown");result.EventAvailable=shutdown!=IntPtr.Zero&&WaitForSingleObject(shutdown,0)==258;
   Need(WaitForSingleObject(target,0)==258);
   if(action=="SHUTDOWN"){
    Need(result.OwnListener&&result.EventAvailable);Need(SetEvent(shutdown));result.Delivered=true;
    uint observed=WaitForSingleObject(target,30000);Need(observed==0||observed==258);result.Completed=observed==0;
    if(result.Completed){uint code;Need(GetExitCodeProcess(target,out code));result.NativeExitCode=code;}
   }else Need(action=="INSPECT");
  }catch{result.ErrorCode="MQTT_BROKER_WIN_CONTROL_REJECTED";}
  finally{if(shutdown!=IntPtr.Zero)CloseHandle(shutdown);if(target!=IntPtr.Zero)CloseHandle(target);if(parent!=IntPtr.Zero)CloseHandle(parent);}
  return result;
 }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$created = $null
if ($null -ne $request.expectedCreatedFileTime) { $created = [string]$request.expectedCreatedFileTime }
$nativeProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [string]$request.pid)
$command = ''
if ($nativeProcess) { $command = [string]$nativeProcess.CommandLine }
$result = [IdmsMqttControlV1]::Run([string]$request.action,[uint32]$request.pid,[uint32]$request.parentPid,$created,[string]$request.program,[string]$request.configFile,[string]$request.configSha256,[int]$request.port,$command)
$sha = [Security.Cryptography.SHA256]::Create()
try { $challengeSha = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$request.challenge))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
$value = @{ format='IDMS_MQTT_BROKER_WIN_CONTROL_RESULT_V1'; action=$request.action; owner=$request.owner; challengeSha256=$challengeSha; parentPid=$request.parentPid; pid=$request.pid; helperPid=$PID; delivered=$result.Delivered; completed=$result.Completed; ownListener=$result.OwnListener; eventAvailable=$result.EventAvailable; commandLineBound=$result.CommandLineBound; createdFileTime=$result.CreatedFileTime; parentCreatedFileTime=$result.ParentCreatedFileTime; nativeExitCode=$result.NativeExitCode; errorCode=$result.ErrorCode }
$serialized = $value | ConvertTo-Json -Depth 6 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($serialized)
$outputFile = New-Object IO.FileStream($expectedResult,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
try { $outputFile.Write($bytes,0,$bytes.Length);$outputFile.Flush($true) } finally { $outputFile.Dispose() }
Write-Output (@{ format='IDMS_MQTT_BROKER_WIN_CONTROL_STATUS_V1'; delivered=$result.Delivered; completed=$result.Completed; errorCode=$result.ErrorCode } | ConvertTo-Json -Compress)
if ($result.ErrorCode) { exit 1 }
