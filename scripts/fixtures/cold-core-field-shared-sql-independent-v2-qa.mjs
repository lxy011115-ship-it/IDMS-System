import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {verifyColdCoreFieldSharedSqlIndependentQaV1} from './cold-core-field-shared-sql-independent-v1-qa.mjs';
import {verifyColdCoreFieldDatabaseRolesIndependentQaV1} from './cold-core-field-database-role-independent-v1-qa.mjs';
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');

/** Rebuilds the unchanged prior seven-scope descriptor, then independently checks
 * the added real database-role observations. No production cohort code is used. */
export function verifyColdCoreFieldSharedSqlIndependentQaV2(input){
  const {cohort,registeredDatabasePrivileges:proof,...priorInput}=input,{sha256,...whole}=cohort;assert.equal(hash(whole),sha256);assert.equal(cohort.format,'COLD_CORE_MATERIAL_SQL_COHORT_V3');assert.equal(cohort.implementationVersion,4);assert.equal(cohort.namespaceCount,8);assert.equal(cohort.namespaces.length,8);
  const {format,implementationVersion,baseExtendedSqlCohortSha256,registeredDatabasePrivilegesInsideOriginalPeerBracket,registeredDatabasePrivilegePairs,registeredDatabasePrivilegeDecisions,namespaces,namespaceCount,...rest}=whole;
  assert.equal(registeredDatabasePrivilegesInsideOriginalPeerBracket,true);assert.equal(registeredDatabasePrivilegePairs,proof.roleDatabasePairs);assert.equal(registeredDatabasePrivilegeDecisions,proof.individualPrivilegesChecked);
  const previous={...rest,format:'COLD_CORE_MATERIAL_SQL_COHORT_V2',implementationVersion:3,namespaces:namespaces.slice(0,-1),namespaceCount:7};assert.equal(hash(previous),baseExtendedSqlCohortSha256);previous.sha256=baseExtendedSqlCohortSha256;
  const members=[priorInput.authenticationSql,priorInput.authenticationAuditSql,...priorInput.queueSql];for(const member of members)assert.equal(member.sqlPeerCohortSha256,cohort.sha256);
  // The previous descriptor was hashed before the coordinator annotated each
  // member with the final eight-scope hash. Undo only this known annotation on
  // copies when checking the independently rebuilt seven-scope parent.
  const normalized=structuredClone(priorInput);for(const member of [normalized.authenticationSql,normalized.authenticationAuditSql,...normalized.queueSql])member.sqlPeerCohortSha256=previous.sha256;
  const old=verifyColdCoreFieldSharedSqlIndependentQaV1({...normalized,cohort:previous}),databaseRoles=verifyColdCoreFieldDatabaseRolesIndependentQaV1({source:input.source,binding:input.binding,files:input.files,cohort,proof});
  return {...old,format:'COLD_CORE_FIELD_SHARED_SQL_INDEPENDENT_QA_V2',sqlScopeCount:8,databaseRoles,allPriorSevenScopesIndependentlyRebuilt:true};
}
