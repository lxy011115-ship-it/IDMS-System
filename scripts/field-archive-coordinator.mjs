import {captureFieldContext} from './field-capture-context.mjs';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {lstat,open} from 'node:fs/promises';
import {canonical} from '../server/imports.ts';
import {connectionFor} from '../server/postgres-security.ts';
import {readEntities} from '../server/entity-repository.ts';
import {memoryTask} from '../server/capacity.ts';
import {sourceMigrationIdentity,sourceSecurityFrame,readFrozenSourceFacts} from './field-source-freeze-security.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {freezeFieldSource,sourceFreezePhaseAudits,closeSourceConnection} from './field-source-freeze.mjs';
import {archiveDumpProgram,retireArchiveTool,removeOwnedArchiveDump,runArchiveDump} from './field-archive-command.mjs';
import {fieldBackupKeyBinding,hashFieldBackupFile,stageFieldBackup,authenticateFieldBackup} from './field-backup-archive.mjs';
import {fieldBackupManifest,backupError} from './field-backup-manifest.mjs';
import {backupDirectory,backupCheckSignal} from './field-backup-io.mjs';

const fail=code=>{throw backupError(code);},same=(a,b)=>canonical(a)===canonical(b);
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function backupAccount(config,runtime,tenant){
 const a=runtime.tenants[tenant],b=config?.tenants?.[tenant];
 if(config?.format!==1||config.purpose!=='BUSINESS_BACKUP'||config.host!==runtime.host||config.port!==runtime.port||!b||b.database!==a.database||b.user!==a.backupRole||typeof b.password!=='string'||!b.password.length)fail('FIELD_ARCHIVE_BACKUP_BINDING_INVALID');
 return b;
}

// The caller holds the recovery authority and local operation locks throughout.
// No source transaction in this coordinator is ever committed.
export async function archiveFrozenFieldSource({authority,rawRuntime:runtime,migration,tenantId,guard,files,backupConfig,keyFile,outputDirectory,signal}){
 const a=runtime.tenants[tenantId],account=backupAccount(backupConfig,runtime,tenantId),migrator=sourceMigrationIdentity(migration,runtime,tenantId);
 const root=await backupDirectory(outputDirectory),directoryHash=sourceFreezeSha(process.platform==='win32'?root.toLowerCase():root),key=await fieldBackupKeyBinding(keyFile);
 const restore=await files.assertRestoring(),freeze=await files.readSourceFreezeIntent(),frozen=await files.readSourceFreezeResult();
 if(!freeze||!frozen)fail('FIELD_ARCHIVE_FROZEN_SOURCE_REQUIRED');
 let state=await files.readArchiveState(),tools=await files.listArchiveTools();
 if(state.intent&&(state.intent.outputDirectorySha256!==directoryHash||state.intent.keyId!==key.keyId||state.intent.keySha256!==key.keySha256))fail('FIELD_ARCHIVE_DESTINATION_OR_KEY_CHANGED');
 const check=async()=>{backupCheckSignal(signal);await guard.assertHeld();await files.assertRestoring();};
 await check();
 for(const tool of tools)await retireArchiveTool(tool,files.archiveToolFile(tool.runId),guard);
 const op=restore.operationId,names={snapshot:'idms-arc-snapshot-'+op,reader:'idms-arc-reader-'+op};
 const observer=new pg.Client({...connectionFor(authority,{database:'postgres',user:'idms_bootstrap',password:authority.bootstrapPassword}),application_name:'idms-arc-observer-'+op});
 let snapshot,reader,observerConnected=false,lost=false;
 observer.on('error',()=>{lost=true;});
 try{
  await observer.connect();observerConnected=true;
  const authorityId=sourceFreezeSha('postgres:'+(await observer.query('SELECT system_identifier::text AS system FROM pg_control_system()')).rows[0].system);
  if(authorityId!==guard.authorityId||authorityId!==freeze.authorityId)fail('FIELD_ARCHIVE_AUTHORITY_CHANGED');
  if(!(await observer.query('SELECT 1 FROM pg_database WHERE datname=$1 AND oid=$2::oid',[freeze.database.name,freeze.database.oid])).rowCount)fail('FIELD_ARCHIVE_SOURCE_BINDING_CHANGED');
  for(const role of Object.values(freeze.roles))if(!(await observer.query('SELECT 1 FROM pg_roles WHERE rolname=$1 AND oid=$2::oid',[role.name,role.oid])).rowCount)fail('FIELD_ARCHIVE_SOURCE_BINDING_CHANGED');
  // An old process may have died between spawning pg_dump and recording its PID.
  // Durable unique argv records identify native processes; these exact tags and
  // source role/database OIDs identify their remaining server connections.
  const oldTags=[names.snapshot,names.reader,...tools.map(t=>t.applicationName)];
  for(;;){
   await check();
   const old=(await observer.query("SELECT pid,backend_start::text,usesysid::text,application_name FROM pg_stat_activity WHERE datid=$1::oid AND application_name=ANY($2::text[])",[freeze.database.oid,oldTags])).rows;
   if(!old.length)break;
   for(const s of old){
    const role=s.application_name===names.snapshot?'idms_bootstrap':freeze.roles.backup.name;
    if(!(await observer.query('SELECT 1 FROM pg_roles WHERE oid=$1::oid AND rolname=$2',[s.usesysid,role])).rowCount)fail('FIELD_ARCHIVE_OLD_SESSION_BINDING_INVALID');
    await observer.query('SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND usesysid=$3::oid AND datid=$4::oid AND application_name=$5',[s.pid,s.backend_start,s.usesysid,freeze.database.oid,s.application_name]);
   }
   await sleep(25);
  }
  await freezeFieldSource({authority,rawRuntime:runtime,migration,tenantId,guard,files,resumeOnly:true});
  snapshot=new pg.Client({...connectionFor(authority,{database:a.database,user:'idms_bootstrap',password:authority.bootstrapPassword}),application_name:names.snapshot});
  reader=new pg.Client({...connectionFor(backupConfig,account),application_name:names.reader});
  for(const c of [snapshot,reader])c.on('error',()=>{lost=true;});
  await snapshot.connect();await reader.connect();
  async function sourceCheck(allowedDump){
   await check();if(lost)fail('FIELD_ARCHIVE_SOURCE_CONNECTION_LOST');
   const wanted={database:freeze.database,roles:freeze.roles,policySha256:freeze.policySha256};
   if(!same(await sourceSecurityFrame(snapshot,a,migrator,'FROZEN'),wanted))fail('FIELD_ARCHIVE_SOURCE_BINDING_CHANGED');
   const allowed=[snapshot.processID,reader.processID];
   const unknown=(await observer.query('SELECT pid,usesysid::text,application_name FROM pg_stat_activity WHERE datid=$1::oid AND pid<>ALL($2::int[])',[freeze.database.oid,allowed])).rows;
   if(unknown.some(s=>!allowedDump||s.application_name!==allowedDump.applicationName||s.usesysid!==freeze.roles.backup.oid))fail('FIELD_ARCHIVE_SOURCE_OTHER_SESSION');
  }
  async function capture(){
   await sourceCheck();
   await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   try{
    if((await snapshot.query("SELECT 1 FROM pg_extension WHERE extname<>'plpgsql' UNION ALL SELECT 1 FROM pg_subscription UNION ALL SELECT 1 FROM pg_publication UNION ALL SELECT 1 FROM pg_foreign_server UNION ALL SELECT 1 FROM pg_foreign_data_wrapper UNION ALL SELECT 1 FROM pg_largeobject_metadata UNION ALL SELECT 1 FROM pg_event_trigger UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='idms_field' UNION ALL SELECT 1 FROM pg_replication_slots WHERE database=current_database() UNION ALL SELECT 1 FROM pg_prepared_xacts WHERE database=current_database() LIMIT 1")).rowCount)fail('FIELD_ARCHIVE_DATABASE_GLOBALS_UNSUPPORTED');
    const exported=(await snapshot.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    if(!/^[a-fA-F0-9-]{1,64}$/.test(exported))fail('FIELD_ARCHIVE_SNAPSHOT_INVALID');
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+exported+"'");
    const captureContext=await captureFieldContext(snapshot,a.database),facts=await readFrozenSourceFacts(snapshot,a,migrator,tenantId,{sequenceClient:reader});
    const loaded=await memoryTask(()=>readEntities(snapshot,tenantId),true),phase=sourceFreezePhaseAudits(loaded.payload,tenantId,restore,freeze);
    const begin=loaded.payload.audits.find(e=>e.eventId===restoreBeginEvent(loaded.payload.audits));
    if(!phase.confirmed||phase.confirmed.eventId!==frozen.auditEventId||facts.auditHead!==phase.confirmed.hash)fail('FIELD_ARCHIVE_FREEZE_AUDIT_CHANGED');
    return {facts,captureContext,exported,sourceProof:{format:'idms-field-backup-source-proof-v1',recoveryIntent:restore,freezeIntent:freeze,freezeResult:frozen,beginAudit:begin,requestedAudit:phase.requested,confirmedAudit:phase.confirmed}};
   }catch(e){await reader.query('ROLLBACK').catch(()=>{});await snapshot.query('ROLLBACK').catch(()=>{});throw e;}
  }
  function restoreBeginEvent(audits){return audits.find(e=>e.objectType==='FIELD_RECOVERY_CONTROL'&&e.action==='FIELD_RECOVERY_BEGUN'&&e.correlationId===op)?.eventId;}
  async function rollback(){await reader.query('ROLLBACK');await snapshot.query('ROLLBACK');}
  let captured=await capture();
  if(state.intent&&(state.intent.factsSha256!==captured.facts.factsSha256||state.intent.captureContextSha256&&state.intent.captureContextSha256!==sourceFreezeSha(captured.captureContext)))fail('FIELD_ARCHIVE_SOURCE_FACTS_CHANGED');
  if(!state.intent){
   await check();await files.recordArchiveIntent({format:'idms-field-archive-intent-v2',captureContextSha256:sourceFreezeSha(captured.captureContext),operationId:op,backupId:randomUUID(),freezeIntentSha256:sourceFreezeSha(freeze),freezeAuditEventId:frozen.auditEventId,factsSha256:captured.facts.factsSha256,...key,outputDirectorySha256:directoryHash,createdAt:new Date().toISOString()});
   state=await files.readArchiveState();
  }
  const intent=state.intent,final=join(root,tenantId+'-'+intent.backupId+'.idmsfieldbackup'),partial=join(root,'.'+tenantId+'-'+intent.backupId+'.idmsfieldpartial');
  async function freshFacts(){
   await rollback();captured=await capture();
   if(captured.facts.factsSha256!==intent.factsSha256||intent.captureContextSha256&&intent.captureContextSha256!==sourceFreezeSha(captured.captureContext))fail('FIELD_ARCHIVE_SOURCE_FACTS_CHANGED');
   await check();
  }
  async function verifyArchive(path,ready){
   const image=await hashFieldBackupFile(path);
   if(image.sha256!==ready.archiveSha256||image.bytes!==ready.encryptedBytes)fail('FIELD_ARCHIVE_CIPHERTEXT_CHANGED');
   const opened=await authenticateFieldBackup({backupFile:path,keyFile,tenantId,workDirectory:root,signal});
   try{const m=opened.manifest;if(!['idms-field-full-backup-v2','idms-field-full-backup-v3'].includes(m.format)||intent.captureContextSha256&&(m.format!=='idms-field-full-backup-v3'||sourceFreezeSha(m.captureContext)!==intent.captureContextSha256)||m.backupId!==intent.backupId||m.operationId!==op||m.facts.factsSha256!==intent.factsSha256||sourceFreezeSha(m)!==ready.manifestSha256||!same(m.dump,ready.dump)||m.intentDigest!==files.intentDigest||!same(m.sourceProof.recoveryIntent,restore)||!same(m.sourceProof.freezeIntent,freeze)||!same(m.sourceProof.freezeResult,frozen))fail('FIELD_ARCHIVE_MANIFEST_CHANGED');}finally{await opened.dispose();}
   await check();
  }
  if(!state.ready){
   if(await exists(final))fail('FIELD_ARCHIVE_UNOWNED_DESTINATION');
   for(const tool of tools)await removeOwnedArchiveDump(tool,files);
   if(tools.length>=32)fail('FIELD_ARCHIVE_TOOL_LIMIT');
   const runId=randomUUID(),program=await archiveDumpProgram(),dumpFile=files.archiveDumpFile(runId);
   const tool={format:'idms-field-archive-tool-v1',operationId:op,backupId:intent.backupId,runId,archiveIntentSha256:sourceFreezeSha(intent),...guard.ownerIdentity,program:program.file,programSha256:program.sha256,args:['--format=custom','--no-owner','--no-acl','--no-password','--strict-names','--schema=public','--schema=idms_field','--snapshot='+captured.exported,'--file='+dumpFile,'--lock-wait-timeout=5s'],applicationName:'idms-field-archive-'+runId,dumpFile};
   await files.recordArchiveTool(tool);tools.push(tool);
   const dumped=await runArchiveDump(tool,{config:backupConfig,account,guard,check:()=>check(),signal});
   const terminalDeadline=Date.now()+15000;
   while((await observer.query('SELECT 1 FROM pg_stat_activity WHERE datid=$1::oid AND usesysid=$2::oid AND application_name=$3',[freeze.database.oid,freeze.roles.backup.oid,tool.applicationName])).rowCount){
    await check();if(Date.now()>terminalDeadline)fail('FIELD_ARCHIVE_DUMP_BACKEND_TERMINAL_UNCONFIRMED');await sleep(25);
   }
   const handle=await open(dumpFile,'r+');try{await handle.sync();}finally{await handle.close();}
   await freshFacts();
   const manifest=fieldBackupManifest({format:intent.captureContextSha256?'idms-field-full-backup-v3':'idms-field-full-backup-v2',...(intent.captureContextSha256?{captureContext:captured.captureContext}:{}),backupId:intent.backupId,tenantId,createdAt:intent.createdAt,scope:'TENANT_PUBLIC_AND_FIELD',recoveryMode:'ISOLATED_PENDING_INDEPENDENT_APPROVAL',operationId:op,intentDigest:files.intentDigest,sourceIdentity:restore.before.identity,targetIdentity:restore.after.identity,sourceBinding:{host:runtime.host,port:runtime.port,database:a.database,user:a.user},recoveryControlDigest:sourceFreezeSha(restore.after),facts:captured.facts,dump:{format:'PGDMP',...dumped},sourceProof:captured.sourceProof},tenantId);
   const staged=await stageFieldBackup({manifest,dumpFile,keyFile,outputDirectory:root,expectedKeyBinding:key,signal});
   await freshFacts();
   await files.recordArchiveReady({format:'idms-field-archive-ready-v1',operationId:op,backupId:intent.backupId,archiveIntentSha256:sourceFreezeSha(intent),manifestSha256:sourceFreezeSha(manifest),archiveSha256:staged.archiveSha256,encryptedBytes:staged.encryptedBytes,dump:manifest.dump});
   state=await files.readArchiveState();
  }
  if(await exists(final)){
   if(await exists(partial))fail('FIELD_ARCHIVE_PUBLICATION_CONFLICT');
   await verifyArchive(final,state.ready);
  }else{
   if(state.result)fail('FIELD_ARCHIVE_COMPLETED_FILE_MISSING');
   await verifyArchive(partial,state.ready);await freshFacts();
   await files.publishArchive({source:partial,destination:final,outputDirectory:root,backupId:intent.backupId,tenantId,sha256:state.ready.archiveSha256});
   await verifyArchive(final,state.ready);
  }
  await freshFacts();
  await files.recordArchiveResult({format:'idms-field-archive-result-v1',operationId:op,backupId:intent.backupId,archiveIntentSha256:sourceFreezeSha(intent),readySha256:sourceFreezeSha(state.ready),archiveSha256:state.ready.archiveSha256,manifestSha256:state.ready.manifestSha256});
  for(const tool of tools)await removeOwnedArchiveDump(tool,files);
  return {format:'idms-field-archive-operation-result-v1',tenantId,operationId:op,backupId:intent.backupId,file:final,encryptedBytes:state.ready.encryptedBytes,archiveSha256:state.ready.archiveSha256,manifestSha256:state.ready.manifestSha256,alreadyRecorded:!!state.result,sourceFrozen:true,state:'RESTORING',fullArchiveAuthenticationVerified:true,fullDumpSha256Verified:true,restorePerformed:false,independentActivationApprovalRequired:true,credentialsLogged:false,productionAcceptance:false};
 }finally{
  for(const c of [reader,snapshot]){if(c?.getTransactionStatus?.()==='T'||c?.getTransactionStatus?.()==='E')await c.query('ROLLBACK').catch(()=>{});await closeSourceConnection(c);}
  if(observerConnected)await observer.query('ROLLBACK').catch(()=>{});await closeSourceConnection(observer);
 }
}
