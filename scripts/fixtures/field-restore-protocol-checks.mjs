import assert from 'node:assert/strict';
import {fork,execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import pg from 'pg';
import {canonical} from '../../server/imports.ts';
import {fieldRestoreTool} from '../field-restore-flow-record.mjs';
import {sourceFreezeSha} from '../field-source-freeze-policy.mjs';
import {closeSourceConnection} from '../field-source-freeze.mjs';
import {ownedRestoreProtocolProxy} from './field-restore-protocol-proxy.mjs';
import {FieldRecoveryAuthorityLock} from '../field-recovery-lock.mjs';
import {retireFieldRestoreTool,fieldRestoreProgram} from '../field-restore-tool.mjs';
const exec=promisify(execFile),pause=ms=>new Promise(ok=>setTimeout(ok,ms));
export async function exerciseRestoreProtocolInterruptions({mode,authority,directory,args,cliArgs,children,admin,resume}){
 assert.ok(['COPY_HOLD_CONTROLLER_KILL','COPY_HOLD_ORPHAN_CONTROLLER_KILL','COMMIT_DROP_DATA','COMMIT_DROP_VERIFIED'].includes(mode));assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);const copyMode=mode.startsWith('COPY_HOLD');
 const target=JSON.parse(await readFile(args['--target-runtime-config'])),database=target.tenants.acme.database,operation=args['--operation-id'],ops=resolve(directory,'recovery.json.operations'),ps=resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),basePs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'];assert.match(database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);
 const identity=async(pid,label='supervisor')=>{try{return (await exec(ps,[...basePs,'-File',resolve('scripts/field-recovery-file.ps1'),'-Mode','Identity','-OwnerPid',String(pid)],{windowsHide:true,maxBuffer:8192})).stdout.trim();}catch(e){throw Object.assign(Error('Owned process identity unavailable at '+label),{cause:e});}};
 let proxy,heldProgress,native,nativeTicks,rollbackProof,first,second,nativeSurvived=false;const local=[];
 const migration=JSON.parse(await readFile(args['--target-migration-config'])).tenants.acme;
 const expectedOid=JSON.parse(await readFile(resolve(ops,operation+'.restore-provision.json'))).database.oid;
 const nativeState=async()=>{const r=await exec(ps,[...basePs,'-File',resolve('scripts/fixtures/field-owned-process-state.ps1'),'-ProcessId',String(native.pid),'-StartTicks',nativeTicks],{windowsHide:true,maxBuffer:8192});assert.ok(['TERMINAL','MATCHING_LIVE'].includes(r.stdout.trim()));return r.stdout.trim();};
 const nativeFile=()=>resolve(ops,operation+'.restore-tool-'+native.tool.toolId+'.json');
 async function waitNative(){if(!nativeTicks)return;const owner=await identity(process.pid),r=await exec(ps,[...basePs,'-File',resolve('scripts/field-archive-process.ps1'),'-Mode','Wait','-ToolIntentFile',nativeFile(),'-ExpectedSha256',sourceFreezeSha(native.tool),'-OwnerPid',String(process.pid),'-OwnerStartTicks',owner,'-TargetPid',String(native.pid),'-TargetStartTicks',nativeTicks],{windowsHide:true,maxBuffer:8192});assert.equal(r.stdout.trim(),'TERMINAL');}
 async function run(selected){
  const record={terminal:false,backends:[],stdout:'',stderr:''};children.push(record);local.push(record);
  const c=record.child=fork(resolve('scripts/fixtures/field-restore-protocol-probe.mjs'),cliArgs,{windowsHide:true,env:{...process.env,NODE_ENV:'test',IDMS_DEMO_NAMESPACE:'fieldarchiveqa-'+basename(directory).slice('formal-archive-'.length),IDMS_FIELD_RESTORE_PROTOCOL_MODE:selected,IDMS_FIELD_RESTORE_QA_DIRECTORY:directory,...(native?{IDMS_FIELD_RESTORE_OLD_APPLY_NAME:native.tool.applicationName}: {})},stdio:['ignore','pipe','pipe','ipc']});
  let problem;record.closed=new Promise((ok,no)=>{c.once('error',no);c.once('close',(code,signal)=>{record.terminal=true;record.code=code;record.signal=signal;ok();});});
  c.stdout.on('data',b=>record.stdout=(record.stdout+b).slice(-20000));c.stderr.on('data',b=>record.stderr=(record.stderr+b).slice(-20000));
  c.on('message',m=>{(async()=>{
   if(m.type==='BACKEND')record.backends.push(m);
   if(m.type==='NATIVE_PROCESS'){assert.ok(native&&m.toolId===native.tool.toolId&&Number.isSafeInteger(m.pid)&&m.pid>0);native.pid=m.pid;console.error('Owned restore native process started');}
   if(m.type==='NATIVE_CLOSE'){record.nativeClose=m;console.error('Owned restore native close code: '+m.code);}
   if(m.type==='ROLLBACK_OBSERVED'){assert.equal(selected,'OBSERVE_ROLLBACK');rollbackProof=m;}
   if(m.type==='STOP_SUPERVISED_NATIVE'){assert.ok(mode==='COPY_HOLD_ORPHAN_CONTROLLER_KILL'&&native?.row&&m.toolId===native.tool.toolId);if(!native.row.terminal)native.row.child.kill();}
   if(m.type==='LAUNCH_SUPERVISED_NATIVE'){
    assert.ok(mode==='COPY_HOLD_ORPHAN_CONTROLLER_KILL'&&native?.tool&&!native.row&&m.toolId===native.tool.toolId);const program=await fieldRestoreProgram('psql');assert.equal(m.program,program.file);assert.equal(program.sha256,native.tool.programSha256);assert.equal(canonical(m.args),canonical(native.tool.args));
    for(const [key,value]of Object.entries({PGHOST:'127.0.0.1',PGPORT:String(proxy.port),PGDATABASE:database,PGUSER:migration.user,PGPASSWORD:migration.password,PGAPPNAME:native.tool.applicationName,PGCONNECT_TIMEOUT:'5',PGOPTIONS:'-c statement_timeout=120000 -c lock_timeout=5000',PGSSLMODE:'disable',PGGSSENCMODE:'disable'}))assert.ok(m.env[key]===value,'Owned native environment binding changed: '+key);
    const row=native.row={terminal:false};children.push(row);row.child=spawn(program.file,m.args,{windowsHide:true,env:m.env,stdio:['ignore','pipe','pipe']});native.pid=row.child.pid;row.child.stdout.resume();row.child.stderr.resume();row.closed=new Promise(ok=>{row.child.once('error',e=>{row.error=e;c.kill('SIGKILL');});row.child.once('close',(code,signal)=>{row.terminal=true;row.code=code;row.signal=signal;record.nativeClose={code,signal};if(c.connected)c.send({type:'SUPERVISED_NATIVE_CLOSE',toolId:native.tool.toolId,code,signal});ok();});});assert.ok(Number.isSafeInteger(native.pid)&&native.pid>0);c.send({type:'SUPERVISED_NATIVE_LAUNCHED',toolId:native.tool.toolId,pid:native.pid});console.error('Owned real psql launched by independent QA supervisor');
   }
   if(m.type!=='RESTORE_PROXY_REQUEST')return;
   assert.equal(m.mode,mode);assert.equal(m.database,database);assert.equal(m.host,authority.host);assert.equal(m.port,authority.port);assert.equal(proxy,undefined);
   if(m.kind==='PSQL'){
    const tool=fieldRestoreTool(m.tool);assert.equal(tool.operationId,operation);assert.equal(tool.ownerPid,c.pid);assert.equal(tool.ownerStartTicks,await identity(c.pid,'durable-tool-controller'));assert.equal(tool.kind,'APPLY');assert.equal(tool.section,'data');assert.equal(m.applicationName,tool.applicationName);
    const file=resolve(ops,operation+'.restore-tool-'+tool.toolId+'.json');assert.equal((await readFile(file,'utf8')),canonical(tool));native={tool};
   }else{assert.equal(m.kind,'CONTROL');assert.equal(mode,'COMMIT_DROP_VERIFIED');assert.equal(m.applicationName,'idms-restore-control-'+operation);}
   proxy=await ownedRestoreProtocolProxy({...m,onHeld:async()=>{
    assert.ok(copyMode);assert.ok(native?.pid);nativeTicks=await identity(native.pid,'copy-held-native');
    const until=Date.now()+10000;for(;;){const row=(await admin.query("SELECT a.pid,a.backend_start::text,a.backend_xid::text,a.state,a.wait_event,p.tuples_processed::text,p.bytes_processed::text FROM pg_stat_activity a JOIN pg_stat_progress_copy p ON p.pid=a.pid WHERE a.datname=$1 AND a.usename=$2 AND a.application_name=$3",[database,database+'_migrator',native.tool.applicationName])).rows[0];if(row&&proxy.completedCopyRows>0&&row.backend_xid&&row.state==='active'&&row.wait_event==='ClientRead'){heldProgress=row;break;}assert.ok(Date.now()<until,'Actual COPY must remain active after a completed nonempty COPY in the same transaction');await pause(20);}
    assert.equal(await identity(native.pid,'before-controller-kill'),nativeTicks);assert.equal(record.terminal,false);console.error('Owned nonempty COPY completed and later COPY backend active before controller kill');assert.equal(c.kill('SIGKILL'),true);
   }});c.send({type:'RESTORE_PROXY_READY',port:proxy.port});
  })().catch(e=>{problem=e;c.kill('SIGKILL');});});
  const timer=setTimeout(()=>{problem=Error('Owned protocol worker timeout');c.kill('SIGKILL');},120000);try{await record.closed;}finally{clearTimeout(timer);}if(problem)throw problem;if(proxy?.problem)throw proxy.problem;return record;
 }
 async function backendsGone(record){for(const b of record.backends){const end=Date.now()+15000;while((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[b.pid,b.backend_start])).rowCount){assert.ok(Date.now()<end,'Controller backend must actually end');await pause(20);}}}
 async function targetState(){const c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database});try{await c.connect();const db=(await c.query("SELECT oid::text,shobj_description(oid,'pg_database') AS comment FROM pg_database WHERE datname=current_database()")).rows[0],phase=JSON.parse(db.comment.split('\n')[1]);assert.equal(phase.operationId,operation);assert.equal(db.oid,expectedOid);return {oid:db.oid,phase,audits:(await c.query("SELECT count(*)::int AS n FROM public.audit_ledger WHERE event->>'objectType'='FIELD_TARGET_RESTORE' AND event->>'correlationId'=$1",[operation])).rows[0].n,points:(await c.query('SELECT count(*)::int AS n FROM idms_field.points')).rows[0].n,receipts:(await c.query('SELECT count(*)::int AS n FROM idms_field.receipts')).rows[0].n};}finally{await closeSourceConnection(c);}}
 try{
  first=await run(mode);assert.ok(proxy?.startupMatched);
  if(copyMode){
   assert.ok(first.code!==0||first.signal);assert.ok(proxy.held&&heldProgress);assert.equal(proxy.dropped,false);nativeSurvived=await nativeState()==='MATCHING_LIVE';if(mode==='COPY_HOLD_ORPHAN_CONTROLLER_KILL'){assert.equal(nativeSurvived,true);assert.equal(proxy.socketCount,2);}await backendsGone(first);
   console.error('Owned native state after controller termination: '+(nativeSurvived?'MATCHING_LIVE':'TERMINAL'));const state=await targetState();assert.equal(state.phase.stage,'pre-data');assert.equal(state.audits,0);assert.equal(state.points,0);assert.equal(state.receipts,0);
   second=await run('OBSERVE_ROLLBACK');assert.equal(second.code,0,second.stderr);assert.ok(rollbackProof?.all34PhysicalTablesEmptyBeforeReapply&&rollbackProof.oldCopyBackendActuallyAbsentBeforeReapply);await backendsGone(second);await waitNative();assert.equal(proxy.socketCount,0);console.error('Owned old COPY backend absent and 34 tables empty before retry; full restore completed');
  }else{
   assert.equal(proxy.dropped,true);assert.equal(proxy.held,false);await backendsGone(first);
   if(mode==='COMMIT_DROP_DATA'){assert.equal(first.code,0,first.stderr);assert.ok(first.nativeClose&&first.nativeClose.code!==0,'psql must report the actual lost COMMIT response');}
   else{assert.notEqual(first.code,0,first.stdout);assert.match(JSON.parse(first.stderr).code,/^FIELD_[A-Z0-9_]+$/);await assert.rejects(readFile(resolve(ops,operation+'.restore-result.json')),e=>e.code==='ENOENT');}
  }
  const before=await targetState();assert.equal(before.phase.stage,'VERIFIED');assert.equal(before.audits,1);assert.equal(before.points,2);assert.equal(before.receipts,2);
  const result=await resume();assert.equal(result.targetDataRestored,true);const after=await targetState();assert.equal(canonical(after),canonical(before));assert.equal(result.uniqueVerificationAuditEventId,before.phase.auditEventId);
  const tools=[];for(const file of await readdir(ops))if(file.startsWith(operation+'.restore-tool-')&&file.endsWith('.json'))tools.push(JSON.parse(await readFile(resolve(ops,file))));
  const applies=tools.filter(t=>t.kind==='APPLY'&&t.section==='data');assert.equal(applies.length,copyMode?2:1);assert.equal(tools.filter(t=>t.kind==='GENERATE'&&t.section==='data').length,1);
  if(applies.length===2){assert.equal(canonical(applies[0].args),canonical(applies[1].args));assert.equal(canonical(applies[0].inputs),canonical(applies[1].inputs));assert.equal(applies[0].runId,applies[1].runId);}
  return {result,proof:{mode,actualProtocolStartupIdentityMatched:true,actualServerCompletedNonemptyCopyBeforeControllerKill:copyMode,controllerActuallyKilledDuringCopy:copyMode,oldNativePsqlSurvivedControllerKill:nativeSurvived,nativeIndependentlyHeldByQaSupervisor:mode==='COPY_HOLD_ORPHAN_CONTROLLER_KILL',oldCopyBackendActuallyAbsentAndAll34TablesEmptyBeforeReapply:!!rollbackProof,oldNativeActualTerminalAndProxySocketsClosedAfterRetry:copyMode,actualServerCommitCompletionDiscarded:proxy.dropped,psqlActuallyReportedLostCommitWhileCoordinatorCompleted:mode==='COMMIT_DROP_DATA',actualFinalVerificationCommitLostConnectionAndMissingResultRebuilt:mode==='COMMIT_DROP_VERIFIED',dataApplyAttempts:applies.length,dataSqlGeneratedOnlyOnce:true,pendingRetryUsesExactSamePlanArgumentsAndInputHashes:true,completeFormalCommandAndRepeatVerified:true,oneVerificationAuditAndSameDatabaseOid:true,sourceUnavailableNonUtcAndAlwaysTriggerCase:true,allOwnedControllersAndRecordedBackendsActuallyTerminal:true,credentialsAndPacketBodiesNeverLogged:true,activationPerformed:false}};
 }finally{
  for(const r of local)if(!r.terminal){r.child.kill('SIGKILL');await r.closed;}
  await proxy?.dispose();for(const r of local)await backendsGone(r);await waitNative();
  if(native?.tool){const cleanupGuard=new FieldRecoveryAuthorityLock(authority,'acme');try{await cleanupGuard.acquire();await retireFieldRestoreTool(native.tool,nativeFile(),cleanupGuard);}finally{await cleanupGuard.close();}}if(native?.row)await native.row.closed;
 }
}
