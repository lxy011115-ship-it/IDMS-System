import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {canonical} from '../server/imports.ts';
import {connectionFor} from '../server/postgres-security.ts';
import {openFieldRestoreContext} from './field-restore-prepare.mjs';
import {provisionFieldRestoreTarget} from './field-restore-provision.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {closeSourceConnection} from './field-source-freeze.mjs';
import {fieldRestoreProgram,retireFieldRestoreTool,runFieldRestoreTool,copyRestoreDump,writeRestoreWorkFile,cleanupRestoreWork} from './field-restore-tool.mjs';
import {fieldRestoreWorkSha,restoreSections} from './field-restore-flow-record.mjs';
import {nextFieldRestorePhase,fieldRestorePhaseSql,readFieldRestorePhase,classifyFieldRestorePhase} from './field-restore-phase.mjs';
import {checkRestoreTarget,openRestoreWriter,sealRestoredTarget} from './field-restore-target.mjs';
import {applyFieldFactSession} from './field-fact-session.mjs';
import {readFieldDatabaseContext} from './field-capture-context.mjs';
import {hashFieldBackupFile} from './field-backup-archive.mjs';
import {prepareRestoreVerification,commitRestoreVerification,verifyCommittedRestore} from './field-restore-verify.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});},same=(a,b)=>canonical(a)===canonical(b),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));

export async function restoreFieldTarget(options){
 const {authority,tenantId,guard,files,signal}=options,c=await openFieldRestoreContext(options);let observer,client,reader,lost=false,activeTool;
 const check=async()=>{if(signal?.aborted)fail('FIELD_RESTORE_CANCELLED');if(lost)fail('FIELD_RESTORE_CONNECTION_LOST');await c.check();};
 const ownConnect=async(database,account,name)=>{const p=new pg.Client({...connectionFor(c.targetRuntime,{database,...account}),application_name:name});p.on('error',()=>{lost=true;});try{await p.connect();return p;}catch(e){await closeSourceConnection(p);throw e;}};
 try{
  let state=await files.readRestoreState();
  if(!state.provision){await provisionFieldRestoreTarget({authority,rawIntent:c.intent,targetRuntime:c.targetRuntime,targetMigration:c.targetMigration,targetBackup:c.targetBackup,captureContext:c.manifest.captureContext,guard,files});state=await files.readRestoreState();}
  let flow=await files.readRestoreFlow();
  const controlName='idms-restore-control-'+c.intent.operationId,readerName='idms-restore-reader-'+c.intent.operationId;
  observer=await ownConnect('postgres',{user:'idms_bootstrap',password:authority.bootstrapPassword},'idms-restore-observer-'+c.intent.operationId);
  if(sourceFreezeSha('postgres:'+(await observer.query('SELECT system_identifier::text AS system FROM pg_control_system()')).rows[0].system)!==guard.authorityId)fail('FIELD_RESTORE_AUTHORITY_CHANGED');
  await checkRestoreTarget(observer,c,state);
  for(const t of flow.tools)await retireFieldRestoreTool(t,files.restoreToolFile(t.toolId),guard);
  const bootstrap=(await observer.query("SELECT oid::text AS oid FROM pg_roles WHERE rolname='idms_bootstrap'")).rows[0]?.oid;
  const oldTags=[controlName,readerName,...flow.tools.filter(t=>t.kind==='APPLY').map(t=>t.applicationName)];
  for(;;){await check();const old=(await observer.query('SELECT pid,backend_start::text,usesysid::text,application_name FROM pg_stat_activity WHERE datid=$1::oid AND application_name=ANY($2::text[])',[state.provision.database.oid,oldTags])).rows;if(!old.length)break;for(const s of old){const role=s.application_name===controlName?bootstrap:s.application_name===readerName?state.roles.roles.backup.oid:state.roles.roles.migrator.oid;if(s.usesysid!==role)fail('FIELD_RESTORE_OLD_BACKEND_BINDING_CHANGED');await observer.query('SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datid=$3::oid AND usesysid=$4::oid',[s.pid,s.backend_start,state.provision.database.oid,role]);}await sleep(25);}
  client=await ownConnect(c.account.database,{user:'idms_bootstrap',password:authority.bootstrapPassword},controlName);await applyFieldFactSession(client,c.manifest.captureContext.session);
  if(!same(await readFieldDatabaseContext(client,c.account.database),c.manifest.captureContext.database))fail('FIELD_RESTORE_DATABASE_CONTEXT_CHANGED');
  async function noOtherSessions(){await check();const allowed=[client.processID,...(reader?[reader.processID]:[])];const rows=(await observer.query('SELECT pid,usesysid::text,application_name FROM pg_stat_activity WHERE datid=$1::oid AND pid<>ALL($2::int[])',[state.provision.database.oid,allowed])).rows;if(rows.some(r=>!activeTool||r.application_name!==activeTool.applicationName||r.usesysid!==state.roles.roles.migrator.oid))fail('FIELD_RESTORE_TARGET_OTHER_SESSION');}
  async function toolBackendGone(t){const deadline=Date.now()+15000;while((await observer.query('SELECT 1 FROM pg_stat_activity WHERE datid=$1::oid AND usesysid=$2::oid AND application_name=$3',[state.provision.database.oid,state.roles.roles.migrator.oid,t.applicationName])).rowCount){await check();if(Date.now()>deadline)fail('FIELD_RESTORE_TOOL_BACKEND_TERMINAL_UNCONFIRMED');await sleep(25);}}
  let phase=await readFieldRestorePhase(client,c.account.database);
  const matches=p=>p.operationId===c.intent.operationId&&p.backupId===c.manifest.backupId&&p.restoreIntentSha256===sourceFreezeSha(c.intent)&&p.databaseOid===state.provision.database.oid&&p.databaseName===c.account.database;
  if(!matches(phase))fail('FIELD_RESTORE_PHASE_BINDING_CHANGED');
  function reconcile(){if(phase.stage==='EMPTY'){if(phase.previousSha256!==null)fail('FIELD_RESTORE_PHASE_CHAIN_CHANGED');return;}if(phase.stage==='VERIFIED'){if(!flow.verification||flow.plans.length!==3||phase.previousSha256!==sourceFreezeSha(flow.plans[2].next))fail('FIELD_RESTORE_PHASE_CHAIN_CHANGED');return;}const p=flow.plans.find(p=>p.section===phase.stage);if(!p||!same(p.next,phase))fail('FIELD_RESTORE_PHASE_CHAIN_CHANGED');}
  reconcile();await noOtherSessions();
  if(phase.stage==='EMPTY'){
   const ns=(await client.query("SELECT nspname,pg_get_userbyid(nspowner) AS owner,obj_description(oid,'pg_namespace') AS comment FROM pg_namespace WHERE nspname!~'^pg_' AND nspname<>'information_schema'")).rows;
   if(ns.length!==1||ns[0].nspname!=='public'||ns[0].owner!=='pg_database_owner'||ns[0].comment!=='standard public schema'||(await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' LIMIT 1")).rowCount)fail('FIELD_RESTORE_EMPTY_TARGET_CHANGED');
  }
  const [generator,executor]=await Promise.all([fieldRestoreProgram('pg_restore'),fieldRestoreProgram('psql')]);
  if(phase.stage!=='VERIFIED'){
   const unused=flow.runs.filter(r=>!flow.plans.some(p=>p.runId===r.runId));await cleanupRestoreWork(files,{runs:unused});
   for(const section of restoreSections){
    flow=await files.readRestoreFlow();let plan=flow.plans.find(p=>p.section===section);
    const phaseIndex=['EMPTY',...restoreSections,'VERIFIED'].indexOf(phase.stage),index=restoreSections.indexOf(section)+1;
    if(phaseIndex>=index){if(!plan)fail('FIELD_RESTORE_PHASE_PLAN_MISSING');continue;}
    if(phaseIndex!==index-1)fail('FIELD_RESTORE_PHASE_CHAIN_CHANGED');
    await noOtherSessions();await openRestoreWriter(client,c,state,noOtherSessions);
    if(!plan){
     const runId=randomUUID();await files.recordRestoreRun({format:'idms-field-restore-run-v1',operationId:c.intent.operationId,restoreIntentSha256:sourceFreezeSha(c.intent),runId,createdAt:new Date().toISOString()});
     const paths={dump:files.restoreWorkFile(runId,'dump'),sql:files.restoreWorkFile(runId,section+'.sql'),prefix:files.restoreWorkFile(runId,section+'.prefix'),marker:files.restoreWorkFile(runId,section+'.marker')};
     await copyRestoreDump(c.opened.dumpFile,paths.dump,c.manifest.dump,check);
     const genId=randomUUID(),gen={format:'idms-field-restore-tool-v1',operationId:c.intent.operationId,restoreIntentSha256:sourceFreezeSha(c.intent),runId,toolId:genId,kind:'GENERATE',section,program:generator.file,programSha256:generator.sha256,args:['--no-owner','--no-acl','--no-password','--role='+c.account.ownerRole,'--section='+section,'--file='+paths.sql,paths.dump],...guard.ownerIdentity,applicationName:'idms-field-restore-'+genId,inputs:[{path:paths.dump,bytes:c.manifest.dump.bytes,sha256:c.manifest.dump.sha256}],output:paths.sql};
     await files.recordRestoreTool(gen);const generated=await runFieldRestoreTool(gen,{runtime:c.targetRuntime,account:c.migrationAccount,guard,check:noOtherSessions,signal});if(generated.failed)fail('FIELD_RESTORE_SQL_GENERATION_FAILED');
     const sql=await hashFieldBackupFile(paths.sql),sync=await open(paths.sql,'r+');try{await sync.sync();}finally{await sync.close();}
     const prefix=await writeRestoreWorkFile(paths.prefix,Buffer.from('SET LOCAL ROLE "'+c.account.ownerRole+'";\n'+(section==='pre-data'?'DROP SCHEMA public;\n':'')));
     const draft={format:'idms-field-restore-plan-v1',operationId:c.intent.operationId,restoreIntentSha256:sourceFreezeSha(c.intent),section,runId,previous:phase,dumpSha256:c.manifest.dump.sha256,sql,prefix,generationProgramSha256:generator.sha256,executionProgramSha256:executor.sha256};
     const next=nextFieldRestorePhase(phase,section,fieldRestoreWorkSha(draft)),marker=await writeRestoreWorkFile(paths.marker,Buffer.from(fieldRestorePhaseSql(next,c.account.ownerRole)));
     plan={...draft,next,marker};await files.recordRestorePlan(plan);
    }
    if(classifyFieldRestorePhase(phase,plan.previous,plan.next)!=='PENDING'||plan.executionProgramSha256!==executor.sha256||plan.generationProgramSha256!==generator.sha256)fail('FIELD_RESTORE_PHASE_INPUT_CHANGED');
    const toolId=randomUUID(),paths={sql:files.restoreWorkFile(plan.runId,section+'.sql'),prefix:files.restoreWorkFile(plan.runId,section+'.prefix'),marker:files.restoreWorkFile(plan.runId,section+'.marker')},apply={format:'idms-field-restore-tool-v1',operationId:c.intent.operationId,restoreIntentSha256:sourceFreezeSha(c.intent),runId:plan.runId,toolId,kind:'APPLY',section,program:executor.file,programSha256:executor.sha256,args:['--no-psqlrc','--no-password','--quiet','--single-transaction','--set=ON_ERROR_STOP=1','--file='+paths.prefix,'--file='+paths.sql,'--file='+paths.marker],...guard.ownerIdentity,applicationName:'idms-field-restore-'+toolId,inputs:[{path:paths.prefix,...plan.prefix},{path:paths.sql,...plan.sql},{path:paths.marker,...plan.marker}],output:null};
    await files.recordRestoreTool(apply);activeTool=apply;let outcome;try{outcome=await runFieldRestoreTool(apply,{runtime:c.targetRuntime,account:c.migrationAccount,guard,check:noOtherSessions,signal});}finally{activeTool=null;}await toolBackendGone(apply);
    const actual=await readFieldRestorePhase(client,c.account.database);if(classifyFieldRestorePhase(actual,plan.previous,plan.next)!=='COMMITTED')fail(outcome.failed?'FIELD_RESTORE_SECTION_FAILED':'FIELD_RESTORE_SECTION_COMMIT_UNCONFIRMED');phase=actual;await noOtherSessions();
   }
   await sealRestoredTarget(client,c,state,tenantId,noOtherSessions);
  }
  if(await checkRestoreTarget(client,c,state)!=='SEALED')fail('FIELD_RESTORE_TARGET_NOT_SEALED');await noOtherSessions();
  reader=await ownConnect(c.account.database,c.backupAccount,readerName);await applyFieldFactSession(reader,c.manifest.captureContext.session);
  flow=await files.readRestoreFlow();let verification=flow.verification;
  if(phase.stage!=='VERIFIED'){
   verification=await prepareRestoreVerification(client,reader,c,state,flow,files,tenantId,noOtherSessions);
   try{phase=await commitRestoreVerification(client,reader,c,verification,phase,tenantId,noOtherSessions);}catch(e){await check();const actual=await readFieldRestorePhase(client,c.account.database);if(actual.stage!=='VERIFIED'||!matches(actual))throw e;phase=actual;}
  }
  if(!verification)fail('FIELD_RESTORE_VERIFICATION_INTENT_MISSING');
  const verified=await verifyCommittedRestore(client,reader,c,verification,phase,tenantId);await noOtherSessions();
  const result={format:'idms-field-restore-result-v1',operationId:c.intent.operationId,restoreIntentSha256:sourceFreezeSha(c.intent),verificationIntentSha256:sourceFreezeSha(verification),phaseSha256:sourceFreezeSha(phase),finalFactsSha256:verified.facts.factsSha256,auditEventId:verified.auditEventId,revision:verified.revision};
  if(flow.result&&!same(flow.result,result))fail('FIELD_RESTORE_RESULT_CHANGED');await files.recordRestoreResult(result);await check();
  await cleanupRestoreWork(files,await files.readRestoreFlow());
  return {format:'idms-field-target-restored-v1',tenantId,operationId:c.intent.operationId,backupId:c.manifest.backupId,targetDatabase:c.account.database,targetDataRestored:true,fullSourceFactsVerified:true,oldAuditBusinessImportsPointsAndReceiptsPreserved:true,controlledMigrationRoleRebinding:true,uniqueVerificationAuditEventId:verified.auditEventId,targetRevision:verified.revision,finalFactsSha256:verified.facts.factsSha256,alreadyRecorded:!!flow.result,state:'RESTORING',targetAppAndMigratorNoLogin:true,targetBackupReadonly:true,sourceDatabaseConnectionNotRequired:true,independentActivationApprovalRequired:true,credentialsLogged:false,productionAcceptance:false};
 }finally{
  for(const p of [reader,client,observer]){if(p?.getTransactionStatus?.()==='T'||p?.getTransactionStatus?.()==='E')await p.query('ROLLBACK').catch(()=>{});await closeSourceConnection(p);}await c.opened.dispose();
 }
}
