import pg from 'pg';
import {resolve,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {coldRuntimeInventoryV1} from './runtime-cold-facts-v1.mjs';
import {workflowReviewFrozenInventoryV1,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {describeColdDatabaseRolePrivilegesV1} from './cold-registration-database-role-privileges-v1.mjs';
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const same=(a,b)=>canonical(a)===canonical(b);
const pathKey=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
const checkedPrivileges=['CONNECT','CREATE','TEMP'].flatMap(value=>[value,value+' WITH GRANT OPTION']);

/** Caller retains its actual root pg.Client and read-only transaction. No login, DDL or COMMIT. */
export async function verifyColdRegistrationDatabaseRolePrivilegesV2(client,raw){
  need(client instanceof pg.Client&&client.getTransactionStatus()==='T'&&raw&&Object.getPrototypeOf(raw)===Object.prototype&&Object.keys(raw).sort().join(',')==='source,sourceHash,targetDirectory'&&typeof raw.targetDirectory==='string'&&isAbsolute(raw.targetDirectory),'COLD_DATABASE_ROLES_CONTEXT');
  const verifiedFrom=new Date().toISOString(),source=structuredClone(raw.source),sourceHash=raw.sourceHash,targetDirectory=resolve(raw.targetDirectory);
  need(hash(source)===sourceHash,'COLD_DATABASE_ROLES_SOURCE_HASH');
  const expected=describeColdDatabaseRolePrivilegesV1(source),profile=workflowReviewFrozenInventoryV1(source.inventory,source.readerContract,targetDirectory);
  const settings=(await client.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation,current_user::regrole::oid::text AS current_oid")).rows[0];
  need(settings.readonly==='on'&&['repeatable read','serializable'].includes(settings.isolation)&&settings.current_oid===source.inventory.identity.control_oid,'COLD_DATABASE_ROLES_READONLY_ROOT');
  const inventory=await coldRuntimeInventoryV1(client);
  need(pathKey(inventory.identity.directory)===pathKey(targetDirectory),'COLD_DATABASE_ROLES_DIRECTORY');inventory.identity.directory=targetDirectory;
  for(const role of inventory.roles)if(role.rolvaliduntil instanceof Date)role.rolvaliduntil=role.rolvaliduntil.toISOString();
  need(same(inventory,profile),'COLD_DATABASE_ROLES_REVIEW_PROFILE');
  const rows=(await client.query("SELECT r.oid::text AS role_oid,d.oid::text AS database_oid,p.privilege,has_database_privilege(r.oid,d.oid,p.privilege) AS granted FROM pg_roles r CROSS JOIN pg_database d CROSS JOIN unnest($3::text[]) AS p(privilege) WHERE r.oid=ANY($1::oid[]) AND d.oid=ANY($2::oid[]) ORDER BY r.oid,d.oid,p.privilege",[source.registeredRoleOids,source.inventory.databases.map(value=>value.oid),checkedPrivileges])).rows;
  need(rows.length===expected.pairs.length*checkedPrivileges.length,'COLD_DATABASE_ROLES_ACTUAL_COVERAGE');
  const actual=new Map();
  for(const row of rows){const key=row.role_oid+':'+row.database_oid;need(checkedPrivileges.includes(row.privilege)&&typeof row.granted==='boolean','COLD_DATABASE_ROLES_ACTUAL_ROW');if(!actual.has(key))actual.set(key,{});const rights=actual.get(key);need(!Object.hasOwn(rights,row.privilege),'COLD_DATABASE_ROLES_DUPLICATE_ROW');rights[row.privilege]=row.granted;}
  for(const pair of expected.pairs)need(same(actual.get(pair.roleOid+':'+pair.databaseOid),pair.privileges),'COLD_DATABASE_ROLES_PRIVILEGE_DRIFT');
  need(actual.size===expected.pairs.length,'COLD_DATABASE_ROLES_ACTUAL_COVERAGE');
  const proof={format:'COLD_REGISTRATION_DATABASE_ROLE_PRIVILEGES_V2',sourceHash,systemIdentifier:inventory.identity.system_id,controlOid:inventory.identity.control_oid,verifiedFrom,verifiedAt:new Date().toISOString(),registeredRoleCount:expected.registeredRoles,registeredDatabaseCount:expected.registeredDatabases,roleDatabasePairs:expected.pairs.length,individualPrivilegesChecked:rows.length,actualPrivilegeDecisions:rows,expectedPrivilegesSha256:hash(expected.pairs),actualPrivilegesSha256:hash(expected.pairs.map(pair=>({...pair,privileges:actual.get(pair.roleOid+':'+pair.databaseOid)}))),allRegisteredReviewAttributesAndMembershipsMatched:true,allRegisteredDatabasePrivilegesMatched:true,callerOwnsReadOnlyTransaction:true,scope:'DATABASE_CONNECT_CREATE_TEMP_AND_GRANT_OPTIONS',tableColumnSchemaFunctionDefaultPrivilegesVerified:false,configuredPasswordsVerified:false,fullRegisteredRoleMatrixVerified:false,authorizationGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false};
  return Object.freeze({...proof,sha256:hash(proof)});
}
