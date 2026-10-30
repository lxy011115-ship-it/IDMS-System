import pg from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {canonical} from '../server/imports.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory,backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {workflowRequire as need,workflowSha,workflowQuote as q,workflowArchiveFacts,workflowArchiveContext} from './workflow-archive-facts.mjs';
import {workflowArchiveUuid} from './workflow-archive-format.mjs';
import {workflowArchiveKeyBinding,hashWorkflowArchiveFile} from './workflow-archive-container.mjs';
import {authenticateManagedWorkflowArchive} from './workflow-archive-workspace.mjs';
import {workflowArchiveOwner,workflowArchiveOwnerState} from './workflow-archive-native.mjs';
import {applyFieldFactSession} from './field-fact-session.mjs';
import {fieldDatabaseCreateOptions} from './field-capture-context.mjs';
import {WorkflowRestoreRegistry,restoreConnection,restoreRoleFrame,restoreDatabaseFrame,requireRestoreDatabase} from './workflow-restore-registry.mjs';
import {workflowRestoreProgram,workflowRestoreArgs,runWorkflowRestoreNative,retireWorkflowRestoreNative} from './workflow-restore-native.mjs';
import {retireWorkflowRestorePlaintext} from './workflow-restore-workspace.mjs';
async function jsonFile(file,max=131072){const f=await backupRegular(file,max);try{const raw=(await readExactly(f.file,Number(f.stat.size),0)).toString('utf8'),value=JSON.parse(raw);need(canonical(value)===raw,'WF_RESTORE_PRIVATE_FILE');await backupUnchanged(f);return value;}finally{await f.file.close();}}
async function optional(file){try{return await jsonFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const readerNames=run=>[run.nativeName,run.setupName,run.verifyName];
function requireSessions(rows,allowed){if(!allowed)throw Object.assign(Error('WF_RESTORE_UNKNOWN_SESSION '+JSON.stringify(rows.map(r=>({pid:r.pid,type:r.backend_type,application:r.application_name})))),{code:'WF_RESTORE_UNKNOWN_SESSION'});}
async function targetSessions(store,oid){await store.client.query('SELECT pg_stat_clear_snapshot()');return (await store.client.query(`SELECT pid,to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,datid::text,usesysid::text,application_name,backend_type FROM pg_stat_activity WHERE datid=$1::oid ORDER BY pid`,[oid])).rows;}
async function settledSessions(store,oid){
 // Maintenance never counts as an allowed reader and is never terminated.
 // Wait for its real exit; a persistent worker still fails the zero-session gate.
 for(let i=0;;i++){await store.lease();const rows=await targetSessions(store,oid);if(!rows.some(r=>r.backend_type==='autovacuum worker'))return rows;need(i<200,'WF_RESTORE_UNKNOWN_SESSION');await pause(25);}
}
async function waitAbsent(store,oid,name){for(let i=0;;i++){if(!(await targetSessions(store,oid)).some(r=>r.application_name===name))return;need(i<600,'WF_RESTORE_BACKEND_NOT_TERMINAL');await pause(25);}}
async function requireCatalog(store,manifest,{initial=false}={}){
 await store.lease();const state=store.state,c=store.client,role=await restoreRoleFrame(c,store.target);need(role&&canonical(role)===canonical(state.role),'WF_RESTORE_ROLE_DRIFT');
 const db=await restoreDatabaseFrame(c,store.target);if(db){requireRestoreDatabase(db,store.target,role,manifest.context.database,{initial});need((await c.query('SELECT oid::text FROM pg_database WHERE datdba=$1::oid',[role.oid])).rows.every(r=>r.oid===db.oid),'WF_RESTORE_SHARED_OWNER');if(state.database)need(canonical(db)===canonical(state.database),'WF_RESTORE_DATABASE_DRIFT');}
 else{need(!state.database||state.phase==='RESETTING','WF_RESTORE_DATABASE_MISSING');need((await c.query('SELECT 1 FROM pg_database WHERE datdba=$1::oid',[role.oid])).rowCount===0,'WF_RESTORE_SHARED_OWNER');}return db;
}
async function retireBackends(store,db,run){
 const c=store.client,operator=(await c.query('SELECT oid::text FROM pg_roles WHERE rolname=current_user')).rows[0].oid,rows=await settledSessions(store,db.oid);requireSessions(rows,rows.every(r=>r.usesysid===operator&&run&&readerNames(run).includes(r.application_name)));
 for(const r of rows){await c.query('SELECT pg_stat_clear_snapshot()');await c.query('SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datid=$3::oid AND usesysid=$4::oid AND application_name=$5',[r.pid,r.backend_start,r.datid,r.usesysid,r.application_name]);for(let i=0;;i++){await c.query('SELECT pg_stat_clear_snapshot()');if(!(await c.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[r.pid,r.backend_start])).rowCount)break;need(i<600,'WF_RESTORE_BACKEND_NOT_TERMINAL');await pause(25);}}
 need((await settledSessions(store,db.oid)).length===0,'WF_RESTORE_UNKNOWN_SESSION');
}
async function targetClient(store,applicationName,task){
 const c=new pg.Client(restoreConnection(store.authority,store.target,applicationName));c.on('error',()=>{});let connected=false;
 try{await c.connect();connected=true;return await task(c);}finally{if(connected)await c.end();else await c.end().catch(()=>{});await waitAbsent(store,store.state.database.oid,applicationName);}
}
async function verifyRestored(store,manifest,run){
 await requireCatalog(store,manifest);const before=await settledSessions(store,store.state.database.oid);requireSessions(before,before.length===0);
 await targetClient(store,run.verifyName,async c=>{await applyFieldFactSession(c,manifest.context.session);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');need(canonical(await workflowArchiveContext(c,store.target))===canonical(manifest.context),'WF_RESTORE_CONTEXT');need(canonical(await workflowArchiveFacts(c))===canonical(manifest.facts),'WF_RESTORE_FACTS');});
 await requireCatalog(store,manifest);const after=await settledSessions(store,store.state.database.oid);requireSessions(after,after.length===0);await requireCatalog(store,manifest);
}
// Explicit isolated recovery, not business activation. Every target remains NOLOGIN/connlimit 0.
export async function resumeWorkflowRestore({authority,operationId,backupFile,keyFile,tenantId,targetDatabase,credentialFile,workDirectory,signal,onPhase=async()=>{}}){
 need(workflowArchiveUuid(operationId)&&['acme','sandbox'].includes(tenantId)&&new RegExp('^idms_workflowrestore_'+tenantId+'_[a-f0-9]{12}$').test(targetDatabase),'WF_RESTORE_INPUT');
 await privateDirectory(workDirectory);const root=await backupDirectory(workDirectory),owner=await workflowArchiveOwner(),keyBinding=await workflowArchiveKeyBinding(keyFile),input=await backupRegular(backupFile,8*1024**3+2*1024**2);let opened,store;
 try{
  opened=await authenticateManagedWorkflowArchive({backupFile,keyFile,tenantId,workDirectory:root,signal},owner,async phase=>onPhase('RESTORE_'+phase,{}));await backupUnchanged(input);
  const archiveHash=await hashWorkflowArchiveFile(backupFile);await backupUnchanged(input);const current=await backupRegular(backupFile,8*1024**3+2*1024**2);try{need(current.stat.dev===input.stat.dev&&current.stat.ino===input.stat.ino&&current.stat.mtimeNs===input.stat.mtimeNs&&current.stat.size===input.stat.size,'WF_RESTORE_INPUT_CHANGED');}finally{await current.file.close();}
  need(canonical(await workflowArchiveKeyBinding(keyFile))===canonical(keyBinding),'WF_RESTORE_KEY_CHANGED');const manifest=opened.manifest;need(manifest.source.database!==targetDatabase,'WF_RESTORE_INPUT');
  const request={format:'idms-workflow-restore-request-v1',operationId,tenantId,targetDatabase,credentialFile:resolve(credentialFile),workDirectory:root,backupFile:resolve(backupFile),archive:archiveHash,keyBinding,manifestSha256:workflowSha(manifest),authority:{host:authority.host,port:authority.port,controlDatabase:authority.controlDatabase,systemIdentifier:authority.systemIdentifier}};
  const bindingFile=join(root,'workflow-restore-binding.json'),binding=await optional(bindingFile);if(binding)need(canonical(binding)===canonical(request),'WF_RESTORE_REQUEST_CHANGED');else{
   // A root without our binding cannot contain any old native intent. Only
   // authentication workspaces can precede binding; they have no native reader.
   need((await readdir(root)).every(n=>/^workflow-auth-[a-f0-9-]{36}\.json$/.test(n)||/^field-backup-stage-[A-Za-z0-9]{6}$/.test(n)),'WF_RESTORE_WORK_ROOT_NOT_EXCLUSIVE');await privateNewFile(bindingFile,canonical(request));
  }
  store=new WorkflowRestoreRegistry(authority,targetDatabase);await store.connect();await store.load(operationId,request);const oldRun=store.state.run;
  if(oldRun){const same=oldRun.owner.pid===owner.pid&&oldRun.owner.startTicks===owner.startTicks&&oldRun.owner.hostId===owner.hostId;need(same&&oldRun.quiescent||await workflowArchiveOwnerState(oldRun.owner)==='TERMINAL','WF_RESTORE_OWNER_LIVE');}
  if(store.state.role)await requireCatalog(store,manifest,{initial:store.state.phase==='DB_CREATING'});
  if(oldRun?.nativeFile){const tool=await jsonFile(oldRun.nativeFile);need(workflowSha(tool)===oldRun.nativeSha256&&tool.operationId===operationId&&tool.targetDatabase===targetDatabase&&tool.runId===oldRun.runId&&canonical(tool.owner)===canonical(oldRun.owner),'WF_RESTORE_TOOL_CHANGED');const retired=await retireWorkflowRestoreNative(tool,oldRun.nativeFile,owner);await onPhase('PREVIOUS_RESTORE_NATIVE_RETIRED',retired);}
  if(store.state.role){const db=await requireCatalog(store,manifest,{initial:store.state.phase==='DB_CREATING'});if(db)await retireBackends(store,db,oldRun);}
  await retireWorkflowRestorePlaintext(root,owner);
  const runId=randomUUID(),run={runId,owner,quiescent:false,nativeName:'wfres-r-'+runId.replaceAll('-',''),setupName:'wfres-c-'+runId.replaceAll('-',''),verifyName:'wfres-v-'+runId.replaceAll('-',''),nativeFile:null,nativeSha256:null};
  let credentials=await optional(request.credentialFile);
  if(!credentials){need(store.state.phase==='INTENT'&&!store.state.credentialSha256,'WF_RESTORE_CREDENTIALS_MISSING');credentials={format:'idms-workflow-restore-credentials-v1',operationId,tenantId,targetDatabase,backupId:manifest.backupId,requestSha256:store.requestSha,password:randomBytes(32).toString('base64url')};await privateNewFile(request.credentialFile,canonical(credentials));}
  need(credentials.format==='idms-workflow-restore-credentials-v1'&&credentials.operationId===operationId&&credentials.tenantId===tenantId&&credentials.targetDatabase===targetDatabase&&credentials.backupId===manifest.backupId&&credentials.requestSha256===store.requestSha&&typeof credentials.password==='string'&&/^[A-Za-z0-9_-]{43}$/.test(credentials.password),'WF_RESTORE_CREDENTIALS_CHANGED');
  const credentialSha256=workflowSha(credentials);need(!store.state.credentialSha256||store.state.credentialSha256===credentialSha256,'WF_RESTORE_CREDENTIALS_CHANGED');
  if(store.state.phase==='VERIFIED'){
   await store.save({...store.state,run});await verifyRestored(store,manifest,run);await store.save({...store.state,run:{...run,quiescent:true}});await onPhase('RESTORE_REPLAY_VERIFIED',{});return {format:'idms-workflow-resume-result-v1',operationId,targetDatabase,credentialFile:request.credentialFile,reused:true,...store.state.proof};
  }
  await store.save({...store.state,credentialSha256,run});await onPhase('RESTORE_INTENT',{});
  if(store.state.phase==='INTENT'){
   await store.transaction(async()=>{
    need((await store.client.query('SELECT 1 FROM pg_roles WHERE rolname=$1 UNION ALL SELECT 1 FROM pg_database WHERE datname=$1',[targetDatabase])).rowCount===0,'WF_RESTORE_TARGET_EXISTS');
    await store.client.query('CREATE ROLE '+q(targetDatabase)+" NOLOGIN PASSWORD '"+credentials.password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 0");
    const role=await restoreRoleFrame(store.client,targetDatabase);await store.save({...store.state,phase:'ROLE_CREATED',role});await onPhase('RESTORE_ROLE_BEFORE_COMMIT',{});
   });await onPhase('RESTORE_ROLE_CREATED',{});
  }
  let db=await requireCatalog(store,manifest,{initial:store.state.phase==='DB_CREATING'});
  if(['RESTORING','RESTORED','RESETTING'].includes(store.state.phase)){
   if(store.state.phase!=='RESETTING')await store.save({...store.state,phase:'RESETTING'});await onPhase('RESTORE_RESETTING',{});
   if(db){await requireCatalog(store,manifest);need((await targetSessions(store,db.oid)).length===0,'WF_RESTORE_UNKNOWN_SESSION');await store.client.query('DROP DATABASE '+q(targetDatabase));await onPhase('RESTORE_OLD_DATABASE_DROPPED',{});}
   await store.save({...store.state,phase:'DB_CREATING',database:null});db=null;
  }
  if(store.state.phase==='ROLE_CREATED'){need(!db,'WF_RESTORE_UNOWNED_DATABASE');await store.save({...store.state,phase:'DB_CREATING'});}
  if(store.state.phase==='DB_CREATING'){
   db=await requireCatalog(store,manifest,{initial:true});if(!db){await onPhase('RESTORE_DATABASE_BEFORE_CREATE',{});await store.client.query('CREATE DATABASE '+q(targetDatabase)+' OWNER '+q(targetDatabase)+' TEMPLATE template0 CONNECTION LIMIT 0 '+fieldDatabaseCreateOptions(manifest.context.database));await onPhase('RESTORE_DATABASE_CREATED_BEFORE_RECORD',{});db=await requireCatalog(store,manifest,{initial:true});}
   need(db,'WF_RESTORE_DATABASE_MISSING');need((await targetSessions(store,db.oid)).length===0,'WF_RESTORE_UNKNOWN_SESSION');await store.client.query('REVOKE ALL ON DATABASE '+q(targetDatabase)+' FROM PUBLIC');db=await requireCatalog(store,manifest);await store.save({...store.state,phase:'DB_READY',database:db});await onPhase('RESTORE_DATABASE_READY',{});
  }
  need(store.state.phase==='DB_READY','WF_RESTORE_PHASE');await requireCatalog(store,manifest);await store.save({...store.state,phase:'RESTORING'});
  await targetClient(store,run.setupName,async c=>{await c.query('SET ROLE '+q(targetDatabase));await c.query('DROP SCHEMA public');});
  const program=await workflowRestoreProgram(),tool={format:'idms-workflow-restore-tool-v1',operationId,runId,owner,targetDatabase,databaseOid:store.state.database.oid,program:program.file,programSha256:program.sha256,dumpFile:opened.dumpFile,dumpSha256:manifest.dump.sha256,applicationName:run.nativeName,args:workflowRestoreArgs(targetDatabase,opened.dumpFile)},nativeFile=join(root,'workflow-restore-'+operationId+'-tool-'+runId+'.json');
  await privateNewFile(nativeFile,canonical(tool));await store.save({...store.state,run:{...run,nativeFile,nativeSha256:workflowSha(tool)}});await onPhase('RESTORE_NATIVE_PREPARED',{});let nativeIdentity;
  const check=async()=>{await requireCatalog(store,manifest);need((await store.client.query('SELECT state_sha256 FROM public.workflow_restore_jobs WHERE operation_id=$1',[operationId])).rows[0]?.state_sha256===store.stateSha,'WF_RESTORE_STATE_DRIFT');const all=await targetSessions(store,store.state.database.oid),operator=(await store.client.query('SELECT oid::text FROM pg_roles WHERE rolname=current_user')).rows[0].oid;need(all.length<=1&&all.every(r=>r.application_name===run.nativeName&&r.usesysid===operator),'WF_RESTORE_UNKNOWN_SESSION');if(all.length){if(nativeIdentity)need(canonical(all[0])===canonical(nativeIdentity),'WF_RESTORE_NATIVE_BACKEND_DRIFT');else nativeIdentity=all[0];}};
  await runWorkflowRestoreNative(tool,{authority,check,signal,onPhase});await waitAbsent(store,store.state.database.oid,run.nativeName);await store.save({...store.state,phase:'RESTORED'});await verifyRestored(store,manifest,run);
  const proof={verifiedAt:new Date().toISOString(),backupId:manifest.backupId,tenantId,all38TablesTwoSequencesAndContextMatch:true,targetRoleRemainsNOLOGIN:true,targetDatabaseConnectionLimitZero:true,sourceConnectionRequired:false,automaticActivationApproved:false,productionAcceptance:false};
  await store.transaction(async()=>{await store.save({...store.state,phase:'VERIFIED',run:{...store.state.run,quiescent:true},proof});await onPhase('RESTORE_VERIFIED_BEFORE_COMMIT',{});});await onPhase('RESTORE_VERIFIED',{});
  return {format:'idms-workflow-resume-result-v1',operationId,targetDatabase,credentialFile:request.credentialFile,reused:false,...proof};
 }finally{await input.file.close();await store?.close();await opened?.dispose();}
}
