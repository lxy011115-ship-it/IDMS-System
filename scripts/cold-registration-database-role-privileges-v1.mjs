import pg from 'pg';
import {resolve,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {coldRuntimeInventoryV1} from './runtime-cold-facts-v1.mjs';
import {workflowReviewFrozenInventoryV1,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const same=(a,b)=>canonical(a)===canonical(b);
const oid=value=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value)&&BigInt(value)<=4294967295n;
const name=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(value);
const pathKey=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
const privileges=['CONNECT','CREATE','TEMP'];
const letters={c:'CONNECT',C:'CREATE',T:'TEMP'};
const checkedPrivileges=privileges.flatMap(value=>[value,value+' WITH GRANT OPTION']);

/** Exact SOURCE database ACL expectations only. This pure value cannot grant admission. */
export function describeColdDatabaseRolePrivilegesV1(source){
  const inventory=source?.inventory,roles=inventory?.roles,databases=inventory?.databases;
  need(Array.isArray(roles)&&roles.length>0&&roles.length<=256&&Array.isArray(databases)&&databases.length>0&&databases.length<=64&&Array.isArray(source.registeredRoleOids)&&Array.isArray(inventory.memberships),'COLD_DATABASE_ROLES_SOURCE');
  const byName=new Map(),byOid=new Map(),databaseIds=new Set();
  for(const role of roles){
    need(oid(role.oid)&&name(role.rolname)&&!byName.has(role.rolname)&&!byOid.has(role.oid)&&['rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key=>role[key]===false),'COLD_DATABASE_ROLES_ROLE');
    byName.set(role.rolname,role);byOid.set(role.oid,role);
  }
  need(source.registeredRoleOids.length===roles.length&&new Set(source.registeredRoleOids).size===roles.length&&source.registeredRoleOids.every(value=>byOid.has(value)),'COLD_DATABASE_ROLES_COVERAGE');
  // No implicit inherited grants may be hidden behind the direct ACL model.
  for(const item of inventory.memberships)if(byOid.has(item.member)||byOid.has(item.roleid))need(byOid.has(item.member)&&byOid.has(item.roleid)&&item.grantor===inventory.identity.control_oid&&item.admin_option===false&&item.inherit_option===false&&item.set_option===true,'COLD_DATABASE_ROLES_MEMBERSHIP');
  const pairs=[];
  for(const database of databases){
    need(oid(database.oid)&&!databaseIds.has(database.oid)&&name(database.datname)&&byOid.has(database.datdba)&&typeof database.datacl==='string'&&database.datacl.startsWith('{')&&database.datacl.endsWith('}'),'COLD_DATABASE_ROLES_DATABASE');databaseIds.add(database.oid);
    const grants=new Map(),owner=byOid.get(database.datdba);
    for(const entry of database.datacl.slice(1,-1).split(',')){
      const match=/^([a-z][a-z0-9_]{0,62})=([CTc*]+)\/([a-z][a-z0-9_]{0,62})$/.exec(entry);
      need(match&&byName.has(match[1])&&match[3]===owner.rolname&&!grants.has(match[1]),'COLD_DATABASE_ROLES_ACL');
      const rights=new Set(),grantable=new Set();
      for(let index=0;index<match[2].length;index++){
        const right=letters[match[2][index]];need(right&&!rights.has(right),'COLD_DATABASE_ROLES_ACL');rights.add(right);
        if(match[2][index+1]==='*'){grantable.add(right);index++;}
      }
      grants.set(match[1],{rights,grantable});
    }
    need(grants.has(owner.rolname),'COLD_DATABASE_ROLES_OWNER_ACL');
    for(const role of roles){
      const direct=grants.get(role.rolname),values={};
      for(const privilege of privileges){values[privilege]=direct?.rights.has(privilege)??false;values[privilege+' WITH GRANT OPTION']=role.oid===database.datdba||direct?.grantable.has(privilege)===true;}
      pairs.push({roleOid:role.oid,databaseOid:database.oid,privileges:values});
    }
  }
  pairs.sort((a,b)=>BigInt(a.roleOid)<BigInt(b.roleOid)?-1:BigInt(a.roleOid)>BigInt(b.roleOid)?1:BigInt(a.databaseOid)<BigInt(b.databaseOid)?-1:1);
  return {format:'COLD_DATABASE_ROLE_PRIVILEGES_DESCRIPTION_V1',registeredRoles:roles.length,registeredDatabases:databases.length,pairs,sourceDescriptionOnly:true,actualSqlPrivilegesVerified:false,authorizationGranted:false,fullRegisteredRoleMatrixVerified:false};
}

/** Caller retains its actual root pg.Client and read-only transaction. No login, DDL or COMMIT. */
export async function verifyColdRegistrationDatabaseRolePrivilegesV1(client,raw){
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
  const proof={format:'COLD_REGISTRATION_DATABASE_ROLE_PRIVILEGES_V1',sourceHash,systemIdentifier:inventory.identity.system_id,controlOid:inventory.identity.control_oid,verifiedFrom,verifiedAt:new Date().toISOString(),registeredRoleCount:expected.registeredRoles,registeredDatabaseCount:expected.registeredDatabases,roleDatabasePairs:expected.pairs.length,individualPrivilegesChecked:rows.length,expectedPrivilegesSha256:hash(expected.pairs),actualPrivilegesSha256:hash(expected.pairs.map(pair=>({...pair,privileges:actual.get(pair.roleOid+':'+pair.databaseOid)}))),allRegisteredReviewAttributesAndMembershipsMatched:true,allRegisteredDatabasePrivilegesMatched:true,callerOwnsReadOnlyTransaction:true,scope:'DATABASE_CONNECT_CREATE_TEMP_AND_GRANT_OPTIONS',tableColumnSchemaFunctionDefaultPrivilegesVerified:false,configuredPasswordsVerified:false,fullRegisteredRoleMatrixVerified:false,authorizationGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false};
  return Object.freeze({...proof,sha256:hash(proof)});
}
