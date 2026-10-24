import {spawn} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {readApplicationFileV1} from './runtime-application-config-v1.mjs';

const ownFile=fileURLToPath(import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');
const need=(v,c)=>{if(!v)throw Error(c);},exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\u0000-\u001f\u007f]/.test(v);
const endpoint=(directory,id)=>process.platform==='win32'?'\\\\.\\pipe\\idms-verification-'+id:join(directory,'control.sock');
const identity=()=>String(process.env.USERDOMAIN??'')+'\\'+String(process.env.USERNAME??process.env.USER??'');
const mac=(key,body)=>createHmac('sha256',key).update(JSON.stringify(body)).digest('hex');
function signed(key,body){return{body,signature:mac(key,body)};}
function checked(key,value){need(value&&exact(value,['body','signature'])&&/^[a-f0-9]{64}$/.test(value.signature),'VERIFICATION_JOB_SIGNATURE');need(timingSafeEqual(Buffer.from(mac(key,value.body),'hex'),Buffer.from(value.signature,'hex')),'VERIFICATION_JOB_SIGNATURE');return value.body;}
async function envelope(file){const item=await readApplicationFileV1(file),e=JSON.parse(item.bytes.toString('utf8'));need(exact(e,['format','purpose','jobId','accountName','workingDirectory','entryFile','entrySha256','nodeSha256','supervisorSha256','arguments','probeKey'])&&e.format===1&&e.purpose==='IDMS_OWNED_VERIFICATION_JOB_V1'&&uuid(e.jobId)&&text(e.accountName)&&text(e.workingDirectory)&&text(e.entryFile)&&isAbsolute(e.workingDirectory)&&isAbsolute(e.entryFile)&&e.entryFile.endsWith('.mjs')&&[e.entrySha256,e.nodeSha256,e.supervisorSha256,e.probeKey].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))&&Array.isArray(e.arguments)&&e.arguments.length<=32&&e.arguments.every(text)&&e.arguments.join('').length<=24000,'VERIFICATION_JOB_ENVELOPE');const rel=relative(e.workingDirectory,e.entryFile);need(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'VERIFICATION_JOB_ENTRY_OUTSIDE_WORKSPACE');return{...item,e,key:Buffer.from(e.probeKey,'hex'),directory:dirname(item.path)};}

/** Prepare a private job; launch separately so the caller can use a durable OS parent. */
export async function createOwnedVerificationJobV1({workingDirectory,entryFile,args=[],workDirectory}){
 need([workingDirectory,entryFile,workDirectory].every(p=>text(p)&&isAbsolute(p)),'VERIFICATION_JOB_PATH');const entry=await readApplicationFileV1(entryFile),own=await readApplicationFileV1(ownFile),jobId=randomUUID(),directory=join(workDirectory,'verification-job-'+jobId);await privateDirectory(directory);
 const e={format:1,purpose:'IDMS_OWNED_VERIFICATION_JOB_V1',jobId,accountName:identity(),workingDirectory:resolve(workingDirectory),entryFile:entry.path,entrySha256:entry.sha256,nodeSha256:hash(await readFile(process.execPath)),supervisorSha256:own.sha256,arguments:args,probeKey:randomBytes(32).toString('hex')},file=join(directory,'job.private.json');await privateNewFile(file,JSON.stringify(e));const verified=await envelope(file);verified.key.fill(0);return{jobId,directory,file,supervisorFile:own.path,inputSha256:verified.sha256};
}

/** Response comes from the live holder of the original ChildProcess, or its authenticated terminal receipt. */
export async function probeOwnedVerificationJobV1(file,{timeoutMs=5000}={}){
 need(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000,'VERIFICATION_JOB_PROBE_TIMEOUT');const job=await envelope(file),terminalFile=join(job.directory,'terminal.private.json');
 try{
  try{const terminal=checked(job.key,JSON.parse((await readApplicationFileV1(terminalFile)).bytes.toString('utf8')));need(terminal.jobId===job.e.jobId&&terminal.inputSha256===job.sha256&&['CLOSED','FAILED'].includes(terminal.phase),'VERIFICATION_JOB_TERMINAL_BINDING');return terminal;}catch(e){if(e.code!=='ENOENT')throw e;}
  const requestId=randomUUID(),body={type:'PROBE',jobId:job.e.jobId,requestId};
  return await new Promise((ok,no)=>{const socket=createConnection(endpoint(job.directory,job.e.jobId)),timer=setTimeout(()=>finish(Error('VERIFICATION_JOB_PROBE_TIMEOUT')),timeoutMs);let result='',done=false;function finish(error,value){if(done)return;done=true;clearTimeout(timer);socket.destroy();error?no(error):ok(value);}socket.once('error',()=>finish(Error('VERIFICATION_JOB_PROBE_UNAVAILABLE')));socket.once('connect',()=>socket.end(JSON.stringify(signed(job.key,body))+'\n'));socket.on('data',b=>{result+=b.toString('utf8');if(result.length>16384)return finish(Error('VERIFICATION_JOB_PROBE_BUDGET'));const end=result.indexOf('\n');if(end<0)return;try{const v=checked(job.key,JSON.parse(result.slice(0,end)));need(v.jobId===job.e.jobId&&v.inputSha256===job.sha256&&v.requestId===requestId&&v.originalChildHandleHeld===true,'VERIFICATION_JOB_PROBE_BINDING');finish(null,v);}catch(e){finish(e);}});socket.once('end',()=>{if(!done)finish(Error('VERIFICATION_JOB_PROBE_EMPTY'));});});
 }finally{job.key.fill(0);}
}

/** This process owns the native fork and persists actual close/stream observations. It never adopts a PID. */
export async function superviseOwnedVerificationJobV1(file){
 const job=await envelope(file),e=job.e;need(identity()===e.accountName,'VERIFICATION_JOB_ACCOUNT');need(hash(await readFile(process.execPath))===e.nodeSha256&&(await readApplicationFileV1(e.entryFile)).sha256===e.entrySha256&&(await readApplicationFileV1(ownFile)).sha256===e.supervisorSha256,'VERIFICATION_JOB_SOURCE_CHANGED');
 const stdoutFile=join(job.directory,'stdout.private.log'),stderrFile=join(job.directory,'stderr.private.log');await privateNewFile(stdoutFile,'');await privateNewFile(stderrFile,'');const out=openSync(stdoutFile,'a'),err=openSync(stderrFile,'a'),sockets=new Set();let child=null,exited=null,spawnFailed=false,stdoutClosed=false,stderrClosed=false,logFailure=false,truncated=false,nonce=null,checkCount=0,stage=null,lastOutputAt=null,phase='STARTING';const byteCounts={stdout:0,stderr:0},lineBuffers={stdout:'',stderr:''};
 const status=requestId=>({format:'IDMS_OWNED_VERIFICATION_STATUS_V1',jobId:e.jobId,inputSha256:job.sha256,supervisorPid:process.pid,nativePid:child?.pid??null,originalChildHandleHeld:!!child,phase,nonce,checkCount,stage,lastOutputAt,exit:exited,spawnFailed,stdoutClosed,stderrClosed,logFailure,truncated,byteCounts:{...byteCounts},...(requestId?{requestId}:{})});
 const server=createServer(socket=>{sockets.add(socket);socket.setTimeout(3000,()=>socket.destroy());let buffer='';socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));socket.on('data',data=>{buffer+=data.toString('utf8');if(buffer.length>4096)return socket.destroy();const end=buffer.indexOf('\n');if(end<0)return;try{const r=checked(job.key,JSON.parse(buffer.slice(0,end)));need(exact(r,['type','jobId','requestId'])&&r.type==='PROBE'&&r.jobId===e.jobId&&uuid(r.requestId),'VERIFICATION_JOB_REQUEST');socket.end(JSON.stringify(signed(job.key,status(r.requestId)))+'\n');}catch{socket.destroy();}});});
 server.on('error',()=>{logFailure=true;});
 await new Promise((ok,no)=>{server.once('error',no);server.listen(endpoint(job.directory,e.jobId),ok);});
 function consume(name,fd,data){byteCounts[name]+=data.length;lastOutputAt=new Date().toISOString();if(byteCounts[name]<=4*1024**2){try{writeSync(fd,data);}catch{logFailure=true;}}else truncated=true;lineBuffers[name]+=data.toString('utf8');if(lineBuffers[name].length>65536)lineBuffers[name]='';let end;while((end=lineBuffers[name].indexOf('\n'))>=0){const line=lineBuffers[name].slice(0,end);lineBuffers[name]=lineBuffers[name].slice(end+1);try{const p=JSON.parse(line);if(p.nativeStarted===true&&p.pid===child.pid&&/^[a-f0-9]{12}$/.test(p.nonce))nonce=p.nonce;if(Number.isInteger(p.check)&&p.check>=1&&p.check<=1000&&p.nonce===nonce)checkCount=p.check;if(typeof p.stage==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(p.stage))stage=p.stage;}catch{}}}
 try{
  child=spawn(process.execPath,[e.entryFile,...e.arguments],{cwd:e.workingDirectory,windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe']});phase='RUNNING';child.stdout.on('data',b=>consume('stdout',out,b));child.stderr.on('data',b=>consume('stderr',err,b));child.once('error',()=>{spawnFailed=true;});
  const childTerminal=new Promise(ok=>child.once('close',(code,signal)=>{exited={code,signal};stdoutClosed=child.stdout.closed;stderrClosed=child.stderr.closed;phase='DRAINING';ok();}));
  try{await privateNewFile(join(job.directory,'created.private.json'),JSON.stringify(signed(job.key,status())));}catch{logFailure=true;}
  await childTerminal;phase='CLOSED';
 }finally{
  for(const fd of [out,err])try{fsyncSync(fd);closeSync(fd);}catch{logFailure=true;}
  let entryUnchanged=false,supervisorUnchanged=false;try{entryUnchanged=(await readApplicationFileV1(e.entryFile)).sha256===e.entrySha256;supervisorUnchanged=(await readApplicationFileV1(ownFile)).sha256===e.supervisorSha256;}catch{}
  for(const socket of sockets)socket.destroy();await new Promise(ok=>server.close(ok));if(!exited)phase='FAILED';const terminal={...status(),entryUnchanged,supervisorUnchanged,normal:exited?.code===0&&exited.signal===null&&stdoutClosed&&stderrClosed&&!spawnFailed&&!logFailure&&!truncated&&entryUnchanged&&supervisorUnchanged&&sockets.size===0,probeSocketsRetired:sockets.size===0,at:new Date().toISOString()};await privateNewFile(join(job.directory,'terminal.private.json'),JSON.stringify(signed(job.key,terminal)));job.key.fill(0);console.log(JSON.stringify({jobId:e.jobId,phase:terminal.phase,nativePid:terminal.nativePid,nonce,exit:exited,normal:terminal.normal,checkCount}));
 }
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(ownFile)){
 need(process.argv.length===4&&process.argv[2]==='--supervise','VERIFICATION_JOB_COMMAND');superviseOwnedVerificationJobV1(process.argv[3]).catch(()=>{console.error('VERIFICATION_JOB_SUPERVISOR_FAILED');process.exitCode=1;});
}
