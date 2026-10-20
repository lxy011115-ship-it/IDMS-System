import assert from 'node:assert/strict';
import {fork,spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,open,lstat,unlink} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {archiveTool} from '../field-archive-record.mjs';
import {archiveDumpProgram,retireArchiveTool} from '../field-archive-command.mjs';
import {fieldRestoreProgram} from '../field-restore-tool.mjs';
import {hashFieldBackupFile} from '../field-backup-archive.mjs';
import {sourceFreezeSha} from '../field-source-freeze-policy.mjs';
import {FieldRecoveryAuthorityLock} from '../field-recovery-lock.mjs';
import {ownedArchiveExportProxy} from './field-archive-export-proxy.mjs';
const exec=promisify(execFile),pause=ms=>new Promise(ok=>setTimeout(ok,ms));
export async function exerciseArchiveExportInterruption({mode,authority,directory,args,cliArgs,children,admin,resume}){
 assert.ok(['DIRECT_COPY_OUT','SUPERVISED_COPY_OUT'].includes(mode));assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);
 const runtime=JSON.parse(await readFile(resolve(directory,'runtime.json'))),backup=JSON.parse(await readFile(args['--backup-config'])).tenants.acme,database=runtime.tenants.acme.database,op=args['--operation-id'],ops=resolve(directory,'recovery.json.operations'),ps=resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),psArgs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];assert.match(database,/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/);assert.equal(backup.user,runtime.tenants.acme.backupRole);
 const freeze=JSON.parse(await readFile(resolve(ops,op+'.source-freeze-intent.json'))),identity=async pid=>(await exec(ps,[...psArgs,'-File',resolve('scripts/field-recovery-file.ps1'),'-Mode','Identity','-OwnerPid',String(pid)],{windowsHide:true,maxBuffer:8192})).stdout.trim();
 let proxy,native,ticks,heldBackend,partial,partialInspectionFailed=false,observedRetry,nativeSurvived=false;const locals=[],inspectionFile=resolve(directory,'owned-partial-inspection-'+randomUUID()+'.sql');
 const toolFile=()=>resolve(ops,op+'.archive-tool-'+native.tool.runId+'.json');
 const nativeState=async()=>(await exec(ps,[...psArgs,'-File',resolve('scripts/fixtures/field-owned-process-state.ps1'),'-ProcessId',String(native.pid),'-StartTicks',ticks],{windowsHide:true,maxBuffer:8192})).stdout.trim();
 async function waitNative(){if(!ticks)return;const owner=await identity(process.pid),answer=await exec(ps,[...psArgs,'-File',resolve('scripts/field-archive-process.ps1'),'-Mode','Wait','-ToolIntentFile',toolFile(),'-ExpectedSha256',sourceFreezeSha(native.tool),'-OwnerPid',String(process.pid),'-OwnerStartTicks',owner,'-TargetPid',String(native.pid),'-TargetStartTicks',ticks],{windowsHide:true,maxBuffer:8192});assert.equal(answer.stdout.trim(),'TERMINAL');}
 async function backendsGone(row){for(const b of row.backends){const end=Date.now()+15000;while((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[b.pid,b.backend_start])).rowCount){assert.ok(Date.now()<end,'Owned exporter controller backend must end');await pause(20);}}}
 async function run(selected){
  const row={terminal:false,backends:[],stdout:'',stderr:''};children.push(row);locals.push(row);
  const child=row.child=fork(resolve('scripts/fixtures/field-archive-export-probe.mjs'),cliArgs,{windowsHide:true,env:{...process.env,NODE_ENV:'test',IDMS_DEMO_NAMESPACE:'fieldarchiveqa-'+basename(directory).slice('formal-archive-'.length),IDMS_FIELD_ARCHIVE_EXPORT_MODE:selected,IDMS_FIELD_ARCHIVE_EXPORT_DIRECTORY:directory,...(native?{IDMS_FIELD_ARCHIVE_OLD_TOOL_FILE:toolFile(),IDMS_FIELD_ARCHIVE_OLD_PID:String(native.pid),IDMS_FIELD_ARCHIVE_OLD_TICKS:ticks}: {})},stdio:['ignore','pipe','pipe','ipc']});
  let problem;row.closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>{row.terminal=true;row.code=code;row.signal=signal;ok();});});child.stdout.on('data',b=>row.stdout=(row.stdout+b).slice(-20000));child.stderr.on('data',b=>row.stderr=(row.stderr+b).slice(-20000));
  child.on('message',m=>{(async()=>{
   if(m.type==='BACKEND')row.backends.push(m);
   if(m.type==='EXPORT_NATIVE_PROCESS'){assert.ok(native&&native.tool.runId===m.runId&&Number.isSafeInteger(m.pid)&&m.pid>0);native.pid=m.pid;}
   if(m.type==='EXPORT_RETRY_OBSERVED'){assert.equal(selected,'OBSERVE_RETRY');observedRetry=m;}
   if(m.type==='STOP_SUPERVISED_EXPORT'){assert.ok(mode==='SUPERVISED_COPY_OUT'&&native?.row&&m.runId===native.tool.runId);if(!native.row.terminal)native.row.child.kill();}
   if(m.type==='LAUNCH_SUPERVISED_EXPORT'){
    assert.ok(mode==='SUPERVISED_COPY_OUT'&&native?.tool&&!native.row&&m.runId===native.tool.runId);const program=await archiveDumpProgram();assert.equal(program.file,m.program);assert.equal(program.sha256,native.tool.programSha256);assert.equal(canonical(m.args),canonical(native.tool.args));
    for(const [key,value]of Object.entries({PGHOST:'127.0.0.1',PGPORT:String(proxy.port),PGDATABASE:database,PGUSER:backup.user,PGPASSWORD:backup.password,PGAPPNAME:native.tool.applicationName,PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c statement_timeout=120000 -c default_transaction_read_only=on',PGSSLMODE:'disable',PGGSSENCMODE:'disable'}))assert.ok(m.env[key]===value,'Owned exporter environment binding changed: '+key);
    assert.equal(m.env.PGSERVICE,undefined);assert.equal(m.env.PGSERVICEFILE,undefined);const processRow=native.row={terminal:false};children.push(processRow);processRow.child=spawn(program.file,m.args,{windowsHide:true,env:m.env,stdio:['ignore','pipe','pipe']});native.pid=processRow.child.pid;processRow.child.stdout.resume();processRow.child.stderr.resume();processRow.closed=new Promise(ok=>{processRow.child.once('error',e=>{processRow.error=e;child.kill('SIGKILL');});processRow.child.once('close',(code,signal)=>{processRow.terminal=true;processRow.code=code;processRow.signal=signal;if(child.connected)child.send({type:'SUPERVISED_EXPORT_CLOSE',runId:native.tool.runId,code,signal});ok();});});assert.ok(Number.isSafeInteger(native.pid));child.send({type:'SUPERVISED_EXPORT_LAUNCHED',runId:native.tool.runId,pid:native.pid});
   }
   if(m.type!=='EXPORT_PROXY_REQUEST')return;assert.equal(proxy,undefined);assert.equal(m.mode,mode);assert.equal(m.database,database);assert.equal(m.host,authority.host);assert.equal(m.port,authority.port);assert.equal(m.user,backup.user);
   const tool=archiveTool(m.tool);assert.equal(tool.operationId,op);assert.equal(tool.ownerPid,child.pid);assert.equal(tool.ownerStartTicks,await identity(child.pid));assert.equal(tool.dumpFile,resolve(ops,op+'.archive-dump-'+tool.runId+'.tmp'));assert.equal(await readFile(resolve(ops,op+'.archive-tool-'+tool.runId+'.json'),'utf8'),canonical(tool));native={tool};
   proxy=await ownedArchiveExportProxy({...m,applicationName:tool.applicationName,onHeld:async()=>{
    assert.ok(native?.pid&&proxy.completedRows>0&&proxy.forwardedCopyBytes>0);ticks=await identity(native.pid);
    const end=Date.now()+10000;for(;;){const state=(await admin.query("SELECT pid,backend_start::text,backend_xmin::text,state FROM pg_stat_activity WHERE datid=$1::oid AND usesysid=$2::oid AND application_name=$3 AND ltrim(query) LIKE 'COPY %'",[freeze.database.oid,freeze.roles.backup.oid,tool.applicationName])).rows[0];if(state?.backend_xmin&&['active','idle in transaction'].includes(state.state)){heldBackend=state;break;}assert.ok(Date.now()<end,'Actual readonly COPY export must retain its imported snapshot');await pause(20);}
    await pause(150);partial=await hashFieldBackupFile(tool.dumpFile);assert.ok(partial.bytes>5);const f=await open(tool.dumpFile,'r');try{const header=Buffer.alloc(5);assert.equal((await f.read(header,0,5,0)).bytesRead,5);assert.equal(header.toString('ascii'),'PGDMP');}finally{await f.close();}
    const restore=await fieldRestoreProgram('pg_restore');try{await exec(restore.file,['--no-owner','--no-acl','--section=data','--file='+inspectionFile,tool.dumpFile],{windowsHide:true,maxBuffer:8192,timeout:10000});}catch(e){assert.ok(Number.isInteger(e.code)&&e.code>0&&!e.killed&&!e.signal);partialInspectionFailed=true;}assert.equal(partialInspectionFailed,true);assert.equal(await identity(native.pid),ticks);console.error('Owned pg_dump consumed nonempty COPY data; incomplete PGDMP measured before controller kill');assert.equal(child.kill('SIGKILL'),true);
   }});child.send({type:'EXPORT_PROXY_READY',port:proxy.port});
  })().catch(e=>{problem=e;child.kill('SIGKILL');});});
  const timer=setTimeout(()=>{problem=Error('Owned export controller timeout');child.kill('SIGKILL');},120000);try{await row.closed;}finally{clearTimeout(timer);}if(problem)throw problem;if(proxy?.problem)throw proxy.problem;return row;
 }
 try{
  const first=await run(mode);assert.ok(first.code!==0||first.signal);assert.ok(proxy?.held&&proxy.startupMatched&&heldBackend&&partialInspectionFailed);nativeSurvived=await nativeState()==='MATCHING_LIVE';if(mode==='SUPERVISED_COPY_OUT'){assert.equal(nativeSurvived,true);assert.equal(proxy.socketCount,2);}await backendsGone(first);
  const intent=JSON.parse(await readFile(resolve(ops,op+'.archive-intent.json')));assert.equal(intent.backupId,native.tool.backupId);for(const name of ['archive-ready','archive-result'])await assert.rejects(readFile(resolve(ops,op+'.'+name+'.json')),e=>e.code==='ENOENT');assert.equal((await readdir(args['--archive-directory'])).length,0);assert.equal(canonical(await hashFieldBackupFile(native.tool.dumpFile)),canonical(partial));
  console.error('Owned partial dump remains unsealed; native state: '+(nativeSurvived?'MATCHING_LIVE':'TERMINAL'));
  const retry=await run('OBSERVE_RETRY');assert.equal(retry.code,0,retry.stderr);assert.ok(observedRetry?.oldNativeActuallyTerminalBeforeNewTool&&observedRetry.oldSourceDumpBackendActuallyAbsent&&observedRetry.oldPartialDumpActuallyRemovedBeforeNewTool);await backendsGone(retry);await waitNative();assert.equal(proxy.socketCount,0);
  const result=JSON.parse(retry.stdout);assert.equal(result.backupId,intent.backupId);assert.equal(result.alreadyRecorded,false);assert.equal(result.fullArchiveAuthenticationVerified,true);assert.equal(result.fullDumpSha256Verified,true);const repeated=await resume();assert.equal(repeated.alreadyRecorded,true);assert.equal(repeated.backupId,result.backupId);assert.equal(repeated.archiveSha256,result.archiveSha256);
  const tools=[];for(const file of await readdir(ops))if(file.startsWith(op+'.archive-tool-')&&file.endsWith('.json'))tools.push(JSON.parse(await readFile(resolve(ops,file))));assert.equal(tools.length,2);assert.notEqual(tools[0].runId,tools[1].runId);assert.ok(tools.every(t=>t.backupId===intent.backupId&&t.archiveIntentSha256===sourceFreezeSha(intent)));for(const t of tools)await assert.rejects(lstat(t.dumpFile),e=>e.code==='ENOENT');
  return {result,proof:{mode,actualReadonlySnapshotCopyOutTransferredNonemptyData:true,actualIncompletePgdmpExistsAndOfflineDataExtractionRefused:true,controllerActuallyKilledDuringDataExport:true,oldNativeSurvivedControllerKill:nativeSurvived,nativeIndependentlyHeldByQaSupervisor:mode==='SUPERVISED_COPY_OUT',oldDumpNotSealedOrPublished:true,oldPartialStableUntilRetry:true,oldNativeTerminalAndSourceBackendAbsentAndPartialRemovedBeforeNewTool:true,twoDistinctDumpRunsPreserveOriginalBackupAndIntent:true,completedArchiveFullyAuthenticatedAndRepeatedExactCipher:true,allActualNativeCloseAndControllerBackendsAwaited:true,inheritedInvalidLibpqServiceIgnoredByActualExport:true,credentialsAndCopyBodiesNeverLogged:true,sourceDatabaseOrBusinessRowsNotMutatedByExport:true,activationPerformed:false}};
 }finally{
  for(const row of locals)if(!row.terminal){row.child.kill('SIGKILL');await row.closed;}await proxy?.dispose();for(const row of locals)await backendsGone(row);await waitNative();if(native?.tool){const guard=new FieldRecoveryAuthorityLock(authority,'acme');try{await guard.acquire();await retireArchiveTool(native.tool,toolFile(),guard);}finally{await guard.close();}}if(native?.row)await native.row.closed;
  try{const s=await lstat(inspectionFile);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);await unlink(inspectionFile);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
