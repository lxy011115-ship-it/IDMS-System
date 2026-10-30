import assert from 'node:assert/strict';
import {readFile,rm,copyFile,open,link,stat,readdir,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fork,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID,createHash,randomBytes} from 'node:crypto';
import pg from 'pg';
import {workflowJava} from './workflow-local.mjs';
import {restoreWorkflowQa,cleanupWorkflowQa} from '../work/workflow-runtime-upgrade-20261018/workflow-backup.mjs';
import {createWorkflowFreezeAuthority,runWorkflowFreeze} from './workflow-freeze-control.mjs';
import {createWorkflowArchive} from './workflow-archive.mjs';
import {restoreWorkflowArchiveV2} from './workflow-archive-restore.mjs';
import {generateWorkflowArchiveKey,authenticateWorkflowArchiveV2,sealWorkflowArchive,finishWorkflowArchiveLink} from './workflow-archive-container.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {workflowArchiveOwner,workflowDumpProgram,retireWorkflowNative} from './workflow-archive-native.mjs';
import {canonical,digest} from '../server/imports.ts';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,'')),main=await read('.local/postgres-runtime.json'),copy=await read('work/workflow-runtime-upgrade-20261018/readiness-private-state.json');
const nativeTest=process.argv.includes('--native-retirement');
const activeCopyTest=process.argv.includes('--active-copy');
const label=process.argv[2]||'kernel';assert.match(label,/^[a-z0-9-]{1,32}$/);const outputFile=resolve('outputs/workflow-archive-'+label+'-verification.json');await assert.rejects(access(outputFile),{code:'ENOENT'});
const suffix=randomUUID().replaceAll('-','').slice(0,10),nonce=randomUUID().replaceAll('-','').slice(0,12),directory=resolve('.local/workflow-archive-qa',nonce),authorityName='idms_workflowcontrol_'+nonce,accounts=[],targets=[],children=[],closed=new Map();
const q=v=>'"'+v.replaceAll('"','""')+'"',pause=ms=>new Promise(ok=>setTimeout(ok,ms));let authority,java,configuration,proof;
const clients=[];let orphanCleanup;
function track(child){children.push(child);closed.set(child,new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal}))));child.on('error',()=>{});child.stdout?.resume();child.stderr?.resume();return child;}
async function stop(child){if(child?.exitCode===null&&child.signalCode===null)child.kill();if(child)await closed.get(child);}
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('WF archive QA timeout '+label)),30000);})]);}finally{clearTimeout(timer);}}
async function port(){const s=createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
function controller(file,hold=''){
 const ch=track(fork('scripts/fixtures/workflow-archive-controller.mjs',[file,hold],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true}));let resolveBarrier,rejectBarrier,resolveResult,seen=false,last='none';const barrier=new Promise((ok,reject)=>{resolveBarrier=ok;rejectBarrier=reject;}),result=new Promise(ok=>{resolveResult=ok;});barrier.catch(()=>{});
 ch.on('message',m=>{if(m.type==='PHASE')last=m.phase;if(m.type==='BARRIER'){seen=true;resolveBarrier(m);}if(m.type==='ERROR'){rejectBarrier(Error(m.code+': '+m.message+' stage='+last));resolveResult(m);}if(m.type==='RESULT')resolveResult(m);});ch.on('close',code=>{if(hold&&!seen)rejectBarrier(Error('Controller exited before '+hold+' code='+code));});return {child:ch,barrier,result};
}
function atBarrier(child,phase){return bounded(new Promise((ok,reject)=>{const receive=m=>{if(m.type==='BARRIER'&&m.phase===phase){child.off('message',receive);ok(m);}if(m.type==='ERROR'){child.off('message',receive);reject(Error(m.message+' '+m.location));}};child.on('message',receive);child.once('close',()=>{child.off('message',receive);reject(Error('Closed before '+phase));});}),phase);}
const jar=resolve('work/workflow-runtime-upgrade-20261018/build-output/idms-workflow-0.1.0.jar'),build=await read('work/workflow-runtime-upgrade-20261018/build-verification.json');assert.equal(createHash('sha256').update(await readFile(jar)).digest('hex'),build.newJarSha256);
try{
 await privateDirectory(directory);const source=await restoreWorkflowQa(main,copy.backups.acme,'acme',suffix);accounts.push(source.account);
 // Keep this disposable fixture quiet; production still rejects every unknown
 // backend, including a maintenance worker. Never terminate those workers here.
 const fixture=new pg.Client({host:main.host,port:main.port,...source.account});await fixture.connect();try{for(const t of (await fixture.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await fixture.query('ALTER TABLE public.'+q(t.tablename)+' SET (autovacuum_enabled=false)');if(activeCopyTest)for(let i=0;i<128;i++)await fixture.query('INSERT INTO public.act_ge_bytearray(id_,rev_,name_,bytes_) VALUES($1,1,$2,$3)',[randomUUID(),'QA native COPY interruption payload',randomBytes(256*1024)]);}finally{await fixture.end();}
 const serviceToken=randomUUID()+randomUUID(),readerToken=randomUUID()+randomUUID(),authorityId=randomUUID(),javaConfig=join(directory,'java.json'),base='http://127.0.0.1:'+await port();
 await privateNewFile(javaConfig,JSON.stringify({tenants:{acme:{jdbcUrl:`jdbc:postgresql://${main.host}:${main.port}/${source.account.database}`,user:source.account.user,password:source.account.password,serviceToken,recoveryReadToken:readerToken,recoveryAuthorityId:authorityId}}}));
 const startJava=()=>java=track(spawn(workflowJava,['-Xms64m','-Xmx384m','-Dfile.encoding=UTF-8','-jar',jar,'--server.address=127.0.0.1','--server.port='+new URL(base).port],{env:{...process.env,IDMS_WORKFLOW_CONFIG:javaConfig},stdio:['ignore','pipe','pipe'],windowsHide:true}));
 const ready=async()=>{for(let i=0;i<200;i++){assert.equal(java.exitCode,null);try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await pause(150);}throw Error('QA Java not ready');};
 const api=async(path,body,token=serviceToken,status=200)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-IDMS-Tenant':'acme',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.equal(r.status,status);return r.json();};
 startJava();await ready();
 for(const state of ['UNASSIGNED','IN_PROGRESS','AWAITING_APPROVAL','CLOSED']){
  const entityId=randomUUID();let view;
  const change=async(action,who,extra={})=>{const b={commandId:randomUUID(),entityId,action,expectedVersion:view?.version??1,actor:{id:who,type:'USER',permissions:[action==='create'?'predictive:approve':action==='approval'?'maintenance:approve':'maintenance:execute']},correlationId:randomUUID(),...extra};view=await api('/v1/commands',{...b,requestDigest:digest(canonical(b))});};
  await change('create','qa-reviewer');if(state!=='UNASSIGNED'){await change('claim','qa-engineer');await change('start','qa-engineer');await change('submit','qa-engineer',{evidenceDigest:'e'.repeat(64)});
   if(state==='IN_PROGRESS'||state==='CLOSED')await change('approval','qa-reviewer',{evidenceDigest:'e'.repeat(64),decision:state==='CLOSED'?'APPROVED':'RETURNED',comment:'independent archive QA'});}
  assert.equal(view.state,state);
 }
 const snapshot=await api('/v1/recovery-state',undefined,readerToken);assert.equal(snapshot.cases.length,4);assert.equal(snapshot.commandCount,15);await stop(java);java=null;
 authority=await createWorkflowFreezeAuthority({host:main.host,port:main.port,bootstrapPassword:main.bootstrapPassword},authorityName);const operationId=randomUUID();
 configuration={format:'idms-workflow-freeze-config-v1',authority,source:{scope:'QA',tenantId:'acme',database:source.account.database,user:source.account.user}};
 const quiet=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:authority.controlDatabase});await quiet.connect();try{for(let i=0;;i++){await quiet.query('SELECT pg_stat_clear_snapshot()');if(!(await quiet.query('SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=$1)',[source.account.database])).rowCount)break;assert.ok(i<200,'Disposable source did not reach real zero-backend state');await pause(25);}}finally{await quiet.end();}
 await runWorkflowFreeze(configuration,operationId,'prepare');await runWorkflowFreeze(configuration,operationId,'freeze');
 const keyFile=join(directory,'key/key.json');await generateWorkflowArchiveKey(keyFile);const settings={config:configuration,operationId,keyFile,workDirectory:join(directory,'normal-work'),outputDirectory:join(directory,'archives')};
 const normal=await createWorkflowArchive(settings);assert.equal(normal.reused,false);assert.equal((await createWorkflowArchive(settings)).reused,true);
 const authWork=join(directory,'auth');await privateDirectory(authWork);const opened=await authenticateWorkflowArchiveV2({backupFile:normal.file,keyFile,tenantId:'acme',workDirectory:authWork});
 let manifest;try{manifest=opened.manifest;assert.equal(manifest.facts.tables.find(t=>t.table==='idms_workflow_cases').rows,4);assert.equal(manifest.facts.tables.find(t=>t.table==='idms_workflow_commands').rows,15);
  const aliasManifest={...manifest,backupId:randomUUID()},stageProof=await sealWorkflowArchive({manifest:aliasManifest,dumpFile:opened.dumpFile,keyFile,stageFile:join(directory,'alias.partial')}),aliasFile=join(directory,'alias.encrypted');
  await link(stageProof.file,aliasFile);await finishWorkflowArchiveLink({stageProof,backupFile:aliasFile});const a=await authenticateWorkflowArchiveV2({backupFile:aliasFile,keyFile,tenantId:'acme',workDirectory:authWork});await a.dispose();
 }finally{await opened.dispose();}
 const bad=join(directory,'tampered.encrypted');await copyFile(normal.file,bad);const f=await open(bad,'r+');try{const b=Buffer.alloc(1);await f.read(b,0,1,80);b[0]^=1;await f.write(b,0,1,80);}finally{await f.close();}
 await assert.rejects(authenticateWorkflowArchiveV2({backupFile:bad,keyFile,tenantId:'acme',workDirectory:authWork}));await assert.rejects(authenticateWorkflowArchiveV2({backupFile:normal.file,keyFile,tenantId:'sandbox',workDirectory:authWork}));
 const wrong=join(directory,'wrong/key.json');await generateWorkflowArchiveKey(wrong);await assert.rejects(authenticateWorkflowArchiveV2({backupFile:normal.file,keyFile:wrong,tenantId:'acme',workDirectory:authWork}));
 const target='idms_workflowrestore_acme_'+nonce;const restored=await restoreWorkflowArchiveV2({authority,backupFile:normal.file,keyFile,tenantId:'acme',targetDatabase:target,credentialFile:join(directory,'target.json'),workDirectory:authWork});targets.push(restored.account);assert.ok(restored.proof.all38TablesAndTwoSequencesMatchAuthenticatedSource);assert.ok(restored.proof.databaseAndSessionContextMatchesAuthenticatedSource);
 const restoreJava=join(directory,'restored-java.json');await privateNewFile(restoreJava,JSON.stringify({tenants:{acme:{jdbcUrl:`jdbc:postgresql://${main.host}:${main.port}/${target}`,user:restored.account.user,password:restored.account.password,serviceToken,recoveryReadToken:readerToken,recoveryAuthorityId:authorityId}}}));
 java=track(spawn(workflowJava,['-Xms64m','-Xmx384m','-Dfile.encoding=UTF-8','-jar',jar,'--server.address=127.0.0.1','--server.port='+new URL(base).port],{env:{...process.env,IDMS_WORKFLOW_CONFIG:restoreJava},stdio:['ignore','pipe','pipe'],windowsHide:true}));await ready();assert.deepEqual(await api('/v1/recovery-state',undefined,readerToken),snapshot);await stop(java);java=null;
 const faultProof=[];for(const phase of ['SNAPSHOT_READY','AUTHENTICATED','BEFORE_PUBLICATION']){
  const job={...settings,workDirectory:join(directory,'fault-'+phase)},file=join(directory,phase+'.json');await privateNewFile(file,JSON.stringify(job));const interrupted=controller(file,phase);await bounded(interrupted.barrier,phase);interrupted.child.kill();await bounded(closed.get(interrupted.child),'killed archive controller');
  const resumed=controller(file),message=await bounded(resumed.result,'archive retry');const ended=await bounded(closed.get(resumed.child),'archive retry close');assert.equal(ended.code,0,phase+': '+message.message+' '+message.location);assert.equal(message.type,'RESULT');assert.equal(message.result.reused,false);
  const verified=await authenticateWorkflowArchiveV2({backupFile:message.result.file,keyFile,tenantId:'acme',workDirectory:authWork});assert.equal(verified.manifest.fence.baselineSha256,manifest.fence.baselineSha256);await verified.dispose();assert.ok(!(await readdir(job.workDirectory)).some(n=>n.startsWith('workflow-auth-')||n.startsWith('field-backup-stage-')));faultProof.push({phase,actualControllerKilledAndClosed:true,sameIntentRetryProducesAuthenticatedArchive:true,ownedAuthenticationPlaintextWorkspaceAbsentAfterRetry:true});
 }
 let nativeRetirementProof=null;
 if(nativeTest){
  const job={...settings,workDirectory:join(directory,'native-retirement')},file=join(directory,'native-retirement.json');await privateNewFile(file,JSON.stringify(job));
  const original=controller(file,'DUMP_FILE_CREATED,DUMP_SPAWNED');await bounded(original.barrier,'pre-native barrier');
  const blocker=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:source.account.database,application_name:'wfarc-qa-lock-blocker'});clients.push(blocker);await blocker.connect();await blocker.query('BEGIN');
  const blocked=blocker.query('LOCK TABLE public.act_ge_bytearray IN ACCESS EXCLUSIVE MODE');blocked.catch(()=>{});
  const watch=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:authority.controlDatabase});clients.push(watch);await watch.connect();
  for(let i=0;;i++){await watch.query('SELECT pg_stat_clear_snapshot()');if((await watch.query("SELECT 1 FROM pg_stat_activity WHERE application_name='wfarc-qa-lock-blocker' AND wait_event_type='Lock'")).rowCount)break;assert.ok(i<100);await pause(10);}
  const spawned=atBarrier(original.child,'DUMP_SPAWNED');original.child.send({type:'CONTINUE'});const native=await spawned;
  // Wait for a real imported-snapshot native backend, then kill before the
  // production 250 ms monitor rejects the deliberately unknown QA blocker.
  const beforeKill=performance.now();for(;;){await watch.query('SELECT pg_stat_clear_snapshot()');if((await watch.query("SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=$1) AND application_name LIKE 'wfarc-d-%' AND wait_event_type='Lock'",[source.account.database])).rowCount)break;assert.ok(performance.now()-beforeKill<200,'Native backend did not reach real lock wait before monitor');await pause(1);}
  original.child.kill();await bounded(closed.get(original.child),'native controller killed');await bounded(blocked,'QA blocker acquired after holder closes');
  await watch.query('SELECT pg_stat_clear_snapshot()');assert.ok((await watch.query("SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=$1) AND application_name LIKE 'wfarc-d-%' AND wait_event_type='Lock'",[source.account.database])).rowCount>0);
  const resumed=controller(file,'PREVIOUS_NATIVE_RETIRED');await bounded(resumed.barrier,'native and backend retirement gate');
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const state=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`if(Get-Process -Id ${native.value.pid} -ErrorAction SilentlyContinue){exit 1}`],{windowsHide:true});assert.equal(state.stderr,'');
  await blocker.query('ROLLBACK');await blocker.end();clients.splice(clients.indexOf(blocker),1);await watch.end();clients.splice(clients.indexOf(watch),1);resumed.child.send({type:'CONTINUE'});
  const result=await bounded(resumed.result,'native retry result');assert.equal((await bounded(closed.get(resumed.child),'native retry close')).code,0,result.message+' '+result.location);assert.equal(result.type,'RESULT');
  const verified=await authenticateWorkflowArchiveV2({backupFile:result.result.file,keyFile,tenantId:'acme',workDirectory:authWork});await verified.dispose();
  // The normal Windows attached child can die with its controller while its PG
  // lock-wait backend still lives. Separately prove the real orphan Stop path.
  const primitive=join(directory,'orphan-primitive');await privateDirectory(primitive);const primitiveId=randomUUID(),program=await workflowDumpProgram(),holder=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:source.account.database,options:'-c default_transaction_read_only=on'});clients.push(holder);await holder.connect();await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const snapshotId=(await holder.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const lock=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:source.account.database});clients.push(lock);await lock.connect();await lock.query('BEGIN');await lock.query('LOCK TABLE public.act_ge_bytearray IN ACCESS EXCLUSIVE MODE');
  const dumpFile=join(primitive,'dump.pgdump'),toolFile=join(primitive,'workflow-'+randomUUID()+'-tool-'+primitiveId+'.json'),tool={format:'idms-workflow-archive-tool-v2',runId:primitiveId,program:program.file,programSha256:program.sha256,dumpFile,snapshot:snapshotId,applicationName:'wfarc-d-'+primitiveId.replaceAll('-',''),args:['--format=custom','--no-owner','--no-acl','--no-password','--strict-names','--schema=public','--snapshot='+snapshotId,'--file='+dumpFile,'--lock-wait-timeout=30s']},spec=join(primitive,'private.json');await privateNewFile(spec,JSON.stringify({tool,toolFile,authority,database:source.account.database}));
  const ownerProcess=track(fork('scripts/fixtures/workflow-archive-native-owner.mjs',[spec],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true})),started=await atBarrier(ownerProcess,'NATIVE_STARTED'),watch2=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:authority.controlDatabase});clients.push(watch2);await watch2.connect();
  const currentOwner=await workflowArchiveOwner();orphanCleanup={tool:await read(toolFile),file:toolFile,owner:currentOwner};
  for(let i=0;;i++){await watch2.query('SELECT pg_stat_clear_snapshot()');if((await watch2.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[tool.applicationName])).rowCount)break;assert.ok(i<200);await pause(5);}
  ownerProcess.kill();await bounded(closed.get(ownerProcess),'detached native owner actual close');
  const retired=await retireWorkflowNative(orphanCleanup.tool,toolFile,currentOwner);assert.ok(retired.observed.some(p=>p.pid===started.value.pid&&p.kind==='dump'&&p.action==='Stop'),'Real surviving orphan Stop branch was not exercised');
  await lock.query('ROLLBACK');await lock.end();clients.splice(clients.indexOf(lock),1);await holder.query('ROLLBACK');await holder.end();clients.splice(clients.indexOf(holder),1);
  for(let i=0;;i++){await watch2.query('SELECT pg_stat_clear_snapshot()');if(!(await watch2.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1',[tool.applicationName])).rowCount)break;assert.ok(i<200);await pause(10);}await watch2.end();clients.splice(clients.indexOf(watch2),1);orphanCleanup=null;
  nativeRetirementProof={actualControllerKilledDuringLiveNativeDump:true,actualDumpWasBlockedInLockNotCopy:true,actualOldNativePidTerminalBeforeRetryContinues:true,authenticatedArchiveAfterOwnedNativeRetirement:true,unknownQaBlockerClosedBeforePublicFenceStatus:true,separateDetachedQaOwnerKilledAndClosed:true,survivingRealOrphanExactStopBranchExercised:true,orphanNativeAndPgBackendActuallyTerminal:true,productionDumpDetached:false};
 }
 let activeCopyProof=null;
 if(activeCopyTest){
  const job={...settings,workDirectory:join(directory,'active-copy')},file=join(directory,'active-copy.json');await privateNewFile(file,JSON.stringify(job));const interrupted=controller(file,'DUMP_SPAWNED');await bounded(interrupted.barrier,'active COPY native spawned');
  const planName=(await readdir(job.workDirectory)).find(n=>/^workflow-run-[a-f0-9-]{36}\.json$/.test(n)),plan=await read(join(job.workDirectory,planName));
  const watch=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:authority.controlDatabase});clients.push(watch);await watch.connect();let row;
  for(let i=0;;i++){await watch.query('SELECT pg_stat_clear_snapshot()');row=(await watch.query("SELECT pid,state,query FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=$1) AND application_name=$2 AND state='active' AND query LIKE 'COPY public.act_ge_bytearray %'",[source.account.database,plan.dumpName])).rows[0];if(row)break;assert.ok(i<300,'Did not observe real native COPY');await pause(5);}
  interrupted.child.kill();await bounded(closed.get(interrupted.child),'actual COPY controller close');await watch.end();clients.splice(clients.indexOf(watch),1);
  const resumed=controller(file),message=await bounded(resumed.result,'active COPY same-intent retry');assert.equal((await bounded(closed.get(resumed.child),'active COPY retry close')).code,0,message.message+' '+message.location);assert.equal(message.type,'RESULT');
  const verified=await authenticateWorkflowArchiveV2({backupFile:message.result.file,keyFile,tenantId:'acme',workDirectory:authWork});assert.equal(verified.manifest.facts.tables.find(t=>t.table==='act_ge_bytearray').sha256,manifest.facts.tables.find(t=>t.table==='act_ge_bytearray').sha256);await verified.dispose();
  activeCopyProof={actualNativeCopyObservedOnBytearrayTable:true,actualControllerKilledAndClosedDuringCopy:true,freshSameIntentRetryAuthenticatedAllFactsMatch:true,opaqueQaPayloadBytes:32*1024*1024,capacityOrSlaClaim:false};
 }
 assert.equal((await runWorkflowFreeze(configuration,operationId,'status')).phase,'DRAINED');
 await runWorkflowFreeze(configuration,operationId,'release');
 proof={verifiedAt:new Date().toISOString(),actualNonemptyFlowableFourCasesFifteenCommands:true,sourcePersistentDRAINEDFenceBound:true,actualReadonlySameSnapshotPgDump16:true,all38TablesAndTwoSequencesMatchAfterAuthenticatedIsolatedRestore:true,
  databaseAndSessionContextMatchesAuthenticatedSource:true,fullNonemptyRecoverySnapshotMatchesAfterRestoredJavaStarts:true,completedArchiveReplayReusesCiphertext:true,tamperWrongKeyAndTenantRejected:true,actualTwoAliasPublicationCrashShapeRecovered:true,controllerFaults:faultProof,
  activeNativeCopyInterruptionTested:!!activeCopyProof,activeCopyProof,nativeOrphanProcessPositiveRetirementTested:!!nativeRetirementProof,nativeRetirementProof,restoreIsKernelNotCrashResumer:true,originalWorkflowFencedOrStopped:false,productionAcceptance:false};
}finally{
 await stop(java);for(const c of children)await stop(c);
 if(orphanCleanup)await retireWorkflowNative(orphanCleanup.tool,orphanCleanup.file,orphanCleanup.owner);
 for(const c of clients){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}
 const admin=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres'});await admin.connect();try{for(const a of targets){assert.match(a.database,new RegExp('^idms_workflowrestore_acme_'+nonce+'$'));await admin.query('DROP DATABASE '+q(a.database)+' WITH (FORCE)');await admin.query('DROP ROLE '+q(a.user));}}finally{await admin.end();}
 await cleanupWorkflowQa(main,accounts,suffix);
 if(authority){const c=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres'});await c.connect();try{assert.equal(authority.controlDatabase,authorityName);await c.query('DROP DATABASE '+q(authorityName)+' WITH (FORCE)');await c.query('DROP ROLE '+q(authorityName+'_owner'));}finally{await c.end();}}
 assert.equal(dirname(directory),resolve('.local/workflow-archive-qa'));await rm(directory,{recursive:true,force:true});
}
assert.ok(proof);proof.allOwnedProcessesDatabasesRolesAndPrivateFilesRemoved=true;await privateNewFile(outputFile,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
