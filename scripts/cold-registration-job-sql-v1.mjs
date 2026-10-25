import pg from 'pg';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {inspectGovernanceJobCatalogV4} from '../server/governance-job-catalog-v4.ts';
import {inspectMaintenanceJobCatalogV4} from '../server/maintenance-job-catalog-v4.ts';
import {inspectPredictiveJobCatalogV4} from '../server/predictive-job-catalog-v4.ts';
import {inspectPredictiveCancelJobCatalogV1} from '../server/predictive-cancel-job-catalog-v1.ts';
import {validateKeyRing} from '../server/auth-state.ts';
import {inspectColdRegistrationJobCellsV1,inspectColdRegistrationAuxiliaryJobGrantV1} from './cold-registration-job-cells-v1.mjs';
import {captureColdReviewSqlFactsV1,assertColdReviewSqlFactsV1,validateColdReviewSqlFactsV1} from './cold-review-sql-facts-v2.mjs';
import {coldReviewInventoryV3} from './runtime-cold-review-target-v9.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});},exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),same=(a,b)=>canonical(a)===canonical(b);
const kinds={GOVERNANCE:{schema:'governance_jobs_v4',inspect:inspectGovernanceJobCatalogV4},MAINTENANCE:{schema:'maintenance_jobs_v4',inspect:inspectMaintenanceJobCatalogV4},PREDICTIVE:{schema:'predictive_jobs_v4',inspect:inspectPredictiveJobCatalogV4},RECONCILIATION:{schema:'reconciliation_jobs_v1',inspect:inspectPredictiveCancelJobCatalogV1}};
const expectedCells=['governance_jobs_v4.jobs.sealed_command','governance_jobs_v4.jobs.sealed_grant','maintenance_jobs_v4.jobs.sealed_command','maintenance_jobs_v4.jobs.sealed_grant','maintenance_jobs_v4.flows.sealed_grant','predictive_jobs_v4.jobs.sealed_command','predictive_jobs_v4.jobs.sealed_grant','predictive_jobs_v4.jobs.retry_grant','reconciliation_jobs_v1.jobs.sealed_command','reconciliation_jobs_v1.jobs.sealed_grant','reconciliation_jobs_v1.authorities.sealed_grant'].sort();
function row(kind,j){
 need(j&&typeof j==='object','COLD_REGISTRATION_JOB_SQL_JOIN');const r={id:j.id,tenantId:j.tenant,actorId:j.actor_id,action:j.action,requestHash:j.request_hash,sealedCommand:j.sealed_command,sealedGrant:j.sealed_grant,grantRevision:String(j.grant_revision),grantUntil:j.grant_until};
 if(kind==='RECONCILIATION')Object.assign(r,{caseId:j.case_id,operationId:j.operation_id,domainHash:j.domain_hash});else Object.assign(r,{commandId:j.command_id,businessKey:j.business_key});
 if(kind==='PREDICTIVE')Object.assign(r,{retryId:j.retry_id,retryActor:j.retry_actor,sealedRetryGrant:j.retry_grant,retryUntil:j.retry_until});return r;
}
function integerJson(value){
 // JSON bigint parsing must retain the exact SQL decimal identity. Never round a grant revision.
 need(typeof value==='string'&&Buffer.byteLength(value)<=64*1024**2,'COLD_REGISTRATION_JOB_SQL_ROW_LIMIT');return JSON.parse(value);
}
const projection=alias=>"(to_jsonb("+alias+")||jsonb_build_object('grant_revision',"+alias+".grant_revision::text))::text";

/** Caller owns the real root transaction and the temporary ORIGINAL catalog profile.
 * Inspects all four queue namespaces in this one captured map database, including expired rows.
 * No SQL COMMIT, queue claim, authorization refresh, identity lookup or new connection. */
export async function verifyColdRegistrationJobSqlV1(client,options){
 let point=null,problem,result;const output=[];
 try{
  need(client instanceof pg.Client&&client.getTransactionStatus()==='T'&&exact(options,['baseline','originalInventory','targetDirectory','members']),'COLD_REGISTRATION_JOB_SQL_TRANSACTION');
  const {baseline,originalInventory,targetDirectory,members}=options;validateColdReviewSqlFactsV1(baseline);need(typeof targetDirectory==='string'&&resolve(targetDirectory)===targetDirectory&&originalInventory.identity.system_id===baseline.identity.systemIdentifier&&originalInventory.identity.control_oid===baseline.identity.controlOid,'COLD_REGISTRATION_JOB_SQL_BINDING');
  need(Array.isArray(members)&&members.length===4&&new Set(members.map(m=>m?.kind)).size===4&&members.every(m=>exact(m,['kind','binding','ring'])&&Object.hasOwn(kinds,m.kind)&&m.binding?.databaseOid===baseline.identity.databaseOid)&&new Set(members.map(m=>m.binding.tenantId)).size===1,'COLD_REGISTRATION_JOB_SQL_COVERAGE');
  const isolation=(await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation;need(['repeatable read','serializable'].includes(isolation),'COLD_REGISTRATION_JOB_SQL_SNAPSHOT');const inventory=structuredClone(originalInventory);inventory.identity.directory=targetDirectory;need(same(await coldReviewInventoryV3(client,targetDirectory),inventory),'COLD_REGISTRATION_JOB_SQL_ORIGINAL_PROFILE');
  assertColdReviewSqlFactsV1(await captureColdReviewSqlFactsV1(client,baseline.identity),baseline);point='registration_job_'+randomUUID().replaceAll('-','');await client.query('SAVEPOINT '+point);
  const columns=(await client.query("SELECT n.nspname||'.'||c.relname||'.'||a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped AND (a.attname LIKE 'sealed%' OR a.attname='retry_grant') ORDER BY 1",[Object.values(kinds).map(k=>k.schema)])).rows.map(r=>r.name);need(same(columns.sort(),expectedCells),'COLD_REGISTRATION_JOB_SQL_ENCRYPTED_COLUMNS');
  const facts=(schema,name)=>{const f=baseline.relations.find(r=>r.schema===schema&&r.name===name);need(f&&f.kind==='r'&&Number.isSafeInteger(f.rows),'COLD_REGISTRATION_JOB_SQL_SOURCE_TABLE');return f;};
  const cursor=async(sql,expected,visit)=>{const name='registration_job_rows_'+randomUUID().replaceAll('-','');let rows=0,batches=0;await client.query('DECLARE '+name+' NO SCROLL CURSOR FOR '+sql);try{for(;;){const batch=(await client.query('FETCH FORWARD 32 FROM '+name)).rows;if(!batch.length)break;batches++;for(const row of batch){need(++rows<=expected,'COLD_REGISTRATION_JOB_SQL_ROW_COVERAGE');await visit(row);}}await client.query('CLOSE '+name);need(rows===expected,'COLD_REGISTRATION_JOB_SQL_ROW_COVERAGE');return{rows,batches};}catch(e){throw e;}};
  for(const m of [...members].sort((a,b)=>a.kind.localeCompare(b.kind))){
   const {schema,inspect}=kinds[m.kind],binding=m.binding;validateKeyRing(m.ring);need(await inspect(client)===binding.catalogHash,'COLD_REGISTRATION_JOB_SQL_CATALOG');
   const metadata=(await client.query('SELECT * FROM '+schema+'._meta')).rows;need(metadata.length===1&&metadata[0].tenant===binding.tenantId&&metadata[0].deployment===binding.deployment&&String(metadata[0].worker_oid)===binding.roleOid,'COLD_REGISTRATION_JOB_SQL_META');
   const identities=[metadata[0].owner_oid,metadata[0].worker_oid,metadata[0].ingress_oid].map(String);need(new Set(identities).size===3&&identities.every(id=>originalInventory.roles.some(r=>r.oid===id))&&facts(schema,'_ctx').rows===0,'COLD_REGISTRATION_JOB_SQL_ROLES');
   let encryptedCells=0,retryCells=0,expiredGrants=0;const keyIds=new Set();
   const jobs=await cursor('SELECT '+projection('j')+' AS job FROM '+schema+'.jobs j ORDER BY j.ordinal',facts(schema,'jobs').rows,async v=>{const proof=inspectColdRegistrationJobCellsV1({kind:m.kind,binding,ring:m.ring,row:row(m.kind,integerJson(v.job))});encryptedCells+=proof.encryptedCells;retryCells+=proof.retryCells;expiredGrants+=Number(proof.expiredOriginalGrantPreserved)+Number(proof.expiredRetryGrantPreserved);for(const id of proof.keyIdsUsed)keyIds.add(id);});
   let auxiliary={rows:0,batches:0};if(['MAINTENANCE','RECONCILIATION'].includes(m.kind)){
    const table=m.kind==='MAINTENANCE'?'flows':'authorities';auxiliary=await cursor('SELECT '+projection('j')+" AS job,(to_jsonb(a)||jsonb_build_object('grant_revision',a.grant_revision::text))::text AS auxiliary FROM "+schema+'.'+table+' a LEFT JOIN '+schema+'.jobs j ON j.id=a.job_id ORDER BY a.tenant,a.'+(m.kind==='MAINTENANCE'?'command_id':'operation_id'),facts(schema,table).rows,async v=>{const job=row(m.kind,integerJson(v.job)),a=integerJson(v.auxiliary),grant={tenantId:a.tenant,jobId:a.job_id,actorId:a.actor_id,revision:a.grant_revision,until:a.grant_until,sealed:a.sealed_grant};if(m.kind==='MAINTENANCE')grant.commandId=a.command_id;else Object.assign(grant,{caseId:a.case_id,operationId:a.operation_id,sessionHash:a.session_hash});const proof=inspectColdRegistrationAuxiliaryJobGrantV1({kind:m.kind,binding,ring:m.ring,job,grant});encryptedCells++;expiredGrants+=Number(proof.expiredGrantPreserved);keyIds.add(proof.keyId);});
   }
   need(await inspect(client)===binding.catalogHash,'COLD_REGISTRATION_JOB_SQL_CATALOG');output.push({kind:m.kind,tenantId:binding.tenantId,databaseOid:binding.databaseOid,catalogHash:binding.catalogHash,jobs,auxiliary,encryptedCells,retryCells,expiredGrantsPreserved:expiredGrants,keyIdsUsed:keyIds.size,allCapturedCellsDecrypted:true,emptyQueueProvesKeyPossession:false});
  }
  result={format:'COLD_REGISTRATION_JOB_SQL_EVIDENCE_V1',scope:'FOUR_QUEUES_IN_ONE_CAPTURED_MAP_DATABASE',databaseOid:baseline.identity.databaseOid,sourceSqlFactsSha256:baseline.sha256,members:output,encryptedColumns:expectedCells.length,everyCapturedQueueRowIncludingTerminalAndExpiredInspected:true,callerOwnsTransaction:true,rootSessionRestorationVerified:false,completeSqlFactsUnchanged:false,queueRolePasswordAuthenticated:false,currentAuthorizationVerified:false,allEncryptedApplicationStateVerified:false,completeDeploymentMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 }catch(e){problem=Object.assign(Error('COLD_REGISTRATION_JOB_SQL_UNVERIFIABLE'),{code:'COLD_REGISTRATION_JOB_SQL_UNVERIFIABLE'});}finally{
  if(point){try{need(['T','E'].includes(client.getTransactionStatus()),'COLD_REGISTRATION_JOB_SQL_TRANSACTION_ENDED');await client.query('ROLLBACK TO SAVEPOINT '+point);await client.query('RELEASE SAVEPOINT '+point);const root=(await client.query('SELECT session_user::regrole::oid::text AS session_oid,current_user::regrole::oid::text AS current_oid')).rows[0];need(root.session_oid===options.baseline.identity.controlOid&&root.current_oid===root.session_oid,'COLD_REGISTRATION_JOB_SQL_ROOT');}catch{problem=Object.assign(Error('COLD_REGISTRATION_JOB_SQL_ROOT_RESTORATION_UNPROVEN'),{code:'COLD_REGISTRATION_JOB_SQL_ROOT_RESTORATION_UNPROVEN'});}}
 }
 if(problem)throw problem;
 try{assertColdReviewSqlFactsV1(await captureColdReviewSqlFactsV1(client,options.baseline.identity),options.baseline);const expected=structuredClone(options.originalInventory);expected.identity.directory=options.targetDirectory;need(same(await coldReviewInventoryV3(client,options.targetDirectory),expected),'COLD_REGISTRATION_JOB_SQL_PROFILE_CHANGED');result.rootSessionRestorationVerified=true;result.completeSqlFactsUnchanged=true;return{...result,sha256:hash(result)};}catch{throw Object.assign(Error('COLD_REGISTRATION_JOB_SQL_POSTCHECK_UNVERIFIABLE'),{code:'COLD_REGISTRATION_JOB_SQL_POSTCHECK_UNVERIFIABLE'});}
}
