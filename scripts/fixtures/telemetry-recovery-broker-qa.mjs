// Fresh loopback password/ACL broker, with the existing exact-creator native
// shutdown capability. Never adopts or terminates an existing broker.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function createTelemetryRecoveryBrokerQa(parent,tooling,source){
 assert(/^[A-Za-z0-9_-]{1,80}$/.test(source.tenantId)&&/^[A-Za-z0-9_-]{1,80}$/.test(source.edgeId));
 const owner=randomUUID(),challenge=randomBytes(32).toString('hex'),directory=join(resolve(parent),'mqtt-broker-process-'+owner);await mkdir(directory,{recursive:false,mode:0o700});
 const socket=createServer();await new Promise((ok,no)=>{socket.once('error',no);socket.listen(0,'127.0.0.1',ok);});const port=socket.address().port;await new Promise(ok=>socket.close(ok));assert(![1883,1884,4010,8081,45432].includes(port));
 const suffix=process.platform==='win32'?'.exe':'',program=resolve(tooling,'mosquitto'+suffix),configFile=join(directory,'mosquitto.conf'),acl=join(directory,'mqtt-acl'),passwords=join(directory,'passwords'),core={username:'qa-core',password:randomBytes(32).toString('base64url')},edge={username:'qa-edge',password:randomBytes(32).toString('base64url')};
 const help=await exec(program,['-h'],{windowsHide:true,maxBuffer:65536}),version=(help.stdout+help.stderr).match(/mosquitto version ([0-9.]+)/)?.[1];assert(version,'OWNED_MQTT_VERSION_REQUIRED');
 await writeFile(passwords,`${core.username}:${core.password}\n${edge.username}:${edge.password}\n`,{flag:'wx',mode:0o600});await exec(resolve(tooling,'mosquitto_passwd'+suffix),['-U',passwords],{windowsHide:true,maxBuffer:65536});
 const topic=`idms/v1/${source.tenantId}/${source.edgeId}`,native=p=>p.replaceAll('\\','/');
 await writeFile(acl,`user ${core.username}\ntopic read ${topic}/telemetry\ntopic write ${topic}/ack\nuser ${edge.username}\ntopic write ${topic}/telemetry\ntopic read ${topic}/ack\n`,{flag:'wx',mode:0o600});
 const conf=`listener ${port} 127.0.0.1\nallow_anonymous false\nuse_username_as_clientid false\npassword_file ${native(passwords)}\nacl_file ${native(acl)}\nmax_packet_size 16384\nmax_queued_messages 20\nmax_inflight_messages 10\npersistence false\nretain_available false\nlog_type error\nlog_type warning\n`;
 await writeFile(configFile,conf,{flag:'wx',mode:0o600});const configSha256=hash(conf),programHash=hash(await readFile(program));
 const child=spawn(program,['-c',configFile],{windowsHide:true,stdio:['ignore','pipe','pipe']});let log='',exit,identity;
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log=(log+b.toString('utf8')).slice(-8192);});
 const terminal=new Promise(ok=>{child.once('error',e=>{exit={spawnError:e.code};ok(exit);});child.once('close',(code,signal)=>{exit={code,signal,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed};ok(exit);});});
 async function control(action){
  assert(!exit);assert.equal(hash(await readFile(program)),programHash);assert.equal(hash(await readFile(configFile)),configSha256);
  const requestFile=join(directory,'control-'+randomUUID()+'.request.private.json'),resultFile=requestFile.replace('.request.private.json','.result.private.json');
  await writeFile(requestFile,JSON.stringify({format:'IDMS_MQTT_BROKER_WIN_CONTROL_V1',action,owner,challenge,parentPid:process.pid,pid:child.pid,expectedCreatedFileTime:identity?.createdFileTime??null,program,configFile,configSha256,port,resultFile}),{flag:'wx',mode:0o600});
  await exec(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/mqtt-broker-windows-control-v1.ps1'),requestFile],{windowsHide:true,maxBuffer:8192});
  const r=JSON.parse(await readFile(resultFile,'utf8'));assert.equal(r.errorCode,null);assert.equal(r.pid,child.pid);assert.equal(r.parentPid,process.pid);assert.equal(r.challengeSha256,hash(challenge));assert(r.commandLineBound);if(identity)assert.equal(r.createdFileTime,identity.createdFileTime);return r;
 }
 let stopping;const close=()=>stopping??=(async()=>{
  let proof;if(!exit){if(process.platform==='win32'){assert(identity?.createdFileTime);proof=await control('SHUTDOWN');assert(proof.delivered);}else child.kill('SIGINT');}
  const end=await terminal;assert.equal(end.code,0);assert.equal(end.signal,null);assert(end.stdoutClosed&&end.stderrClosed);await writeFile(join(directory,'normal-stop-proof.json'),JSON.stringify({owner,pid:child.pid,proof,end}),{flag:'wx',mode:0o600});return {normalStop:true,...end};
 })();
 const handle={directory,core,edge,url:'mqtt://127.0.0.1:'+port,child,terminal,close,version,programHash,ready:async()=>{for(let i=0;i<30;i++){
  if(exit)throw Error('OWNED_RECOVERY_BROKER_EXITED');
  if(process.platform==='win32'){const r=await control('INSPECT');identity??={createdFileTime:r.createdFileTime};if(r.ownListener&&r.eventAvailable)return;}
  else{const connection=await import('node:net');const ready=await new Promise(ok=>{const c=connection.createConnection({host:'127.0.0.1',port});c.once('connect',()=>{c.destroy();ok(true);});c.once('error',()=>ok(false));});if(ready)return;}
  await new Promise(ok=>setTimeout(ok,50));
 }
 await writeFile(join(directory,'startup-unconfirmed.private.json'),JSON.stringify({owner,pid:child.pid,identity,log}),{flag:'wx',mode:0o600});throw Error('OWNED_RECOVERY_BROKER_UNCONFIRMED');
 }};return handle;
}
