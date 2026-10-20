import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {memoryTask} from '../server/capacity.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {sourceSecurityFrame} from './field-source-freeze-security.mjs';
import {checkRestoreTarget} from './field-restore-target.mjs';
import {readFieldRestorePhase} from './field-restore-phase.mjs';
import {scanFieldSnapshotFacts} from './field-snapshot-facts.mjs';
import {readFieldMaintenanceCatalog} from './field-maintenance-catalog.mjs';
import {fieldMaintenanceCapability,fieldMaintenanceReaderConfig,fieldMaintenanceFence,maintenanceFailure} from './field-maintenance-record.mjs';
import {applyFieldFactSession} from './field-fact-session.mjs';
import {readFieldDatabaseContext} from './field-capture-context.mjs';
import {closeSourceConnection} from './field-source-freeze.mjs';
import {readReviewPhase} from './field-recovery-review-record.mjs';
import {verifyMaintenanceReview,maintenancePlanSummary} from './field-maintenance-review-reader.mjs';
const same=(a,b)=>canonical(a)===canonical(b),fail=code=>{throw maintenanceFailure(code);};
export function maintenanceClient(reader,sessionId,suffix){
 const {host,port,database,user,password}=reader;
 const client=new pg.Client({host,port,database,user,password,ssl:false,application_name:'idms-maintenance-'+sessionId+'-'+suffix,connectionTimeoutMillis:5000,query_timeout:15000,options:'-c default_transaction_read_only=on -c search_path=pg_catalog,public,idms_field -c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000'});client.on('error',()=>{});return client;
}
export async function beginMaintenanceSnapshot(client,reader){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const snapshot=(await client.query('SELECT pg_export_snapshot() AS value')).rows[0].value;if(!/^[a-fA-F0-9-]{1,64}$/.test(snapshot))fail('FIELD_MAINTENANCE_SNAPSHOT_INVALID');await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+snapshot+"'");
}
async function targetGate(client,cap,fence){
 const c={intent:fence.intent,account:cap.account,migrator:cap.account.migrator,backupAccount:{user:cap.account.backupRole}},state={roles:fence.roles,provision:fence.provision};
 if(await checkRestoreTarget(client,c,state)!=='SEALED')fail('FIELD_MAINTENANCE_TARGET_NOT_SEALED');await sourceSecurityFrame(client,cap.account,cap.account.migrator,'FROZEN');
 const phase=(cap.review?await readReviewPhase(client,cap.account.database):null)||await readFieldRestorePhase(client,cap.account.database);if(!['VERIFIED',...(cap.review?['SUBMITTED','APPROVED']:[])].includes(phase.stage)||sourceFreezeSha(phase)!==cap.phaseSha256||phase.contentSha256!==cap.factsSha256||phase.auditEventId!==(cap.review?.phase.auditEventId??fence.result.auditEventId)||!same(await readFieldDatabaseContext(client,cap.account.database),cap.captureContext.database))fail('FIELD_MAINTENANCE_TARGET_CHANGED');
}
export async function readFieldMaintenance(capability,configuration){
 return memoryTask(async()=>{
  const cap=fieldMaintenanceCapability(capability),config=fieldMaintenanceReaderConfig(configuration),a=cap.account;
  if(config.capabilitySha256!==sourceFreezeSha(cap)||!same({host:config.reader.host,port:config.reader.port,database:config.reader.database,user:config.reader.user},{host:a.host,port:a.port,database:a.database,user:a.backupRole})||!same(fieldPublicAuth(config.auth),cap.auth))fail('FIELD_MAINTENANCE_READER_MISMATCH');
  const fence=await fieldMaintenanceFence(cap),client=maintenanceClient(config.reader,cap.sessionId,'facts'),reader=maintenanceClient(config.reader,cap.sessionId,'sequence');
  let facts,catalog,refs,review=null;
  try{
   await client.connect();await reader.connect();await applyFieldFactSession(client,cap.captureContext.session);await applyFieldFactSession(reader,cap.captureContext.session);await beginMaintenanceSnapshot(client,reader);await targetGate(client,cap,fence);
   const roleOids=Object.values(fence.roles.roles).map(r=>r.oid);catalog=await readFieldMaintenanceCatalog(client,a,roleOids);if(catalog.sha256!==cap.catalogSha256)fail('FIELD_MAINTENANCE_CATALOG_CHANGED');
   facts=await scanFieldSnapshotFacts(client,a,cap.tenantId,{sequenceClient:reader});if(facts.factsSha256!==cap.factsSha256)fail('FIELD_MAINTENANCE_FACTS_CHANGED');
   if(cap.review)review=await verifyMaintenanceReview(client,cap,fence,facts);
   refs=(await client.query("SELECT id,body->>'templateKey' AS \"templateKey\",body->>'version' AS version,body->>'contentDigest' AS \"contentDigest\",body#>>'{manifest,purpose}' AS purpose FROM public.business_templates WHERE tenant_id=$1 AND body->>'status'='PUBLISHED' ORDER BY ordinal LIMIT 513",[cap.tenantId])).rows;if(refs.length>512)fail('FIELD_MAINTENANCE_REFERENCE_LIMIT');
   await reader.query('ROLLBACK');await client.query('ROLLBACK');await fieldMaintenanceFence(cap);
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await targetGate(client,cap,fence);
   if((await readFieldMaintenanceCatalog(client,a,roleOids)).sha256!==cap.catalogSha256)fail('FIELD_MAINTENANCE_CATALOG_CHANGED');
   const roots=(await client.query('SELECT to_jsonb(t)::text AS record FROM public.business_state t WHERE tenant_id=$1',[cap.tenantId])).rows,rootFact=facts.relations.find(r=>r.schema==='public'&&r.table==='business_state');if(roots.length!==1||sourceFreezeSha(roots[0].record+'\n')!==rootFact.sha256)fail('FIELD_MAINTENANCE_ROOT_CHANGED');await client.query('ROLLBACK');await fieldMaintenanceFence(cap);
   return {format:cap.review?'idms-field-maintenance-view-v2':'idms-field-maintenance-view-v1',tenantId:cap.tenantId,sessionId:cap.sessionId,operationId:cap.operationId,backupId:cap.backupId,state:'RESTORING',evaluatedAt:new Date().toISOString(),expiresAt:cap.expiresAt,targetDatabase:a.database,verified:{factsSha256:facts.factsSha256,catalogSha256:catalog.sha256,auditEventId:cap.review?.phase.auditEventId??fence.result.auditEventId,revision:cap.review?.phase.revision??fence.result.revision},relations:facts.relations.map(r=>({schema:r.schema,table:r.table,rows:r.rows})),auditEvents:facts.auditEvents,historicalPublishedReferences:refs,...(cap.review?{reviewStage:cap.review.phase.stage,recoveryPlan:maintenancePlanSummary(review)}:{}),currentExternalState:cap.review?'RECHECK_REQUIRED':'PENDING',independentApproval:cap.review?.phase.stage==='APPROVED'?'RECORDED':'PENDING',fieldEnabled:false,businessWritesEnabled:false,activationEnabled:false,productionAcceptance:false};
  }finally{for(const p of [reader,client]){if(['T','E'].includes(p.getTransactionStatus?.()))await p.query('ROLLBACK').catch(()=>{});await closeSourceConnection(p);}}
 },true);
}
export function fieldPublicAuth(auth){const {clientSecret:_secret,...publicConfig}=auth;return publicConfig;}
