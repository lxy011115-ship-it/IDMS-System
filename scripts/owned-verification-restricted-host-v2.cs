using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Security.Principal;

[DataContract] public sealed class IdmsRestrictedRequestV1 {
 [DataMember] public string format,jobId,jobFile,jobSha256,nodeFile,nodeSha256,supervisorFile,supervisorSha256,workingDirectory,hostSha256;
}
[DataContract] public sealed class IdmsRestrictedReceiptV1 {
 [DataMember] public string format,jobId,inputSha256,hostSha256,createdFileTime,at;
 [DataMember] public int supervisorPid;
 [DataMember] public bool hidden,independentOsParent,sameAccount,administratorsEnabled,powerUsersEnabled,genericKillUsed,privateDesktopOwned;
 [DataMember] public string privateWindowStationName,privateDesktopName;
}
[DataContract] public sealed class IdmsRestrictedObservationV1 {
 [DataMember] public string format,jobId,stage,at,errorKind;
 [DataMember] public int nativeErrorCode;
 [DataMember] public uint exitCode;
 [DataMember] public bool actualOriginalHandleExitObserved;
}

[DataContract] public sealed class IdmsPrivateDesktopRetirementV1 {
 [DataMember] public string format,jobId,at;
 [DataMember] public bool windowStationCreated,desktopCreated,windowStationHandleClosed,desktopHandleClosed,originalHostDesktopRestored;
}
public static class IdmsRestrictedHostV2 {
 [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid;public uint Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length;public IntPtr descriptor;public int inherit; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo { public int cb;public string reserved,desktop,title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public ushort show,cbReserved;public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread;public uint pid,threadId; }
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; }
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStationW(string name,uint flags,uint access,ref SecurityAttributes security);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktopW(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SecurityAttributes security);
 [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr handle);
 [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
 [DllImport("user32.dll",SetLastError=true)] static extern bool SetThreadDesktop(IntPtr handle);
 [DllImport("user32.dll",SetLastError=true)] static extern bool CloseWindowStation(IntPtr handle);
 [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr handle);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor,uint revision,out IntPtr result,out uint size);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out FileTime a,out FileTime b,out FileTime c,out FileTime d);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disableCount,[In] SidAndAttributes[] disable,uint deleteCount,IntPtr delete,uint restrictCount,IntPtr restrict,out IntPtr result);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr result);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool CheckTokenMembership(IntPtr token,IntPtr sid,out bool member);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessAsUserW(IntPtr token,string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
 static void Need(bool value) { if(!value)throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static string Hash(string file) { using(SHA256 hash=SHA256.Create())using(FileStream stream=File.OpenRead(file))return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
 static string Quote(string path) { if(path.IndexOf('"')>=0||path.IndexOf('\r')>=0||path.IndexOf('\n')>=0)throw new InvalidOperationException("RESTRICTED_HOST_PATH");return "\""+Path.GetFullPath(path)+"\""; }
 static void Save(string file,object value) { using(FileStream stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){new DataContractJsonSerializer(value.GetType()).WriteObject(stream,value);stream.Flush(true);} }
 static IntPtr Log(string path) { SecurityAttributes s=new SecurityAttributes();s.length=Marshal.SizeOf(typeof(SecurityAttributes));s.inherit=1;IntPtr h=CreateFileW(path,0x40000000,3,ref s,1,0x80,IntPtr.Zero);Need(h!=new IntPtr(-1));return h; }
 public static int Main(string[] args) {
  string stage="READ_REQUEST",directory=null,jobId=null;
  IntPtr original=IntPtr.Zero,restricted=IntPtr.Zero,impersonation=IntPtr.Zero,stdout=IntPtr.Zero,stderr=IntPtr.Zero,input=IntPtr.Zero;ProcessInfo process=new ProcessInfo();
  SidAndAttributes[] groups=new SidAndAttributes[2];
  IntPtr station=IntPtr.Zero,desktop=IntPtr.Zero,descriptor=IntPtr.Zero,previousStation=IntPtr.Zero,previousDesktop=IntPtr.Zero;
  bool restored=false;string stationName=null;
  try {
   if(args.Length!=2)throw new InvalidOperationException("RESTRICTED_HOST_ARGUMENTS");
   string requestFile=Path.GetFullPath(args[0]);directory=Path.GetDirectoryName(requestFile);
   if(Path.GetFileName(requestFile)!="restricted-launch.private.json"||Hash(requestFile)!=args[1])throw new InvalidOperationException("RESTRICTED_HOST_REQUEST_HASH");
   IdmsRestrictedRequestV1 r;using(FileStream file=File.OpenRead(requestFile))r=(IdmsRestrictedRequestV1)new DataContractJsonSerializer(typeof(IdmsRestrictedRequestV1)).ReadObject(file);
   jobId=r.jobId;Guid parsed;if(r.format!="IDMS_RESTRICTED_SUPERVISOR_REQUEST_V1"||!Guid.TryParseExact(jobId,"D",out parsed)||Path.GetFileName(directory)!="verification-job-"+jobId||Path.GetFullPath(r.jobFile)!=Path.Combine(directory,"job.private.json"))throw new InvalidOperationException("RESTRICTED_HOST_REQUEST");
   Save(Path.Combine(directory,"bootstrap-entered.private.json"),new IdmsRestrictedObservationV1{format="IDMS_RESTRICTED_HOST_ENTERED_V1",jobId=jobId,stage=stage,at=DateTimeOffset.UtcNow.ToString("o")});
   stage="CHECK_PINNED_FILES";
   if(Hash(r.jobFile)!=r.jobSha256||Hash(r.nodeFile)!=r.nodeSha256||Hash(r.supervisorFile)!=r.supervisorSha256||Hash(System.Reflection.Assembly.GetExecutingAssembly().Location)!=r.hostSha256)throw new InvalidOperationException("RESTRICTED_HOST_PIN_CHANGED");
   if(Path.GetFileName(r.nodeFile)!="node.exe"||Path.GetFileName(r.supervisorFile)!="owned-verification-job-v1.mjs")throw new InvalidOperationException("RESTRICTED_HOST_PROGRAM");
   stage="RESTRICT_SAME_ACCOUNT";string user=WindowsIdentity.GetCurrent().User.Value;
   string[] ids={"S-1-5-32-544","S-1-5-32-547"};
   for(int i=0;i<ids.Length;i++){SecurityIdentifier sid=new SecurityIdentifier(ids[i]);byte[] bytes=new byte[sid.BinaryLength];sid.GetBinaryForm(bytes,0);groups[i].Sid=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,groups[i].Sid,bytes.Length);}
   Need(OpenProcessToken(GetCurrentProcess(),0xB,out original));
   Need(CreateRestrictedToken(original,1,2,groups,0,IntPtr.Zero,0,IntPtr.Zero,out restricted));
   Need(DuplicateToken(restricted,2,out impersonation));
   bool admin,power;Need(CheckTokenMembership(impersonation,groups[0].Sid,out admin));Need(CheckTokenMembership(impersonation,groups[1].Sid,out power));
   bool same;using(WindowsIdentity identity=new WindowsIdentity(restricted))same=identity.User.Value==user;
   if(admin||power||!same)throw new InvalidOperationException("RESTRICTED_HOST_TOKEN_NOT_PROVEN");
   stage="CREATE_PRIVATE_DESKTOP";stationName="idms-verification-"+jobId;
   previousStation=GetProcessWindowStation();previousDesktop=GetThreadDesktop(GetCurrentThreadId());Need(previousStation!=IntPtr.Zero&&previousDesktop!=IntPtr.Zero);
   uint descriptorBytes;Need(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;SY)(A;;GA;;;"+user+")",1,out descriptor,out descriptorBytes));
   SecurityAttributes security=new SecurityAttributes();security.length=Marshal.SizeOf(typeof(SecurityAttributes));security.descriptor=descriptor;
   station=CreateWindowStationW(stationName,1,0x10000000,ref security);Need(station!=IntPtr.Zero);
   Need(SetProcessWindowStation(station));
   desktop=CreateDesktopW("native",IntPtr.Zero,IntPtr.Zero,0,0x10000000,ref security);Need(desktop!=IntPtr.Zero);
   Need(SetProcessWindowStation(previousStation));Need(SetThreadDesktop(previousDesktop));restored=true;
   stage="CREATE_SUPERVISOR";stdout=Log(Path.Combine(directory,"supervisor-bootstrap-stdout.private.log"));stderr=Log(Path.Combine(directory,"supervisor-bootstrap-stderr.private.log"));
   SecurityAttributes nul=new SecurityAttributes();nul.length=Marshal.SizeOf(typeof(SecurityAttributes));nul.inherit=1;input=CreateFileW("NUL",0x80000000,3,ref nul,3,0x80,IntPtr.Zero);Need(input!=new IntPtr(-1));
   StartupInfo startup=new StartupInfo();startup.cb=Marshal.SizeOf(typeof(StartupInfo));startup.flags=0x101;startup.show=0;startup.input=input;startup.output=stdout;startup.error=stderr;startup.desktop=stationName+"\\native";
   string command=Quote(r.nodeFile)+" "+Quote(r.supervisorFile)+" --supervise "+Quote(r.jobFile);
   Need(CreateProcessAsUserW(restricted,r.nodeFile,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000400,IntPtr.Zero,r.workingDirectory,ref startup,out process));
   FileTime a,b,c,d;Need(GetProcessTimes(process.process,out a,out b,out c,out d));
   Save(Path.Combine(directory,"os-launch.private.json"),new IdmsRestrictedReceiptV1{format="IDMS_VERIFICATION_JOB_RESTRICTED_OS_LAUNCH_V3",jobId=jobId,inputSha256=r.jobSha256,hostSha256=r.hostSha256,supervisorPid=(int)process.pid,createdFileTime=(((ulong)a.high<<32)|a.low).ToString(),sameAccount=same,privateDesktopOwned=true,privateWindowStationName=stationName,privateDesktopName="native",administratorsEnabled=admin,powerUsersEnabled=power,hidden=true,independentOsParent=true,genericKillUsed=false,at=DateTimeOffset.UtcNow.ToString("o")});
   stage="OBSERVE_ORIGINAL_SUPERVISOR";
   uint observed=WaitForSingleObject(process.process,0xFFFFFFFF);Need(observed==0||observed==258);
   if(observed==0){uint code;Need(GetExitCodeProcess(process.process,out code));Save(Path.Combine(directory,"supervisor-original-handle-exit.private.json"),new IdmsRestrictedObservationV1{format="IDMS_RESTRICTED_SUPERVISOR_ACTUAL_EXIT_V1",jobId=jobId,stage=stage,exitCode=code,actualOriginalHandleExitObserved=true,at=DateTimeOffset.UtcNow.ToString("o")});}
   return 0;
  } catch(Exception error) {
   if(directory!=null&&Directory.Exists(directory))try{Win32Exception native=error as Win32Exception;Save(Path.Combine(directory,"bootstrap-failure.private.json"),new IdmsRestrictedObservationV1{format="IDMS_RESTRICTED_HOST_FAILURE_V1",jobId=jobId,stage=stage,errorKind=error.GetType().Name,nativeErrorCode=native==null?0:native.NativeErrorCode,at=DateTimeOffset.UtcNow.ToString("o")});}catch{}
   return 1;
  } finally {
   if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);
   foreach(IntPtr h in new IntPtr[]{input,stderr,stdout,impersonation,restricted,original})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);
   foreach(SidAndAttributes g in groups)if(g.Sid!=IntPtr.Zero)Marshal.FreeHGlobal(g.Sid);
   if(!restored&&previousStation!=IntPtr.Zero&&previousDesktop!=IntPtr.Zero)restored=SetProcessWindowStation(previousStation)&&SetThreadDesktop(previousDesktop);
   bool desktopClosed=desktop==IntPtr.Zero||CloseDesktop(desktop),stationClosed=station==IntPtr.Zero||CloseWindowStation(station);
   if(descriptor!=IntPtr.Zero)LocalFree(descriptor);
   if(directory!=null&&Directory.Exists(directory))try{Save(Path.Combine(directory,"host-owned-desktop-retirement.private.json"),new IdmsPrivateDesktopRetirementV1{format="IDMS_PRIVATE_DESKTOP_RETIREMENT_V1",jobId=jobId,at=DateTimeOffset.UtcNow.ToString("o"),windowStationCreated=station!=IntPtr.Zero,desktopCreated=desktop!=IntPtr.Zero,windowStationHandleClosed=stationClosed,desktopHandleClosed=desktopClosed,originalHostDesktopRestored=restored});}catch{}

  }
 }
}
