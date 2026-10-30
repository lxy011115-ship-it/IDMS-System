import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyColdMaterialSqlCohortV4 as verify} from '../scripts/cold-registration-sql-cohort-v4.mjs';
import {describeColdDatabaseRolePrivilegesV1} from '../scripts/cold-registration-database-role-privileges-v1.mjs';
import {readRuntimeColdReviewWithFieldSourceV2} from '../scripts/runtime-cold-readonly-control-v7.mjs';
import {reviewSourceHashV1 as hash} from '../scripts/workflow-review-source-facts-v1.mjs';
import {assertColdOwnedReviewSessionBindingV1} from '../scripts/cold-owned-review-session-v3.mjs';
const bytes=await readFile('work/ccf-native-v6-20261026/a1e9ccb7f4c7/verification.json');assert.equal(createHash('sha256').update(bytes).digest('hex'),'8b2be428e1262fb863231ea58b7bfff6cb35bcf8faaa1d749680ac8de90f75f5');
const cases=JSON.parse(bytes).fieldCurrentMaterialsNative.cases,vectors=[];
for(const item of cases){
  const source=(await readRuntimeColdReviewWithFieldSourceV2(item.trust)).source,v=item.coreFieldReview,description=describeColdDatabaseRolePrivilegesV1(source);
  // Synthetic decisions added to immutable original intervals for contract testing only.
  // Actual current SQL is exercised separately; this fixture grants no runtime authority.
  const body={format:'COLD_REGISTRATION_DATABASE_ROLE_PRIVILEGES_V2',sourceHash:item.trust.sourceHash,systemIdentifier:source.inventory.identity.system_id,controlOid:source.inventory.identity.control_oid,verifiedFrom:v.coreConfiguredRoleCredentials.verifiedAt,verifiedAt:v.coreConfiguredRoleCredentials.verifiedAt,scope:'DATABASE_CONNECT_CREATE_TEMP_AND_GRANT_OPTIONS',registeredRoleCount:29,registeredDatabaseCount:7,roleDatabasePairs:203,individualPrivilegesChecked:1218,expectedPrivilegesSha256:hash(description.pairs),actualPrivilegesSha256:hash(description.pairs),actualPrivilegeDecisions:description.pairs.flatMap(pair=>Object.entries(pair.privileges).map(([privilege,granted])=>({role_oid:pair.roleOid,database_oid:pair.databaseOid,privilege,granted}))),allRegisteredReviewAttributesAndMembershipsMatched:true,allRegisteredDatabasePrivilegesMatched:true,callerOwnsReadOnlyTransaction:true,fullRegisteredRoleMatrixVerified:false,authorizationGranted:false};
  vectors.push({source,binding:v.coreMaterialEvidence.binding,files:v.coreMaterialEvidence.files,fullFactsCheck:v.fullFactsCheck,before:v.coreSqlPeerCohort.before,after:v.coreSqlPeerCohort.after,authenticationSql:v.coreAuthenticationSql,authenticationAuditSql:v.coreAuthenticationAuditSql,queueSql:v.coreQueueSql,configuredRoleCredentials:v.coreConfiguredRoleCredentials,retiredBackupPrivileges:v.retiredBackupPrivileges,roleResponsibilities:v.coreMaterialEvidence.roleResponsibilities,registeredDatabasePrivileges:{...body,sha256:hash(body)}});
}
function rehash(proof){const {sha256,...body}=proof;proof.sha256=hash(body);}
function reject(mutate){for(const original of vectors){const input=structuredClone(original);mutate(input);if(input.registeredDatabasePrivileges)rehash(input.registeredDatabasePrivileges);assert.throws(()=>verify(input),error=>error.code==='COLD_MATERIAL_SQL_COHORT_INVALID');}}

test('both original branches bind 1218 synthetic decisions after all seven existing scopes without making a capability',()=>{
  for(const input of vectors){const before=structuredClone(input),result=verify(input),{sha256,...body}=result;assert.equal(sha256,hash(body));assert.equal(result.namespaceCount,8);assert.equal(result.databaseCount,5);assert.equal(result.registeredDatabasePrivilegePairs,203);assert.equal(result.registeredDatabasePrivilegeDecisions,1218);assert.equal(result.namespaces.at(-1).kind,'DATABASE_ROLE_PRIVILEGES');assert.equal(result.runtimeSessionCapabilityGranted,false);assert.deepEqual(input,before);assert.throws(()=>assertColdOwnedReviewSessionBindingV1(result,{trust:{},recoveryId:input.binding.recoveryId}));}
});
test('omitted duplicated foreign and rehashed forged decisions reject',()=>{
  for(const mutate of [v=>v.registeredDatabasePrivileges.actualPrivilegeDecisions.pop(),v=>v.registeredDatabasePrivileges.actualPrivilegeDecisions[1]=structuredClone(v.registeredDatabasePrivileges.actualPrivilegeDecisions[0]),v=>v.registeredDatabasePrivileges.actualPrivilegeDecisions[0].role_oid='999999',v=>v.registeredDatabasePrivileges.actualPrivilegeDecisions[0].database_oid='999999',v=>v.registeredDatabasePrivileges.actualPrivilegeDecisions[0].granted=!v.registeredDatabasePrivileges.actualPrivilegeDecisions[0].granted,v=>v.registeredDatabasePrivileges.actualPrivilegeDecisions[0].privilege='UNKNOWN'])reject(mutate);
});
test('foreign source, system, controller and incomplete count cannot enter the cohort',()=>{
  for(const mutate of [v=>v.registeredDatabasePrivileges.sourceHash='0'.repeat(64),v=>v.registeredDatabasePrivileges.systemIdentifier='9999999999999999999',v=>v.registeredDatabasePrivileges.controlOid='99',v=>v.registeredDatabasePrivileges.registeredRoleCount=28,v=>v.registeredDatabasePrivileges.registeredDatabaseCount=6,v=>v.registeredDatabasePrivileges.roleDatabasePairs=202,v=>v.registeredDatabasePrivileges.individualPrivilegesChecked=1217])reject(mutate);
});
test('the new scope cannot overlap earlier SQL or escape the unchanged original deadline',()=>{
  for(const mutate of [v=>v.registeredDatabasePrivileges.verifiedFrom=v.files.capturedAt,v=>v.registeredDatabasePrivileges.verifiedAt=v.after.completedAt,v=>v.registeredDatabasePrivileges.verifiedAt=v.files.expiresAt,v=>v.files.expiresAt=new Date(Date.parse(v.files.capturedAt)+60000).toISOString()])reject(mutate);
});
test('false read-only context and added authorization or full-matrix claims reject',()=>{
  for(const mutate of [v=>v.registeredDatabasePrivileges.callerOwnsReadOnlyTransaction=false,v=>v.registeredDatabasePrivileges.allRegisteredDatabasePrivilegesMatched=false,v=>v.registeredDatabasePrivileges.allRegisteredReviewAttributesAndMembershipsMatched=false,v=>v.registeredDatabasePrivileges.authorizationGranted=true,v=>v.registeredDatabasePrivileges.fullRegisteredRoleMatrixVerified=true])reject(mutate);
});
