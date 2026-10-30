import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {verifyColdMaterialSqlCohortV1 as verify} from '../scripts/cold-registration-sql-cohort-v1.mjs';
import {reviewSourceHashV1 as hash} from '../scripts/workflow-review-source-facts-v1.mjs';
import {assertColdOwnedReviewSessionBindingV1} from '../scripts/cold-owned-review-session-v3.mjs';
import {assertColdRegistrationCoreMaterialsV6} from '../scripts/cold-registration-core-materials-v6.mjs';
const timestamp=seconds=>new Date(Date.parse('2026-01-01T00:00:00.000Z')+seconds*1000).toISOString();
function fixture(){
 const db=(databaseOid,tenantId=null)=>({databaseOid,database:'qa_'+databaseOid,sqlFacts:{sha256:hash(databaseOid),relations:tenantId===null?[{schema:'public',name:'auth_state'}]:[]},...(tenantId===null?{}:{map:{tenantId}})});
 const databases=[db('10'),db('11','acme'),db('12','sandbox')],source={controlId:'12345678-1234-4234-8234-123456789abc',fullFacts:{sha256:hash('full-source'),databases}};
 const binding={controlId:source.controlId,sourceHash:hash(source),sourceInventorySha256:hash('inventory'),recoveryId:'12345678-1234-4234-8234-123456789abd',intentSha256:hash('intent')};
 const files={binding:structuredClone(binding),materialMac:hash('private-owner-mac'),capturedAt:timestamp(1),expiresAt:timestamp(31)},fullFactsCheck={sourceFullFactsSha256:source.fullFacts.sha256,databases:databases.map(({databaseOid})=>({databaseOid}))};
 const peer=name=>({format:'COLD_OWNED_REVIEW_PEERS_VERIFIED_V1',recoveryId:binding.recoveryId,intentSha256:binding.intentSha256,guardCount:2,readerCount:4,evidenceFile:resolve('work/unit-'+name+'.private.json'),evidenceSha256:hash(name)});
 const member=(database,key,start,end)=>({binding:structuredClone(binding),coreMaterialMac:files.materialMac,originalProfileStagedInsideRolledBackTransaction:true,reviewProfileRestored:true,callerFullSevenDatabaseSqlFactsCompared:true,callerFullFactsCheckSha256:hash(fullFactsCheck),verifiedFrom:timestamp(start),verifiedAt:timestamp(end),[key]:{databaseOid:database.databaseOid,sourceSqlFactsSha256:database.sqlFacts.sha256,sha256:hash(key+database.databaseOid)}});
 return{source,binding,files,fullFactsCheck,before:{proof:peer('before'),startedAt:timestamp(0),completedAt:timestamp(0.5)},after:{proof:peer('after'),notBefore:timestamp(10),completedAt:timestamp(11)},authenticationSql:member(databases[0],'authenticationSql',2,3),authenticationAuditSql:member(databases[0],'authenticationAuditSql',4,5),queueSql:[{...member(databases[1],'queueSql',6,7),tenantId:'acme'},{...member(databases[2],'queueSql',8,9),tenantId:'sandbox'}]};
}
const rejected=mutate=>{const value=fixture();mutate(value);assert.throws(()=>verify(value),error=>error.code==='COLD_MATERIAL_SQL_COHORT_INVALID'&&error.message===error.code);};
test('one descriptive original-peer bracket covers both authentication namespaces and every configured map without runtime authority',()=>{
 const value=fixture(),before=structuredClone(value),result=verify(value),{sha256,...body}=result;assert.equal(hash(body),sha256);assert.equal(result.namespaceCount,4);assert.equal(result.databaseCount,3);assert.deepEqual(result.namespaces.map(row=>row.kind),['AUTHENTICATION','AUTHENTICATION_AUDIT','QUEUES','QUEUES']);assert.deepEqual(value,before);
 for(const key of ['runtimeSessionCapabilityGranted','fullDatabaseSqlFactsComparedHere','rawSqlRowsIndependentlyDecryptedHere','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'])assert.equal(result[key],false);
});
test('omitted, repeated, foreign-tenant or foreign-database namespaces cannot enter the cohort',()=>{
 for(const mutate of [v=>v.queueSql.pop(),v=>v.queueSql[1]=structuredClone(v.queueSql[0]),v=>v.queueSql[1].tenantId='other',v=>v.queueSql[0].queueSql.databaseOid='99',v=>v.authenticationAuditSql=undefined])rejected(mutate);
});
test('every SQL interval is inside both the shared original-peer bracket and the unchanged material window',()=>{
 for(const mutate of [v=>v.authenticationSql.verifiedFrom=timestamp(0.75),v=>v.authenticationSql.verifiedFrom=timestamp(0),v=>v.queueSql[1].verifiedAt=timestamp(11),v=>v.queueSql[0].verifiedAt=timestamp(5),v=>v.queueSql[1].verifiedFrom=timestamp(6.5)])rejected(mutate);
});
test('material deadlines cannot be extended, restarted after SQL or replaced by a future witness',()=>{
 for(const mutate of [v=>v.files.expiresAt=timestamp(61),v=>{v.files.capturedAt=timestamp(4);v.files.expiresAt=timestamp(34);},v=>v.after.completedAt=timestamp(31),v=>v.before.completedAt=timestamp(1.5),v=>v.after.notBefore=timestamp(12)])rejected(mutate);
});
test('foreign recovery, altered intent, missing guards and relative peer evidence reject',()=>{
 for(const mutate of [v=>v.after.proof.recoveryId='different',v=>v.before.proof.intentSha256=hash('different'),v=>v.after.proof.guardCount=1,v=>v.after.proof.readerCount=2,v=>v.before.proof.evidenceFile='relative.json',v=>v.after.proof.evidenceFile=v.before.proof.evidenceFile])rejected(mutate);
});
test('all namespace results must bind the same material owner, captured SQL source and complete caller facts',()=>{
 for(const mutate of [v=>v.authenticationSql.coreMaterialMac=hash('other'),v=>v.authenticationAuditSql.authenticationAuditSql.sourceSqlFactsSha256=hash('other'),v=>v.queueSql[0].callerFullFactsCheckSha256=hash('other'),v=>v.binding.sourceHash=hash('other')])rejected(mutate);
});
test('unrestored profiles, missing full-database caller checks and caller approval flags fail closed',()=>{
 for(const mutate of [v=>v.authenticationSql.reviewProfileRestored=false,v=>v.queueSql[1].originalProfileStagedInsideRolledBackTransaction=false,v=>v.authenticationAuditSql.callerFullSevenDatabaseSqlFactsCompared=false,v=>v.approved=true,v=>v.execute=()=>true])rejected(mutate);
});
test('a serialized cohort descriptor does not recreate a live session or a material verification owner',()=>{
 const value=fixture(),result=verify(value);assert.throws(()=>assertColdOwnedReviewSessionBindingV1(result,{trust:{},recoveryId:value.binding.recoveryId}),/COLD_OWNED_SESSION_NOT_MINTED/);assert.throws(()=>assertColdRegistrationCoreMaterialsV6(result,value.binding),/COLD_REGISTRATION_CORE_OWNER/);
});
