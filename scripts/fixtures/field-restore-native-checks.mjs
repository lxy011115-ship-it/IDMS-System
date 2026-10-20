import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {writeFile,unlink,lstat} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {FieldRecoveryAuthorityLock} from '../field-recovery-lock.mjs';
import {fieldRestoreProgram,retireFieldRestoreTool,runFieldRestoreTool} from '../field-restore-tool.mjs';
import {canonical} from '../../server/imports.ts';
import {sourceFreezeSha} from '../field-source-freeze-policy.mjs';
export async function exerciseRestoreNativeRetirement({authority,directory,operationId}){
 if(process.env.NODE_ENV!=='test'||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory)))throw Error('Owned native restore fixture required');
 const guard=new FieldRecoveryAuthorityLock(authority,'acme'),sockets=new Set(),connections=[],server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));connections.splice(0).forEach(ok=>ok());});
 const runId=randomUUID(),toolId=randomUUID(),toolFile=resolve(directory,operationId+'.restore-tool-'+toolId+'.json'),paths=['prefix','sql','marker'].map(p=>resolve(directory,'native-restore-'+runId+'.'+p)),children=[];
 const start=(program,args,port)=>{const child=spawn(program,args,{windowsHide:true,env:{...process.env,PGHOST:'127.0.0.1',PGPORT:String(port),PGDATABASE:'owned_native_qa',PGUSER:'owned_native_qa',PGPASSWORD:'owned-no-database-credential',PGCONNECT_TIMEOUT:'30'},stdio:['ignore','ignore','ignore']});const row={child,terminal:false};row.closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',()=>{row.terminal=true;ok();});});children.push(row);return row;};
 try{
  await guard.acquire();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const p=await fieldRestoreProgram('psql'),body=Buffer.from('\n');for(const file of paths)await writeFile(file,body,{flag:'wx',mode:0o600});
  const args=['--no-psqlrc','--no-password','--quiet','--single-transaction','--set=ON_ERROR_STOP=1',...paths.map(p=>'--file='+p)],tool={format:'idms-field-restore-tool-v1',operationId,restoreIntentSha256:'a'.repeat(64),runId,toolId,kind:'APPLY',section:'data',program:p.file,programSha256:p.sha256,args,...guard.ownerIdentity,applicationName:'idms-field-restore-'+toolId,inputs:paths.map(path=>({path,bytes:body.length,sha256:sourceFreezeSha(body)})),output:null};
  await writeFile(toolFile,canonical(tool),{flag:'wx',mode:0o600});
  for(const argv of [args,[...args.slice(0,-1),'--file='+paths[0]]]){const connected=new Promise(ok=>connections.push(ok)),child=start(p.file,argv,server.address().port);await Promise.race([connected,child.closed.then(()=>{throw Error('Owned psql exited before handshake');})]);assert.equal(child.terminal,false);}
  await assert.rejects(retireFieldRestoreTool({...tool,programSha256:'0'.repeat(64)},toolFile,guard),e=>e.code==='FIELD_RESTORE_PROGRAM_CHANGED');assert.ok(children.every(c=>!c.terminal));
  await retireFieldRestoreTool(tool,toolFile,guard);await children[0].closed;assert.equal(children[0].terminal,true);assert.equal(children[1].terminal,false);await retireFieldRestoreTool(tool,toolFile,guard);assert.equal(children[1].terminal,false);
  const prior={PGSERVICE:process.env.PGSERVICE,PGSERVICEFILE:process.env.PGSERVICEFILE},abort=new AbortController(),connected=new Promise(ok=>connections.push(ok));
  try{process.env.PGSERVICE='owned-missing-service';process.env.PGSERVICEFILE=resolve(directory,'owned-missing-service.conf');const finished=assert.rejects(runFieldRestoreTool(tool,{runtime:{host:'127.0.0.1',port:server.address().port},account:{database:'owned_native_qa',user:'owned_native_qa',password:'owned-no-database-credential'},guard,check:()=>guard.assertHeld(),signal:abort.signal}),e=>e.code==='FIELD_RESTORE_CANCELLED');try{await Promise.race([connected,finished.then(()=>{throw Error('Owned connection must ignore inherited libpq service');})]);}finally{abort.abort();await finished;}}finally{for(const [key,value]of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;}
  return {actualPinnedPsqlHeldAtOwnedLocalHandshake:true,exactRecordedFullArgvRetiredAndActualCloseAwaited:true,wrongProgramShaDoesNotKillEitherProcess:true,differentArgvPsqlRemainsAlive:true,repeatedRetirementOnlyConfirmsOwnedTerminal:true,actualToolIgnoresInheritedLibpqServiceAndCancellationAwaitsClose:true,notAnActiveDataTransactionCrashTest:true};
 }finally{
  for(const row of children){row.child.kill();await row.closed;}for(const s of sockets)s.destroy();if(server.listening)await new Promise(ok=>server.close(ok));await guard.close();
  for(const path of [toolFile,...paths])try{const s=await lstat(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
