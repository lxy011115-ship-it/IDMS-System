import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {writeFile,unlink,lstat} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {archiveDumpProgram,retireArchiveTool} from '../field-archive-command.mjs';
import {FieldRecoveryAuthorityLock} from '../field-recovery-lock.mjs';
import {canonical} from '../../server/imports.ts';
import {sourceFreezeSha} from '../field-source-freeze-policy.mjs';
export async function exerciseArchiveNativeRetirement({authority,directory,operationId,backupId}){
 if(process.env.NODE_ENV!=='test'||!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory)))throw Error('Owned native archive fixture required');
 const guard=new FieldRecoveryAuthorityLock(authority,'acme'),sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
 let child,closed,connectedResolve,logical,logicalClosed,inspector,inspectorClosed;const connected=new Promise(ok=>connectedResolve=ok);server.on('connection',()=>connectedResolve());
 const runId=randomUUID(),toolFile=resolve(directory,operationId+'.archive-tool-'+runId+'.json'),dumpFile=resolve(directory,'native-dump-'+runId+'.tmp');
 try{
  await guard.acquire();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const program=await archiveDumpProgram(),tool={format:'idms-field-archive-tool-v1',operationId,backupId,runId,archiveIntentSha256:'a'.repeat(64),...guard.ownerIdentity,program:program.file,programSha256:program.sha256,args:['--format=custom','--no-owner','--no-acl','--no-password','--strict-names','--schema=public','--schema=idms_field','--snapshot=00000000-00000000-1','--file='+dumpFile,'--lock-wait-timeout=5s'],applicationName:'idms-field-archive-'+runId,dumpFile};
  await writeFile(toolFile,canonical(tool),{flag:'wx',mode:0o600});
  // Real pinned pg_dump deliberately waits at this owned local handshake.
  // It has no production credentials or connection to a source database.
  child=spawn(program.file,tool.args,{windowsHide:true,env:{...process.env,PGHOST:'127.0.0.1',PGPORT:String(server.address().port),PGDATABASE:'owned_native_qa',PGUSER:'owned_native_qa',PGPASSWORD:'owned-no-database-credential',PGCONNECT_TIMEOUT:'30'},stdio:['ignore','ignore','ignore']});
  let terminal=false;closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',()=>{terminal=true;ok();});});
  await Promise.race([connected,closed.then(()=>{throw Error('Owned native dump exited before handshake');})]);assert.equal(terminal,false);
  const changed={...tool,programSha256:'0'.repeat(64)};await assert.rejects(retireArchiveTool(changed,toolFile,guard),e=>e.code==='FIELD_ARCHIVE_TOOL_BINDING_INVALID');assert.equal(terminal,false);
  assert.equal(sourceFreezeSha(tool),sourceFreezeSha(canonical(tool)));
  const exec=promisify(execFile),ps=resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),common=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];
  logical=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});logicalClosed=new Promise((ok,no)=>{logical.once('error',no);logical.once('close',ok);});
  const ticks=async pid=>(await exec(ps,[...common,'-File',resolve('scripts/field-recovery-file.ps1'),'-Mode','Identity','-OwnerPid',String(pid)],{windowsHide:true})).stdout.trim();
  const logicalTicks=await ticks(logical.pid),dumpTicks=await ticks(child.pid),script=resolve('scripts/field-archive-process.ps1');
  const args=[...common,'-File',script,'-ToolIntentFile',toolFile,'-ExpectedSha256',sourceFreezeSha(tool)];
  // A later logical controller has a different PID from the dump creator.
  // Its live inspector must still be found through this exact tool record.
  inspector=execFile(ps,[...args,'-Mode','Wait','-OwnerPid',String(logical.pid),'-OwnerStartTicks',logicalTicks,'-TargetPid',String(child.pid),'-TargetStartTicks',dumpTicks],{windowsHide:true,maxBuffer:65536},()=>{});
  inspectorClosed=new Promise((ok,no)=>{inspector.once('error',no);inspector.once('close',ok);});
  const seen=await exec(ps,[...args,'-Mode','Inspect','-OwnerPid',String(guard.ownerIdentity.ownerPid),'-OwnerStartTicks',guard.ownerIdentity.ownerStartTicks],{windowsHide:true,maxBuffer:65536});
  assert.ok(JSON.parse(seen.stdout).some(p=>p.pid===inspector.pid&&p.kind==='helper'));
  await retireArchiveTool(tool,toolFile,guard);await closed;assert.equal(terminal,true);
  assert.equal(await inspectorClosed,0);logical.kill();await logicalClosed;
  await retireArchiveTool(tool,toolFile,guard);
  return {realPinnedDumpHeldAtOwnedLocalHandshake:true,wrongPinnedProgramHashDoesNotKillIt:true,cimExactArgvAndCreationTimeRetirement:true,differentControllerPidInspectorFoundByExactToolFileAndSha:true,actualInspectorAndLogicalHelperCloseAwaited:true,actualNativeChildCloseAwaited:true,repeatTerminalInspection:true,notADataExportCrashTest:true};
 }finally{
  if(child&&closed){child.kill();await closed;}
  if(inspectorClosed)await inspectorClosed;if(logical){logical.kill();await logicalClosed;}
  for(const socket of sockets)socket.destroy();if(server.listening)await new Promise(ok=>server.close(ok));await guard.close();
  for(const path of [toolFile,dumpFile])try{const s=await lstat(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
