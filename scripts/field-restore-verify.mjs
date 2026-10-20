import pg from 'pg';
import {createHash} from 'node:crypto';
import {canonical,digest} from '../server/imports.ts';
import {readEntities} from '../server/entity-repository.ts';
import {tenantWorkspace,workspacePayload} from '../server/tenant-workspace.ts';
import {savePostgres} from '../server/postgres-repository.ts';
import {appendAudit} from '../server/audit.ts';
import {quoteIdentifier as q} from '../server/postgres-schema.ts';
import {memoryTask} from '../server/capacity.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {readFrozenSourceFacts} from './field-source-freeze-security.mjs';
import {readUnreboundRestoredFacts,rebindRestoredMigrationRoles,assertRawRestoredFacts} from './field-restore-security.mjs';
import {nextFieldRestorePhase,fieldRestorePhaseSql,readFieldRestorePhase} from './field-restore-phase.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});},same=(a,b)=>canonical(a)===canonical(b);
export async function beginRestoreSnapshot(client,reader){await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const snapshot=(await client.query('SELECT pg_export_snapshot() AS value')).rows[0].value;if(!/^[a-fA-F0-9-]{1,64}$/.test(snapshot))fail('FIELD_RESTORE_SNAPSHOT_INVALID');await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+snapshot+"'");}
export async function rollbackRestoreSnapshot(client,reader){await reader.query('ROLLBACK');await client.query('ROLLBACK');}
function auditInput(c,v,tenant){return {tenantId:tenant,objectType:'FIELD_TARGET_RESTORE',objectId:tenant,action:'FIELD_TARGET_RESTORE_VERIFIED',actorType:'SYSTEM',actorId:'field-target-restore',correlationId:c.intent.operationId,before:{state:'RESTORING',sourceRoot:c.manifest.facts.root},after:{state:'RESTORING',targetDatabase:c.account.database,roleMap:{owner:c.account.ownerRole,app:c.account.user,backup:c.account.backupRole,migrator:c.migrator}},metadata:{format:'idms-field-target-restore-audit-v1',backupId:c.manifest.backupId,restoreIntentSha256:sourceFreezeSha(c.intent),verificationIntentSha256:sourceFreezeSha(v),sourceFactsSha256:c.manifest.facts.factsSha256}};}
export async function prepareRestoreVerification(client,reader,c,state,flow,files,tenant,check){
 return memoryTask(async()=>{
  await beginRestoreSnapshot(client,reader);try{
   const raw=await readUnreboundRestoredFacts(client,c.account,c.migrator,c.sourceAccount,tenant,{sequenceClient:reader});assertRawRestoredFacts(raw,c.manifest.facts,c.account);
   await client.query('SAVEPOINT idms_restore_expected_metadata');let rebound;
   try{await client.query(`SET LOCAL ROLE ${q(c.account.ownerRole)}`);await rebindRestoredMigrationRoles(client,c.sourceAccount,c.account,tenant);rebound=await readFrozenSourceFacts(client,c.account,c.migrator,tenant,{sequenceClient:reader});}finally{await client.query('ROLLBACK TO SAVEPOINT idms_restore_expected_metadata');await client.query('RELEASE SAVEPOINT idms_restore_expected_metadata');}
   // Keep PostgreSQL's microseconds before savePostgres updates the root. The
   // facts-v1 Date representation intentionally retains its original semantics.
   const sourceRootRecord=(await client.query('SELECT to_jsonb(t)::text AS record FROM public.business_state t')).rows[0]?.record;
   assertSourceRootRecord(sourceRootRecord,c.manifest.facts);
   const value={format:'idms-field-restore-verification-intent-v1',operationId:c.intent.operationId,restoreIntentSha256:sourceFreezeSha(c.intent),provisionSha256:sourceFreezeSha(state.provision),phaseChainSha256:sourceFreezeSha(flow.plans),postDataPhaseSha256:sourceFreezeSha(flow.plans[2].next),sourceFactsSha256:c.manifest.facts.factsSha256,rawFactsSha256:raw.factsSha256,expectedReboundFactsSha256:rebound.factsSha256,sourceRootRecord,sourceAuditCount:c.manifest.facts.auditEvents,sourceAuditHead:c.manifest.facts.auditHead,createdAt:flow.verification?.createdAt||new Date().toISOString()};
   if(flow.verification&&!same(value,flow.verification))fail('FIELD_RESTORE_VERIFICATION_INTENT_CHANGED');await check();await files.recordRestoreVerification(value);return value;
  }finally{await rollbackRestoreSnapshot(client,reader);}
 },true);
}
export async function commitRestoreVerification(client,reader,c,v,phase,tenant,check){
 return memoryTask(async()=>{
  await beginRestoreSnapshot(client,reader);try{
   const raw=await readUnreboundRestoredFacts(client,c.account,c.migrator,c.sourceAccount,tenant,{sequenceClient:reader});assertRawRestoredFacts(raw,c.manifest.facts,c.account);if(raw.factsSha256!==v.rawFactsSha256)fail('FIELD_RESTORE_VERIFICATION_SOURCE_CHANGED');
   await client.query(`SET LOCAL ROLE ${q(c.account.ownerRole)}`);await rebindRestoredMigrationRoles(client,c.sourceAccount,c.account,tenant);
   const rebound=await readFrozenSourceFacts(client,c.account,c.migrator,tenant,{sequenceClient:reader});if(rebound.factsSha256!==v.expectedReboundFactsSha256)fail('FIELD_RESTORE_REBOUND_FACTS_CHANGED');
   const loaded=await readEntities(client,tenant),w=tenantWorkspace(loaded.payload);if(w.store.audits.some(e=>e.objectType==='FIELD_TARGET_RESTORE'&&e.correlationId===c.intent.operationId)||loaded.revision>=Number.MAX_SAFE_INTEGER)fail('FIELD_RESTORE_TARGET_AUDIT_ALREADY_EXISTS');
   const sequences=c.manifest.facts.sequences,s=sequences[0];if(sequences.length!==1||s.schema!=='public'||s.name!=='audit_ledger_sequence_no_seq'||s.seqincrement!=='1'||s.seqcache!=='1'||s.seqcycle||!s.is_called||BigInt(s.last_value)>=BigInt(s.seqmax))fail('FIELD_RESTORE_AUDIT_SEQUENCE_UNSUPPORTED');
   // RESTART uses transactional sequence storage. A killed verification rolls
   // back both the audit and its allocation, leaving strict raw facts reusable.
   await client.query('ALTER SEQUENCE public.audit_ledger_sequence_no_seq RESTART WITH '+(BigInt(s.last_value)+1n).toString());
   const event=appendAudit(w.store,auditInput(c,v,tenant));if(Date.parse(event.businessTime)<Date.parse(v.createdAt))fail('FIELD_RESTORE_AUDIT_CLOCK_INVALID');await savePostgres(workspacePayload(w,tenant),{tenantId:tenant,client,...loaded});
   const final=await readPendingVerifiedFacts(client,reader,c,tenant,event.eventId),next=nextFieldRestorePhase(phase,'VERIFIED',final.factsSha256,event.eventId);await client.query(fieldRestorePhaseSql(next,c.account.ownerRole));await check();await client.query('/* IDMS_FIELD_TARGET_RESTORE_VERIFIED_COMMIT */ COMMIT');await reader.query('ROLLBACK');return next;
  }catch(e){await reader.query('ROLLBACK').catch(()=>{});await client.query('ROLLBACK').catch(()=>{});throw e;}
 },true);
}
async function hashQuery(client,text,values=[]){const h=createHash('sha256');let rows=0,bytes=0,problem;await new Promise((ok,no)=>{const query=client.query(new pg.Query({text,values}));query.on('row',r=>{if(problem)return;if(typeof r.record!=='string'||Buffer.byteLength(r.record)>64*1024**2){problem=Object.assign(Error('FIELD_RESTORE_ROW_LIMIT'),{code:'FIELD_RESTORE_ROW_LIMIT'});return;}const s=r.record+'\n';h.update(s);rows++;bytes+=Buffer.byteLength(s);});query.once('error',no);query.once('end',()=>problem?no(problem):ok());});return {rows,bytes,sha256:h.digest('hex')};}
const content=r=>({rows:r.rows,bytes:r.bytes,sha256:r.sha256});
async function readPendingVerifiedFacts(client,reader,c,tenant,eventId){
 const facts=await readFrozenSourceFacts(client,c.account,c.migrator,tenant,{sequenceClient:reader});
 // The independent reader still sees pre-RESTART storage until COMMIT. Require
 // it to remain exactly the authenticated source image, then measure the new
 // storage in its owning transaction. A fresh post-COMMIT scan verifies all of
 // these facts, including this value, before any result can be recorded.
 if(!same(facts.sequences,c.manifest.facts.sequences))fail('FIELD_RESTORE_PENDING_SEQUENCE_CHANGED');
 const own=(await client.query('SELECT last_value::text,is_called FROM public.audit_ledger_sequence_no_seq')).rows[0],audit=(await client.query('SELECT sequence_no::text AS value FROM public.audit_ledger WHERE event_id=$1',[eventId])).rows[0];
 if(!own?.is_called||own.last_value!==audit?.value||BigInt(own.last_value)!==BigInt(facts.sequences[0].last_value)+1n)fail('FIELD_RESTORE_PENDING_SEQUENCE_CHANGED');
 const {factsSha256:_sha,sequenceValuesAreNotMvcc,maximumSupportedRowBytes,...body}=facts;body.sequences=[{...facts.sequences[0],...own}];
 return {...body,factsSha256:digest(canonical(body)),sequenceValuesAreNotMvcc,maximumSupportedRowBytes};
}
function assertSourceRootRecord(record,source){
 if(typeof record!=='string'||Buffer.byteLength(record)>4096)fail('FIELD_RESTORE_SOURCE_ROOT_RECORD_INVALID');
 const row=JSON.parse(record),expected=source.relations.find(r=>r.schema==='public'&&r.table==='business_state'),text=record+'\n';
 if(!expected||expected.rows!==1||expected.bytes!==Buffer.byteLength(text)||expected.sha256!==createHash('sha256').update(text).digest('hex')||!Number.isSafeInteger(row.revision)||!same({...row,revision:String(row.revision),updated_at:new Date(row.updated_at).toISOString()},source.root))fail('FIELD_RESTORE_SOURCE_ROOT_RECORD_CHANGED');
 return row;
}
export async function verifyCommittedRestore(client,reader,c,v,phase,tenant){
 return memoryTask(async()=>{
  await beginRestoreSnapshot(client,reader);try{
   if(phase.stage!=='VERIFIED')fail('FIELD_RESTORE_COMMIT_NOT_VERIFIED');const current=await readFrozenSourceFacts(client,c.account,c.migrator,tenant,{sequenceClient:reader});if(current.factsSha256!==phase.contentSha256||!same(await readFieldRestorePhase(client,c.account.database),phase))fail('FIELD_RESTORE_FINAL_FACTS_CHANGED');
   const source=c.manifest.facts,loaded=await readEntities(client,tenant),audits=loaded.payload.audits,event=audits.at(-1),expected=auditInput(c,v,tenant);
   if(audits.length!==source.auditEvents+1||event?.eventId!==phase.auditEventId||source.auditHead!==event.previousHash||Object.entries(expected).some(([key,value])=>!same(event[key],value))||audits.filter(e=>e.objectType==='FIELD_TARGET_RESTORE'&&e.correlationId===c.intent.operationId).length!==1||loaded.revision!==source.revision+1||current.businessSha256!==source.businessSha256||current.importsSha256!==source.importsSha256||!same(current.module,source.module))fail('FIELD_RESTORE_FINAL_AUDIT_CHANGED');
   const oldPayload={...loaded.payload,audits:audits.slice(0,-1)};if(digest(canonical(oldPayload))!==source.root.payload_digest)fail('FIELD_RESTORE_OLD_ROOT_CHANGED');
   const changed=new Set(['public.business_state','public.audit_ledger','public.runtime_state','public.idms_schema_migrations','idms_field.migrations']);
   for(const s of source.relations){const actual=current.relations.find(r=>r.schema===s.schema&&r.table===s.table);if(!actual)fail('FIELD_RESTORE_FINAL_RELATIONS_CHANGED');const {rows:_r,bytes:_b,sha256:_h,...schema}=actual,{rows:_sr,bytes:_sb,sha256:_sh,...expectedSchema}=s;if(!same(schema,expectedSchema)||!changed.has(s.schema+'.'+s.table)&&!same(actual,s))fail('FIELD_RESTORE_FINAL_RELATIONS_CHANGED');}
   const relation=(schema,table)=>source.relations.find(r=>r.schema===schema&&r.table===table),eq=(got,want)=>{if(!same(got,content(want)))fail('FIELD_RESTORE_OLD_ROWS_CHANGED_'+want.table.toUpperCase());};
   eq(await hashQuery(client,'SELECT to_jsonb(t)::text AS record FROM public.audit_ledger t WHERE event_id<>$1 ORDER BY to_jsonb(t)::text COLLATE "C"',[event.eventId]),relation('public','audit_ledger'));
   for(const [schema,table]of [['public','idms_schema_migrations'],['idms_field','migrations']]){const expression="(to_jsonb(t)||jsonb_build_object('owner_role',$1::text,'app_role',$2::text,'backup_role',$3::text))::text";eq(await hashQuery(client,`SELECT ${expression} AS record FROM ${q(schema)}.${q(table)} t ORDER BY ${expression} COLLATE "C"`,[c.sourceAccount.ownerRole,c.sourceAccount.user,c.sourceAccount.backupRole]),relation(schema,table));}
   const sourceRoot=assertSourceRootRecord(v.sourceRootRecord,source);
   eq(await hashQuery(client,'SELECT to_jsonb(t)::text AS record FROM jsonb_populate_record(NULL::public.business_state,$1::jsonb) t',[v.sourceRootRecord]),relation('public','business_state'));
   const view=(await client.query('SELECT to_jsonb(t) AS row FROM public.runtime_state t')).rows;if(view.length!==1)fail('FIELD_RESTORE_OLD_VIEW_CHANGED');const oldView={...view[0].row,revision:source.revision,updated_at:sourceRoot.updated_at,payload:oldPayload};
   eq(await hashQuery(client,'SELECT to_jsonb(t)::text AS record FROM jsonb_populate_record(NULL::public.runtime_state,$1::jsonb) t',[JSON.stringify(oldView)]),relation('public','runtime_state'));
   const auditSequence=(await client.query('SELECT sequence_no::text AS value FROM public.audit_ledger WHERE event_id=$1',[event.eventId])).rows[0]?.value;
   if(current.sequences.length!==source.sequences.length)fail('FIELD_RESTORE_FINAL_SEQUENCE_CHANGED');for(const s of source.sequences){const t=current.sequences.find(x=>x.schema===s.schema&&x.name===s.name);if(!t)fail('FIELD_RESTORE_FINAL_SEQUENCE_CHANGED');const {last_value:_sl,is_called:_sc,...sd}=s,{last_value:_tl,is_called:_tc,...td}=t;if(!same(sd,td)||!t.is_called||t.last_value!==auditSequence||BigInt(t.last_value)<=BigInt(s.last_value))fail('FIELD_RESTORE_FINAL_SEQUENCE_CHANGED');}
   return {facts:current,auditEventId:event.eventId,revision:loaded.revision};
  }finally{await rollbackRestoreSnapshot(client,reader);}
 },true);
}
