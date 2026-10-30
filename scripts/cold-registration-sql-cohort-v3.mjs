import {verifyColdMaterialSqlCohortV2} from './cold-registration-sql-cohort-v2.mjs';
import {canonical} from '../server/imports.ts';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const need=value=>{if(!value)throw Error('COLD_MATERIAL_SQL_COHORT_ROLE_SCOPE');};
const same=(a,b)=>canonical(a)===canonical(b),time=value=>{need(typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value);return Date.parse(value);};
const runtimeDuties=new Set(['AUTHENTICATION_RUNTIME','CORE_BUSINESS_HTTP','CORE_BUSINESS_WORKER','CORE_QUEUE_HTTP','CORE_QUEUE_WORKER','WORKFLOW_RUNTIME','WORKFLOW_CANCEL','WORKFLOW_RESERVATION','AUTHENTICATION_DELIVERY_SOURCE','AUTHENTICATION_DELIVERY_TARGET']);

/** Descriptive shared original-peer interval. The coordinator must own the
 * genuine session; this pure result never creates a runtime capability. */
export function verifyColdMaterialSqlCohortV3(input){
  try{
    const {configuredRoleCredentials,retiredBackupPrivileges,roleResponsibilities,...baseInput}=input,base=verifyColdMaterialSqlCohortV2(baseInput),{source,binding,files}=baseInput;
    need(roleResponsibilities?.format==='COLD_REGISTRATION_ROLE_RESPONSIBILITY_DESCRIPTION_V2'&&roleResponsibilities.allRegisteredResponsibilitiesDescribed===true&&roleResponsibilities.uncoveredRoleOids.length===0);
    need(same(roleResponsibilities.rows.map(row=>row.roleOid).sort(),source.inventory.roles.map(role=>role.oid).sort()));
    const expectedRuntime=roleResponsibilities.rows.filter(row=>row.duties.some(duty=>runtimeDuties.has(duty.kind))).map(row=>row.roleOid).sort(),roles=configuredRoleCredentials;
    need(roles?.format==='COLD_REGISTRATION_CONFIGURED_ROLE_CREDENTIALS_V1'&&same(roles.binding,binding)&&roles.coreMaterialMac===files.materialMac&&roles.allConfiguredRuntimePasswordsMatched===true&&roles.allRegisteredReviewRoleAttributesAndMembershipsMatched===true&&roles.callerOwnsReadOnlyTransaction===true&&roles.registeredReviewRoleCount===source.inventory.roles.length);
    need(expectedRuntime.length>0&&same(roles.matchedRuntimeRoles.map(row=>row.roleOid).sort(),expectedRuntime));
    for(const row of roles.matchedRuntimeRoles)need(row.bothStoredAndServerKeysMatched===true&&row.actualPgDriverPasswordPreparationUsed===true&&row.sqlConnectionOpened===false&&row.loginOrPrivilegesProven===false);
    const duties=roleResponsibilities.rows.flatMap(row=>row.duties.filter(duty=>duty.kind==='RETIRED_DATABASE_BACKUP').map(duty=>({roleOid:row.roleOid,databaseOid:duty.databaseOid})));
    need(Array.isArray(retiredBackupPrivileges)&&duties.length===source.retired.length&&retiredBackupPrivileges.length===duties.length);
    const seen=new Set(),extra=[];
    const interval=(kind,proof,identity)=>{
      const start=time(proof.verifiedFrom),end=time(proof.verifiedAt);need(start>=time(files.capturedAt)&&start>=time(base.before.completedAt)&&start<=end&&end<=time(base.after.notBefore)&&end<time(files.expiresAt));
      return{kind,...identity,sqlEvidenceSha256:hash(proof),verifiedFrom:proof.verifiedFrom,verifiedAt:proof.verifiedAt,callerOwnsReadOnlyTransaction:true};
    };
    for(const proof of retiredBackupPrivileges){
      const slot=proof.roleOid+':'+proof.databaseOid;need(!seen.has(slot));seen.add(slot);
      need(duties.some(duty=>duty.roleOid===proof.roleOid&&duty.databaseOid===proof.databaseOid)&&source.retired.some(row=>row.source.databaseOid===proof.databaseOid));
      need(proof.format==='COLD_RETIRED_BACKUP_CURRENT_PRIVILEGES_V2'&&proof.sourceHash===binding.sourceHash&&proof.callerOwnsReadOnlyTransaction===true&&proof.registeredDatabasePrivilegesChecked===source.inventory.databases.length&&proof.relationsChecked>0);
      for(const key of ['currentRoleClosed','onlyOriginalDatabaseConnectAllowed','actualTableAndColumnWriteDenied','actualSequenceWriteDenied','largeObjectFunctionsDenied','currentBackupReadPrivilegesVerified'])need(proof[key]===true);
      extra.push(interval('RETIRED_BACKUP',proof,{databaseOid:proof.databaseOid,roleOid:proof.roleOid}));
    }
    const roleEntry=interval('ROLE_CREDENTIALS',roles,{databaseOid:null,controlRoleOid:source.inventory.identity.control_oid,registeredRoleCount:source.inventory.roles.length,runtimeRoleCount:expectedRuntime.length});
    const namespaces=[...extra,...base.namespaces,roleEntry];for(let index=1;index<namespaces.length;index++)need(time(namespaces[index].verifiedFrom)>=time(namespaces[index-1].verifiedAt));
    const {sha256:baseSqlCohortSha256,...body}=base;
    const result={...body,format:'COLD_CORE_MATERIAL_SQL_COHORT_V2',implementationVersion:3,baseSqlCohortSha256,namespaces,namespaceCount:namespaces.length,databaseCount:new Set(namespaces.map(row=>row.databaseOid).filter(Boolean)).size,configuredRuntimeRoleCount:expectedRuntime.length,registeredRoleCount:source.inventory.roles.length,retiredBackupProofCount:extra.length,sharedCurrentRoleAndBackupProofsInsideOriginalPeerBracket:true,allActualRoleAndBackupSqlChecksRetained:true};
    return{...result,sha256:hash(result)};
  }catch(error){if(error?.safeSqlCohortFailure)throw error;throw Object.assign(Error('COLD_MATERIAL_SQL_COHORT_INVALID'),{code:'COLD_MATERIAL_SQL_COHORT_INVALID',safeSqlCohortFailure:{format:'COLD_SQL_COHORT_SAFE_FAILURE_V1',condition:'EXTENDED_ROLE_SCOPE',timeline:null,privatePathsOrCredentialsIncluded:false}});}
}
