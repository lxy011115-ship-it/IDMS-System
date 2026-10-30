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
 [DataMember] public bool hidden,independentOsParent,sameAccount,administratorsEnabled,powerUsersEnabled,genericKillUsed;
}
[DataContract] public sealed class IdmsRestrictedObservationV1 {
 [DataMember] public string format,jobId,stage,at,errorKind;
 [DataMember] public int nativeErrorCode;
 [DataMember] public uint exitCode;
 [DataMember] public bool actualOriginalHandleExitObserved;
}

public static class IdmsRestrictedHostV1 {
 [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid;public uint Attributes; }
 [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length;public IntPtr descriptor;public int inherit; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo { public int cb;public string reserved,desktop,title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public ushort show,cbReserved;public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread;public uint pid,threadId; }
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; }
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
   stage="CREATE_SUPERVISOR";stdout=Log(Path.Combine(directory,"supervisor-bootstrap-stdout.private.log"));stderr=Log(Path.Combine(directory,"supervisor-bootstrap-stderr.private.log"));
   SecurityAttributes nul=new SecurityAttributes();nul.length=Marshal.SizeOf(typeof(SecurityAttributes));nul.inherit=1;input=CreateFileW("NUL",0x80000000,3,ref nul,3,0x80,IntPtr.Zero);Need(input!=new IntPtr(-1));
   StartupInfo startup=new StartupInfo();startup.cb=Marshal.SizeOf(typeof(StartupInfo));startup.flags=0x101;startup.show=0;startup.input=input;startup.output=stdout;startup.error=stderr;
   string command=Quote(r.nodeFile)+" "+Quote(r.supervisorFile)+" --supervise "+Quote(r.jobFile);
   Need(CreateProcessAsUserW(restricted,r.nodeFile,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000400,IntPtr.Zero,r.workingDirectory,ref startup,out process));
   FileTime a,b,c,d;Need(GetProcessTimes(process.process,out a,out b,out c,out d));
   Save(Path.Combine(directory,"os-launch.private.json"),new IdmsRestrictedReceiptV1{format="IDMS_VERIFICATION_JOB_RESTRICTED_OS_LAUNCH_V2",jobId=jobId,inputSha256=r.jobSha256,hostSha256=r.hostSha256,supervisorPid=(int)process.pid,createdFileTime=(((ulong)a.high<<32)|a.low).ToString(),sameAccount=same,administratorsEnabled=admin,powerUsersEnabled=power,hidden=true,independentOsParent=true,genericKillUsed=false,at=DateTimeOffset.UtcNow.ToString("o")});
   stage="OBSERVE_ORIGINAL_SUPERVISOR";
   uint observed=WaitForSingleObject(process.process,2000);Need(observed==0||observed==258);
   if(observed==0){uint code;Need(GetExitCodeProcess(process.process,out code));Save(Path.Combine(directory,"supervisor-bootstrap-exit.private.json"),new IdmsRestrictedObservationV1{format="IDMS_RESTRICTED_SUPERVISOR_EARLY_EXIT_V1",jobId=jobId,stage=stage,exitCode=code,actualOriginalHandleExitObserved=true,at=DateTimeOffset.UtcNow.ToString("o")});}
   return 0;
  } catch(Exception error) {
   if(directory!=null&&Directory.Exists(directory))try{Win32Exception native=error as Win32Exception;Save(Path.Combine(directory,"bootstrap-failure.private.json"),new IdmsRestrictedObservationV1{format="IDMS_RESTRICTED_HOST_FAILURE_V1",jobId=jobId,stage=stage,errorKind=error.GetType().Name,nativeErrorCode=native==null?0:native.NativeErrorCode,at=DateTimeOffset.UtcNow.ToString("o")});}catch{}
   return 1;
  } finally {
   if(process.thread!=IntPtr.Zero)CloseHandle(process.thread);if(process.process!=IntPtr.Zero)CloseHandle(process.process);
   foreach(IntPtr h in new IntPtr[]{input,stderr,stdout,impersonation,restricted,original})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);
   foreach(SidAndAttributes g in groups)if(g.Sid!=IntPtr.Zero)Marshal.FreeHGlobal(g.Sid);
  }
 }
}
