import pg from 'pg';
import {readEntities} from '../server/entity-repository.ts';
import {canonical} from '../server/imports.ts';
import {memoryTask} from '../server/capacity.ts';
import {openFieldRestoreContext} from './field-restore-prepare.mjs';
import {beginRestoreSnapshot,rollbackRestoreSnapshot,verifyCommittedRestore} from './field-restore-verify.mjs';
import {checkRestoreTarget} from './field-restore-target.mjs';
import {readFieldRestorePhase} from './field-restore-phase.mjs';
import {readReviewPhase,reviewFail} from './field-recovery-review-record.mjs';
import {readFrozenSourceFacts} from './field-source-freeze-security.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {readFieldMaintenanceCatalog} from './field-maintenance-catalog.mjs';
import {applyFieldFactSession} from './field-fact-session.mjs';
import {readFieldDatabaseContext} from './field-capture-context.mjs';
import {closeSourceConnection} from './field-source-freeze.mjs';
import {FieldReviewFiles} from './field-recovery-review-files.mjs';
import {reviewSessionAllowed} from './field-recovery-review-sessions.mjs';
export function recoveryReviewInputs(loaded){
 const b=loaded.payload.business,orders=b.workOrders,templates=b.templates.filter(t=>t.status==='PUBLISHED');if(!Array.isArray(orders)||orders.length>512||templates.length>512)reviewFail('FIELD_REVIEW_INPUT_LIMIT');
 const policies=templates.map(t=>{const bodySha256=sourceFreezeSha(t);return {id:t.id,templateKey:t.templateKey,version:t.version,contentDigest:t.contentDigest||bodySha256,digestKind:t.contentDigest?'DECLARED':'LEGACY_BODY_SHA256',bodySha256,purpose:typeof t.manifest?.purpose==='string'?t.manifest.purpose:'LEGACY_UNCLASSIFIED'};}).sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));return {orders,policies};
}
export async function openReviewContext(options){
 const {authority,tenantId,guard,files}=options,c=await openFieldRestoreContext(options),flow=await files.readRestoreFlow(),state=await files.readRestoreState();let root,reader,observer;
 const check=async()=>{await c.check();if(await checkRestoreTarget(root,c,state)!=='SEALED')reviewFail('FIELD_REVIEW_TARGET_NOT_SEALED');};
 try{
  if(!flow.result||!flow.verification||flow.plans.length!==3)reviewFail('FIELD_REVIEW_RESTORE_REQUIRED');
  const connect=async(database,user,password,suffix)=>{const p=new pg.Client({host:authority.host,port:authority.port,database,user,password,ssl:false,application_name:'idms-review-'+suffix+'-'+c.intent.operationId,connectionTimeoutMillis:5000,query_timeout:30000,options:'-c statement_timeout=25000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=60000'});p.on('error',()=>{});try{await p.connect();await applyFieldFactSession(p,c.manifest.captureContext.session);return p;}catch(e){await closeSourceConnection(p);throw e;}};
  observer=await connect('postgres','idms_bootstrap',authority.bootstrapPassword,'observer');if(sourceFreezeSha('postgres:'+(await observer.query('SELECT system_identifier::text AS system FROM pg_control_system()')).rows[0].system)!==guard.authorityId)reviewFail('FIELD_REVIEW_AUTHORITY_CHANGED');root=await connect(c.account.database,'idms_bootstrap',authority.bootstrapPassword,'root');reader=await connect(c.account.database,c.backupAccount.user,c.backupAccount.password,'backup');await check();
  const noOthers=async()=>{await check();const rows=(await observer.query('SELECT pid,usesysid::text,backend_type,leader_pid,application_name FROM pg_stat_activity WHERE datid=$1::oid AND pid<>ALL($2::int[])',[state.provision.database.oid,[root.processID,reader.processID]])).rows,blockers=rows.filter(r=>!reviewSessionAllowed(r,{rootPid:root.processID,readerPid:reader.processID,backupOid:state.roles.roles.backup.oid}));if(blockers.length)throw Object.assign(Error('FIELD_REVIEW_OTHER_TARGET_SESSION'),{code:'FIELD_REVIEW_OTHER_TARGET_SESSION',blockers});};
  if(canonical(await readFieldDatabaseContext(root,c.account.database))!==canonical(c.manifest.captureContext.database))reviewFail('FIELD_REVIEW_DATABASE_CHANGED');
  const journal=new FieldReviewFiles(guard,files);
  const begin=async()=>{await noOthers();await root.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await root.query('SELECT tenant_id FROM public.business_state WHERE tenant_id=$1 FOR UPDATE',[tenantId]);const snapshot=(await root.query('SELECT pg_export_snapshot() AS value')).rows[0].value;if(!/^[A-Fa-f0-9-]{1,64}$/.test(snapshot))reviewFail('FIELD_REVIEW_SNAPSHOT_INVALID');await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+snapshot+"'");};
  const read=async()=>memoryTask(async()=>{await check();const phase=await readReviewPhase(root,c.account.database)||await readFieldRestorePhase(root,c.account.database),facts=await readFrozenSourceFacts(root,c.account,c.migrator,tenantId,{sequenceClient:reader}),loaded=await readEntities(root,tenantId),rootRecord=(await root.query('SELECT to_jsonb(t)::text AS value FROM public.business_state t WHERE tenant_id=$1',[tenantId])).rows[0]?.value;return {phase,facts,loaded,rootRecord,...recoveryReviewInputs(loaded)};},true);
  const verifyInitial=async()=>{const phase=await readFieldRestorePhase(root,c.account.database);return verifyCommittedRestore(root,reader,c,flow.verification,phase,tenantId);};
  return {...c,flow,state,root,reader,observer,journal,guard,files,tenantId,check,noOthers,begin,read,verifyInitial,rollback:()=>rollbackRestoreSnapshot(root,reader),close:async()=>{for(const p of [reader,root]){if(['T','E'].includes(p?.getTransactionStatus?.()))await p.query('ROLLBACK').catch(()=>{});}for(const p of [reader,root,observer])await closeSourceConnection(p);await c.opened.dispose();}};
 }catch(e){for(const p of [reader,root,observer])await closeSourceConnection(p);await c.opened.dispose();throw e;}
}
