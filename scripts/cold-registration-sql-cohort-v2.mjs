import {canonical} from '../server/imports.ts';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {isAbsolute,resolve} from 'node:path';

const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const same=(a,b)=>canonical(a)===canonical(b),hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const need=(value,condition='CONTRACT')=>{if(!value)throw Object.assign(Error('COLD_MATERIAL_SQL_COHORT_INVALID'),{cohortCondition:condition});};
const time=value=>{const parsed=Date.parse(value);need(typeof value==='string'&&Number.isFinite(parsed)&&new Date(parsed).toISOString()===value,'TIMESTAMP');return parsed;};

/** Descriptive evidence only. Does not mint an owned session, read SQL or grant admission.
 * The coordinator supplies only its own original-session calls and completed SQL results;
 * an independent verifier must authenticate both peer files and each namespace proof. */
export function verifyColdMaterialSqlCohortV2(input){
 let timeline=null;
 try{
  need(exact(input,['source','binding','files','fullFactsCheck','before','after','authenticationSql','authenticationAuditSql','queueSql']));
  const {source,binding,files,fullFactsCheck,before,after,authenticationSql,authenticationAuditSql,queueSql}=input;
  need(exact(binding,['controlId','sourceHash','sourceInventorySha256','recoveryId','intentSha256'])&&[binding.sourceHash,binding.sourceInventorySha256,binding.intentSha256].every(hex));
  need(source.controlId===binding.controlId&&hash(source)===binding.sourceHash&&same(files.binding,binding)&&hex(files.materialMac));
  need(fullFactsCheck.sourceFullFactsSha256===source.fullFacts.sha256&&fullFactsCheck.databases.length===source.fullFacts.databases.length);
  need(exact(before,['proof','startedAt','completedAt'])&&exact(after,['proof','notBefore','completedAt']));
  const from=time(before.startedAt),beforeAt=time(before.completedAt),captured=time(files.capturedAt),expires=time(files.expiresAt),afterFrom=time(after.notBefore),afterAt=time(after.completedAt);
  timeline={coreWindowMs:expires-captured,elapsedToFirstCaptureStartMs:afterFrom-captured,elapsedToFirstCaptureEndMs:afterAt-captured,sharedBeforeCompletedToCoreCaptureMs:captured-beforeAt,beforeIntervalMs:beforeAt-from,captureIntervalMs:afterAt-afterFrom};
  need(from<=beforeAt&&beforeAt<=captured,'BEFORE_ORDER');need(expires-captured===30000,'ORIGINAL_WINDOW');need(captured<=afterFrom&&afterFrom<=afterAt,'AFTER_ORDER');need(afterAt<expires,'AFTER_EXPIRED');
  const maps=source.fullFacts.databases.filter(database=>database.map),auth=source.fullFacts.databases.filter(database=>database.sqlFacts.relations.some(relation=>relation.schema==='public'&&relation.name==='auth_state'));
  need(auth.length===1&&maps.length>0&&maps.length<=32&&new Set(maps.map(database=>database.map.tenantId)).size===maps.length);
  for(const peer of [before.proof,after.proof])need(peer?.format==='COLD_OWNED_REVIEW_PEERS_VERIFIED_V1'&&peer.recoveryId===binding.recoveryId&&peer.intentSha256===binding.intentSha256&&peer.guardCount===maps.length&&Number.isSafeInteger(peer.readerCount)&&peer.readerCount>0&&hex(peer.evidenceSha256)&&typeof peer.evidenceFile==='string'&&peer.evidenceFile.length<=4096&&isAbsolute(peer.evidenceFile)&&resolve(peer.evidenceFile)===peer.evidenceFile&&!/[\u0000-\u001f\u007f]/.test(peer.evidenceFile));
  need(before.proof.readerCount===after.proof.readerCount&&before.proof.evidenceFile!==after.proof.evidenceFile);
  need(Array.isArray(queueSql)&&queueSql.length===maps.length&&new Set(queueSql.map(queue=>queue.tenantId)).size===maps.length);
  const entries=[];
  function member(kind,value,database,sql,tenantId=null){
   need(value&&same(value.binding,binding)&&value.coreMaterialMac===files.materialMac&&value.originalProfileStagedInsideRolledBackTransaction===true&&value.reviewProfileRestored===true&&value.callerFullSevenDatabaseSqlFactsCompared===true&&value.callerFullFactsCheckSha256===hash(fullFactsCheck));
   need(sql?.databaseOid===database.databaseOid&&sql.sourceSqlFactsSha256===database.sqlFacts.sha256&&hex(sql.sha256));
   const start=time(value.verifiedFrom),end=time(value.verifiedAt);need(beforeAt<=start&&captured<=start&&start<=end&&end<=afterFrom&&end<expires,'MEMBER_INTERVAL');
   entries.push({kind,...(tenantId===null?{}:{tenantId}),databaseOid:database.databaseOid,sourceSqlFactsSha256:database.sqlFacts.sha256,sqlEvidenceSha256:sql.sha256,verifiedFrom:value.verifiedFrom,verifiedAt:value.verifiedAt,originalProfileStagedInsideRolledBackTransaction:true,reviewProfileRestored:true});
  }
  member('AUTHENTICATION',authenticationSql,auth[0],authenticationSql?.authenticationSql);
  member('AUTHENTICATION_AUDIT',authenticationAuditSql,auth[0],authenticationAuditSql?.authenticationAuditSql);
  for(const database of [...maps].sort((a,b)=>a.map.tenantId.localeCompare(b.map.tenantId))){const value=queueSql.find(queue=>queue.tenantId===database.map.tenantId);need(value);member('QUEUES',value,database,value.queueSql,database.map.tenantId);}
  for(let index=1;index<entries.length;index++)need(time(entries[index].verifiedFrom)>=time(entries[index-1].verifiedAt),'MEMBER_ORDER');
  const body={format:'COLD_CORE_MATERIAL_SQL_COHORT_V1',binding:structuredClone(binding),coreMaterialMac:files.materialMac,sourceFullFactsSha256:source.fullFacts.sha256,fullFactsCheckSha256:hash(fullFactsCheck),before:structuredClone(before),after:structuredClone(after),namespaces:entries,namespaceCount:entries.length,databaseCount:new Set(entries.map(entry=>entry.databaseOid)).size,completeNamespaceProofCoverageVerified:true,allSqlIntervalsInsideOriginalPeerBracket:true,allSqlIntervalsInsideUnextendedFileWindow:true,callerFullDatabaseCheckRequired:true,fullDatabaseSqlFactsComparedHere:false,rawSqlRowsIndependentlyDecryptedHere:false,runtimeSessionCapabilityGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
  return{...body,sha256:hash(body)};
 }catch(error){const condition=['CONTRACT','TIMESTAMP','BEFORE_ORDER','ORIGINAL_WINDOW','AFTER_ORDER','AFTER_EXPIRED','MEMBER_INTERVAL','MEMBER_ORDER'].includes(error?.cohortCondition)?error.cohortCondition:'CONTRACT';const safeSqlCohortFailure={format:'COLD_SQL_COHORT_SAFE_FAILURE_V1',condition,timeline,privatePathsOrCredentialsIncluded:false};throw Object.assign(Error('COLD_MATERIAL_SQL_COHORT_INVALID'),{code:'COLD_MATERIAL_SQL_COHORT_INVALID',safeSqlCohortFailure});}
}
