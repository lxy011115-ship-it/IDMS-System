import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createColdCoreRoleMaterialFilesQaV1 as create} from '../scripts/fixtures/cold-core-role-material-files-v1-qa.mjs';
import {createColdRegistrationCoreMaterialQaV2 as legacy} from '../scripts/fixtures/cold-registration-core-materials-v2-qa.mjs';
import {inspectColdRegistrationCoreMaterialsV11 as inspect} from '../scripts/cold-registration-core-materials-v11-request-file-v1.mjs';
import {coldSourceConnectOnlyRoleNamesV1 as connectOnly} from '../scripts/cold-registration-role-responsibilities-v2.mjs';
const original=resolve('work/cold-registration-auth-audit-map-native-v5-20261025/dd7554efc169'),root=resolve('work/cold-core-role-materials-v1-20261026'),json=async file=>JSON.parse(await readFile(file,'utf8'));
async function make(label){return create({directory:join(root,label+'-'+randomUUID()),originalDirectory:original,trust:await json(join(original,'cold-control/trust.json'))});}
async function rejected(label,mutate,expected){const files=await make(label);await mutate(files);await assert.rejects(inspect(files.config),error=>error.code===expected);}

test('real delivery runtimes and retired identities describe every original role without granting activation',async()=>{
  const files=await make('complete');let cap;
  try{cap=await inspect(files.config);const proof=cap.evidence();assert.equal(proof.implementationVersion,11);assert(proof.roleCompleteDeclaration);assert.equal(proof.roleResponsibilities.registeredRoles,29);assert.equal(proof.roleResponsibilities.describedRoles,29);assert.equal(proof.roleResponsibilities.runtimeRoleCount,12);assert.deepEqual(proof.roleResponsibilities.uncoveredRoleOids,[]);assert(proof.roleResponsibilities.allRegisteredResponsibilitiesDescribed);assert.equal(proof.roleResponsibilities.fullRegisteredRoleMatrixVerified,false);assert.equal(proof.roleResponsibilities.currentConfiguredPasswordsVerified,false);assert.equal(proof.formalFieldActivationGranted,false);assert.equal(proof.fullGoalComplete,false);assert.deepEqual(await cap.revalidate(),proof);let called=false;assert.throws(()=>cap.verifyConfiguredRoleCredentialsSql({query(){called=true;},getTransactionStatus(){return 'T';}}),error=>error.code==='COLD_REGISTRATION_CORE_ROLE_SQL_TRANSACTION');assert.equal(called,false);const text=JSON.stringify(proof),runtime=await json(files.deliveryFiles[0]),ring=await json(files.keyFile);for(const value of [runtime.source.account.password,ring.keys[0].key,files.root])assert(!text.includes(value));}finally{await cap?.close();}
});
test('legacy V1 core declarations retain their explicit incomplete role description',async()=>{
  const files=await legacy({directory:join(root,'legacy-'+randomUUID()),originalDirectory:original,trust:await json(join(original,'cold-control/trust.json'))});let cap;
  try{cap=await inspect(files.config);assert.equal(cap.evidence().roleCompleteDeclaration,false);assert.equal(cap.evidence().roleResponsibilities.describedRoles,26);assert.equal(cap.evidence().roleResponsibilities.uncoveredRoleOids.length,3);}finally{await cap?.close();}
});
test('missing delivery scope/tenant coverage is rejected',()=>rejected('missing-delivery',files=>files.change(files.configurationFile,value=>value.authenticationDeliveryRuntimeFiles.pop()),'COLD_REGISTRATION_CORE_DELIVERY_COVERAGE'));
test('delivery source cannot use another database',()=>rejected('wrong-delivery-db',files=>files.change(files.deliveryFiles[0],value=>{value.source.account.database='postgres';}),'COLD_REGISTRATION_CORE_DELIVERY_SOURCE'));
test('delivery source OID cannot be replaced by the authentication application OID',()=>rejected('wrong-delivery-oid',async files=>{const auth=await json(files.paths.get('auth-runtime.private.json'));await files.change(files.deliveryFiles[0],value=>{value.source.binding.roleOid=files.state.source.inventory.roles.find(role=>role.rolname===auth.account.user).oid;});},'COLD_REGISTRATION_CORE_DELIVERY_SOURCE'));
test('delivery derived ring must exactly match the captured authentication master derivation',()=>rejected('wrong-derived-key',files=>files.change(files.keyFile,value=>{value.keys[0].key=randomBytes(32).toString('base64url');}),'COLD_REGISTRATION_CORE_DELIVERY_KEY'));
test('delivery target binding cannot cross original enterprise databases',()=>rejected('wrong-target',files=>files.change(files.deliveryFiles[0],value=>{value.targets[0].binding.databaseOid=files.state.source.active.find(gate=>gate.databaseOid!==value.targets[0].binding.databaseOid).databaseOid;}),'COLD_REGISTRATION_CORE_DELIVERY_TARGET'));
test('delivery driver override fields are rejected',()=>rejected('driver-override',files=>files.change(files.deliveryFiles[0],value=>{value.source.account.connectionString='postgresql://127.0.0.1:1/override';}),'COLD_REGISTRATION_CORE_DELIVERY_SOURCE'));
test('retired role identities must bind the exact original SOURCE',()=>rejected('foreign-retired',files=>files.change(files.retiredFiles[0],value=>{value.sourceHash='b'.repeat(64);}),'COLD_REGISTRATION_CORE_RETIRED_ROLE_DECLARATION'));
test('retired application role cannot be relabeled as backup',()=>rejected('retired-app-as-backup',files=>files.change(files.retiredFiles[0],value=>{value.backupRoleOid=value.applicationRoleOid;}),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_RETIRED_BACKUP'));
test('duplicate retired role file cannot cover another retired database',()=>rejected('duplicate-retired',files=>files.change(files.configurationFile,value=>{value.retiredRoleIdentityFiles[1]=value.retiredRoleIdentityFiles[0];}),'COLD_REGISTRATION_ROLE_RESPONSIBILITY_RETIRED_DUPLICATE'));
test('missing retired database material is rejected',()=>rejected('missing-retired',files=>files.change(files.configurationFile,value=>{value.retiredRoleIdentityFiles.pop();}),'COLD_REGISTRATION_CORE_ROLE_MATERIAL_COVERAGE'));
test('post-capture delivery key changes retire the original compiler permanently',async()=>{
  const files=await make('delivery-drift');let cap;
  try{cap=await inspect(files.config);await files.change(files.keyFile,value=>{value.keys[0].key=randomBytes(32).toString('base64url');});await assert.rejects(cap.revalidate(),error=>error.code==='COLD_REGISTRATION_CORE_FILE_CHANGED');assert.throws(()=>cap.evidence(),/CORE_CLOSED_OR_BUSY/);}finally{await cap?.close();}
});
test('database ACL parser refuses unsupported quoting and duplicate grantees',()=>{assert.throws(()=>connectOnly('{"quoted"=c/owner}'),/DATABASE_ACL/);assert.throws(()=>connectOnly('{backup=c/owner,backup=c/owner}'),/DATABASE_ACL/);});
test('database ACL candidates exclude grant options, broader privileges and PUBLIC',()=>{assert.deepEqual(connectOnly('{=c/owner,owner=CTc/owner,backup=c/owner,delegate=c*/owner}'),['backup']);});
