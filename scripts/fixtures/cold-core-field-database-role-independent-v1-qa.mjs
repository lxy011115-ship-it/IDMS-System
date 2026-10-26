import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const time=value=>{const stamp=Date.parse(value);assert(Number.isFinite(stamp));assert.equal(new Date(stamp).toISOString(),value);return stamp;};

/** Independently reconstructs database ACL semantics and every original SQL decision.
 * Does not import the producer, its ACL compiler, or its cohort validator. */
export function verifyColdCoreFieldDatabaseRolesIndependentQaV1({source,binding,files,cohort,proof}){
  assert.equal(proof.format,'COLD_REGISTRATION_DATABASE_ROLE_PRIVILEGES_V2');const {sha256,...body}=proof;assert.equal(hash(body),sha256);
  assert.equal(proof.sourceHash,binding.sourceHash);assert.equal(proof.systemIdentifier,source.inventory.identity.system_id);assert.equal(proof.controlOid,source.inventory.identity.control_oid);assert.equal(proof.scope,'DATABASE_CONNECT_CREATE_TEMP_AND_GRANT_OPTIONS');
  for(const key of ['callerOwnsReadOnlyTransaction','allRegisteredReviewAttributesAndMembershipsMatched','allRegisteredDatabasePrivilegesMatched'])assert.equal(proof[key],true,key);
  assert.equal(proof.fullRegisteredRoleMatrixVerified,false);assert.equal(proof.authorizationGranted,false);
  const roles=source.inventory.roles,databases=source.inventory.databases,ids=new Set(roles.map(role=>role.oid)),names=new Set(roles.map(role=>role.rolname));assert.equal(ids.size,roles.length);assert.equal(names.size,roles.length);assert.deepEqual([...ids].sort(),[...source.registeredRoleOids].sort());
  for(const role of roles)assert.equal(role.rolinherit,false);
  const actual=new Map();assert.equal(proof.actualPrivilegeDecisions.length,roles.length*databases.length*6);
  for(const row of proof.actualPrivilegeDecisions){assert.deepEqual(Object.keys(row).sort(),['database_oid','granted','privilege','role_oid']);assert(ids.has(row.role_oid));assert(databases.some(database=>database.oid===row.database_oid));assert(['CONNECT','CREATE','TEMP','CONNECT WITH GRANT OPTION','CREATE WITH GRANT OPTION','TEMP WITH GRANT OPTION'].includes(row.privilege));assert.equal(typeof row.granted,'boolean');const key=[row.role_oid,row.database_oid,row.privilege].join('/');assert(!actual.has(key));actual.set(key,row.granted);}
  const expected=[];
  for(const database of databases){
    const owner=roles.find(role=>role.oid===database.datdba);assert(owner);const direct=new Map();assert.equal(database.datacl[0],'{');assert.equal(database.datacl.at(-1),'}');
    for(const item of database.datacl.slice(1,-1).split(',')){
      const separator=item.indexOf('='),slash=item.indexOf('/');assert(separator>0&&slash>separator+1&&slash===item.lastIndexOf('/'));const grantee=item.slice(0,separator),grantor=item.slice(slash+1),rights=item.slice(separator+1,slash);assert(names.has(grantee));assert.equal(grantor,owner.rolname);assert(!direct.has(grantee));const grants=new Map();
      // Tokenize privilege letters independently of the producer's ACL regex.
      for(let offset=0;offset<rights.length;offset++){const letter=rights[offset];assert(['C','T','c'].includes(letter));assert(!grants.has(letter));const grantable=rights[offset+1]==='*';grants.set(letter,grantable);if(grantable)offset++;}direct.set(grantee,grants);
    }
    assert(direct.has(owner.rolname));
    for(const role of roles){const privileges={},grants=direct.get(role.rolname);for(const [letter,privilege] of [['c','CONNECT'],['C','CREATE'],['T','TEMP']]){privileges[privilege]=grants?.has(letter)??false;privileges[privilege+' WITH GRANT OPTION']=role.oid===database.datdba||grants?.get(letter)===true;}for(const [privilege,value] of Object.entries(privileges))assert.equal(actual.get([role.oid,database.oid,privilege].join('/')),value);expected.push({roleOid:role.oid,databaseOid:database.oid,privileges});}
  }
  expected.sort((a,b)=>Number(a.roleOid)-Number(b.roleOid)||Number(a.databaseOid)-Number(b.databaseOid));assert.equal(proof.expectedPrivilegesSha256,hash(expected));assert.equal(proof.actualPrivilegesSha256,hash(expected));
  assert.equal(proof.registeredRoleCount,roles.length);assert.equal(proof.registeredDatabaseCount,databases.length);assert.equal(proof.roleDatabasePairs,expected.length);assert.equal(proof.individualPrivilegesChecked,actual.size);
  const end=time(proof.verifiedAt),start=time(proof.verifiedFrom),previous=cohort.namespaces.at(-2);assert.equal(previous.kind,'ROLE_CREDENTIALS');assert(start>=time(previous.verifiedAt)&&start>=time(files.capturedAt)&&start>=time(cohort.before.completedAt)&&start<=end&&end<=time(cohort.after.notBefore)&&end<time(files.expiresAt));assert.equal(time(files.expiresAt)-time(files.capturedAt),30000);
  assert.deepEqual(cohort.namespaces.at(-1),{kind:'DATABASE_ROLE_PRIVILEGES',databaseOid:null,controlRoleOid:source.inventory.identity.control_oid,registeredRoleCount:roles.length,registeredDatabaseCount:databases.length,roleDatabasePairs:expected.length,individualPrivilegesChecked:actual.size,sqlEvidenceSha256:hash(proof),verifiedFrom:proof.verifiedFrom,verifiedAt:proof.verifiedAt,callerOwnsReadOnlyTransaction:true});
  return {format:'COLD_CORE_FIELD_DATABASE_ROLE_INDEPENDENT_QA_V1',registeredRoles:roles.length,registeredDatabases:databases.length,roleDatabasePairs:expected.length,individuallyRebuiltActualSqlDecisions:actual.size,sourceAclSemanticsIndependentlyRebuilt:true,allDecisionsInsideOriginalPeerBracket:true,currentSqlReplayed:false,tableColumnSchemaFunctionDefaultPrivilegesVerified:false,fullRegisteredRoleMatrixVerified:false,runtimeAuthorityGranted:false,fullGoalComplete:false};
}
