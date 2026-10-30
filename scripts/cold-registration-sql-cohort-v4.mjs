import {verifyColdMaterialSqlCohortV3} from './cold-registration-sql-cohort-v3.mjs';
import {describeColdDatabaseRolePrivilegesV1} from './cold-registration-database-role-privileges-v1.mjs';
import {canonical} from '../server/imports.ts';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const need=value=>{if(!value)throw Error('COLD_DATABASE_ROLE_COHORT_INVALID');};
const same=(a,b)=>canonical(a)===canonical(b);
const time=value=>{need(typeof value==='string'&&new Date(Date.parse(value)).toISOString()===value);return Date.parse(value);};

/** Adds actual database-role decisions to the original shared bracket; never creates a session or authorization. */
export function verifyColdMaterialSqlCohortV4(input){
  try{
    const {registeredDatabasePrivileges:proof,...parent}=input,base=verifyColdMaterialSqlCohortV3(parent),{source,binding,files}=parent,expected=describeColdDatabaseRolePrivilegesV1(source);
    need(proof?.format==='COLD_REGISTRATION_DATABASE_ROLE_PRIVILEGES_V2');const {sha256,...body}=proof;need(sha256===hash(body));
    need(proof.sourceHash===binding.sourceHash&&proof.systemIdentifier===source.inventory.identity.system_id&&proof.controlOid===source.inventory.identity.control_oid&&proof.scope==='DATABASE_CONNECT_CREATE_TEMP_AND_GRANT_OPTIONS');
    need(proof.callerOwnsReadOnlyTransaction===true&&proof.allRegisteredReviewAttributesAndMembershipsMatched===true&&proof.allRegisteredDatabasePrivilegesMatched===true&&proof.fullRegisteredRoleMatrixVerified===false&&proof.authorizationGranted===false);
    need(proof.registeredRoleCount===expected.registeredRoles&&proof.registeredDatabaseCount===expected.registeredDatabases&&proof.roleDatabasePairs===expected.pairs.length&&proof.individualPrivilegesChecked===expected.pairs.length*6);
    need(proof.expectedPrivilegesSha256===hash(expected.pairs)&&proof.actualPrivilegesSha256===proof.expectedPrivilegesSha256&&Array.isArray(proof.actualPrivilegeDecisions)&&proof.actualPrivilegeDecisions.length===expected.pairs.length*6);
    const pairs=new Map(expected.pairs.map(row=>[row.roleOid+':'+row.databaseOid,{expected:row.privileges,actual:{}}]));
    for(const row of proof.actualPrivilegeDecisions){need(row&&Object.keys(row).sort().join(',')==='database_oid,granted,privilege,role_oid');const slot=pairs.get(row.role_oid+':'+row.database_oid);need(slot&&Object.hasOwn(slot.expected,row.privilege)&&!Object.hasOwn(slot.actual,row.privilege)&&typeof row.granted==='boolean');slot.actual[row.privilege]=row.granted;}
    for(const slot of pairs.values())need(same(slot.expected,slot.actual));
    const start=time(proof.verifiedFrom),end=time(proof.verifiedAt),last=base.namespaces.at(-1);need(start>=time(last.verifiedAt)&&start>=time(files.capturedAt)&&start>=time(base.before.completedAt)&&start<=end&&end<=time(base.after.notBefore)&&end<time(files.expiresAt));
    const entry={kind:'DATABASE_ROLE_PRIVILEGES',databaseOid:null,controlRoleOid:source.inventory.identity.control_oid,registeredRoleCount:expected.registeredRoles,registeredDatabaseCount:expected.registeredDatabases,roleDatabasePairs:expected.pairs.length,individualPrivilegesChecked:expected.pairs.length*6,sqlEvidenceSha256:hash(proof),verifiedFrom:proof.verifiedFrom,verifiedAt:proof.verifiedAt,callerOwnsReadOnlyTransaction:true};
    const {sha256:baseExtendedSqlCohortSha256,...rest}=base,result={...rest,format:'COLD_CORE_MATERIAL_SQL_COHORT_V3',implementationVersion:4,baseExtendedSqlCohortSha256,namespaces:[...base.namespaces,entry],namespaceCount:base.namespaces.length+1,registeredDatabasePrivilegesInsideOriginalPeerBracket:true,registeredDatabasePrivilegePairs:expected.pairs.length,registeredDatabasePrivilegeDecisions:expected.pairs.length*6};
    return {...result,sha256:hash(result)};
  }catch(error){if(error?.safeSqlCohortFailure)throw error;throw Object.assign(Error('COLD_MATERIAL_SQL_COHORT_INVALID'),{code:'COLD_MATERIAL_SQL_COHORT_INVALID',safeSqlCohortFailure:{format:'COLD_SQL_COHORT_SAFE_FAILURE_V1',condition:'EXTENDED_DATABASE_ROLE_SCOPE',timeline:null,privatePathsOrCredentialsIncluded:false}});}
}
