import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {describeColdDatabaseRolePrivilegesV1 as describe} from '../scripts/cold-registration-database-role-privileges-v1.mjs';
import {readRuntimeColdReviewWithFieldSourceV2} from '../scripts/runtime-cold-readonly-control-v7.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const file='work/ccf-native-v6-20261026/a1e9ccb7f4c7/verification.json',bytes=await readFile(file);
assert.equal(sha(bytes),'8b2be428e1262fb863231ea58b7bfff6cb35bcf8faaa1d749680ac8de90f75f5');
const report=JSON.parse(bytes),sources=[];
for(const item of report.fieldCurrentMaterialsNative.cases)sources.push((await readRuntimeColdReviewWithFieldSourceV2(item.trust)).source);

test('both immutable original 29-role/7-database SOURCEs have 203 explicit pairs and 1218 individual grant expectations',()=>{
  for(const source of sources){
    const result=describe(source);assert.equal(result.registeredRoles,29);assert.equal(result.registeredDatabases,7);assert.equal(result.pairs.length,203);
    assert.equal(result.pairs.reduce((n,pair)=>n+Object.keys(pair.privileges).length,0),1218);
    for(const role of source.inventory.roles)assert.deepEqual(result.pairs.filter(pair=>pair.roleOid===role.oid).map(pair=>pair.databaseOid).sort(),source.inventory.databases.map(value=>value.oid).sort());
    assert.equal(result.authorizationGranted,false);assert.equal(result.actualSqlPrivilegesVerified,false);assert.equal(result.fullRegisteredRoleMatrixVerified,false);
    // Independent literal SOURCE ACL reading: owner-only CREATE/TEMP, each listed non-owner CONNECT only.
    for(const pair of result.pairs){const database=source.inventory.databases.find(row=>row.oid===pair.databaseOid),role=source.inventory.roles.find(row=>row.oid===pair.roleOid),owner=database.datdba===role.oid;assert.equal(pair.privileges.CREATE,owner);assert.equal(pair.privileges.TEMP,owner);assert.equal(pair.privileges['CONNECT WITH GRANT OPTION'],owner);const entries=database.datacl.slice(1,-1).split(',');assert.equal(pair.privileges.CONNECT,entries.some(entry=>entry.startsWith(role.rolname+'=')));}
  }
});

test('omitted/duplicated/extra registered roles and unsafe inherited membership cannot masquerade as complete coverage',()=>{
  for(const mutate of [s=>s.registeredRoleOids.pop(),s=>s.registeredRoleOids.push(s.registeredRoleOids[0]),s=>s.inventory.roles[0].rolinherit=true,s=>s.inventory.memberships.find(row=>s.registeredRoleOids.includes(row.member)).inherit_option=true]){const source=structuredClone(sources[0]);mutate(source);assert.throws(()=>describe(source),error=>/^COLD_DATABASE_ROLES_/.test(error.code));}
});

test('PUBLIC, unknown grantee, foreign grantor, duplicate ACL entries and malformed grant options are refused',()=>{
  for(const fragment of ['=c/OWNER','unknown=c/OWNER','OWNER=c/foreign_owner','OWNER=cc/OWNER','OWNER=*c/OWNER','OWNER=c**/OWNER','OWNER=c/OWNER,OWNER=c/OWNER']){const source=structuredClone(sources[0]),database=source.inventory.databases[0],owner=source.inventory.roles.find(row=>row.oid===database.datdba).rolname;database.datacl='{'+fragment.replaceAll('OWNER',owner)+'}';assert.throws(()=>describe(source),error=>/^COLD_DATABASE_ROLES_/.test(error.code));}
});

test('explicit grant options and owner implicit grant options remain separate from ordinary grants',()=>{
  const source=structuredClone(sources[0]),database=source.inventory.databases[0],role=source.inventory.roles.find(row=>database.datacl.includes(row.rolname+'=c/'));database.datacl=database.datacl.replace(role.rolname+'=c/',role.rolname+'=c*/');
  const pair=describe(source).pairs.find(row=>row.roleOid===role.oid&&row.databaseOid===database.oid);assert.equal(pair.privileges.CONNECT,true);assert.equal(pair.privileges['CONNECT WITH GRANT OPTION'],true);assert.equal(pair.privileges.CREATE,false);
});

test('accepted report bytes remain unchanged after pure SOURCE projections',async()=>assert.equal(sha(await readFile(file)),sha(bytes)));
