import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {RuntimeFenceProvisionV1} from '../scripts/runtime-fence-provision-v1.mjs';
import {WorkflowReviewSourceInstallerV1} from '../scripts/workflow-review-source-install-v1.mjs';
import {workflowReaderHbaPrefixV1} from '../scripts/workflow-review-source-hba-v1.mjs';
import {workflowReviewFrozenInventoryV1,reviewSourceHashV1 as hash} from '../scripts/workflow-review-source-facts-v1.mjs';
const fixture=()=>{
 const sourceDirectory=resolve('work/source-contract-unit-source'),role={oid:'201',rolname:'idms_wr_unit_acme',rolcanlogin:true,rolconnlimit:2,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,rolconfig:[],rolvaliduntil:null},business={...role,oid:'202',rolname:'business_app',rolconnlimit:-1},inventory={identity:{system_id:'7000000000000000000',directory:sourceDirectory},roles:[role,business],databases:[{oid:'301',datname:'workflow_db',datconnlimit:-1},{oid:'302',datname:'business_db',datconnlimit:-1}],memberships:[]};
 const f={format:'WORKFLOW_REVIEW_SOURCE_ROLE_FACTS_V1',identity:{systemIdentifier:inventory.identity.system_id,directory:sourceDirectory,database_oid:'301',database:'workflow_db'},role};const facts={...f,sha256:hash(f)},body={format:'WORKFLOW_REVIEW_SOURCE_CONTRACT_V1',systemIdentifier:inventory.identity.system_id,sourceDirectory,hba:{sha256:'1'.repeat(64)},readers:[{facts}]};return{inventory,contract:{...body,sha256:hash(body)}};
};
test('an object with the right prototype and methods cannot impersonate the original provision private state',()=>{
 for(const fake of [{provisioned:[],addActors(){}},Object.create(RuntimeFenceProvisionV1.prototype)])assert.throws(()=>new WorkflowReviewSourceInstallerV1(fake,{sourceDirectory:resolve('work/x'),workDirectory:resolve('work/y')}),/WORKFLOW_SOURCE_REAL_PROVISION_REQUIRED/);
});
test('HBA syntax and special database selectors cannot widen a declared single-database scope',()=>{
 for(const database of ['all','sameuser','samerole','samegroup','replication','x\nlocal all all trust'])assert.throws(()=>workflowReaderHbaPrefixV1([{role:'idms_wr_unit',database}]),/WORKFLOW_SOURCE_(?:HBA_SCOPE|IDENTIFIER)/);
 assert.throws(()=>workflowReaderHbaPrefixV1([{role:'all',database:'workflow_db'}]),/WORKFLOW_SOURCE_HBA_SCOPE/);
});
test('duplicate identities or database scopes cannot introduce overlapping reader rules',()=>{
 const a={role:'idms_wr_a',database:'workflow_a'};
 assert.throws(()=>workflowReaderHbaPrefixV1([a,{...a,database:'workflow_b'}]),/WORKFLOW_SOURCE_HBA_SCOPE/);assert.throws(()=>workflowReaderHbaPrefixV1([a,{...a,role:'idms_wr_b'}]),/WORKFLOW_SOURCE_HBA_SCOPE/);
});
test('freeze projection preserves only the captured reader and does not mutate the original inventory',()=>{
 const {inventory,contract}=fixture(),before=structuredClone(inventory),next=workflowReviewFrozenInventoryV1(inventory,contract,resolve('work/projected-target'));
 assert.deepEqual(inventory,before);assert.equal(next.roles[0].rolcanlogin,true);assert.equal(next.roles[1].rolcanlogin,false);assert.equal(next.roles[1].rolconnlimit,0);assert.equal(next.databases[0].datconnlimit,2);assert.equal(next.databases[1].datconnlimit,0);
});
test('a matching self-hash cannot make a strong reader role or an undeclared reserved reader acceptable',()=>{
 const {inventory,contract}=fixture();inventory.roles[0].rolsuper=true;const facts=contract.readers[0].facts;facts.role.rolsuper=true;const {sha256:old,...body}=facts;facts.sha256=hash(body);const {sha256:oldContract,...c}=contract;contract.sha256=hash(c);assert.throws(()=>workflowReviewFrozenInventoryV1(inventory,contract,resolve('work/target')),/WORKFLOW_SOURCE_CAPTURE_PROFILE/);
 const other=fixture();other.inventory.roles.push({...other.inventory.roles[1],oid:'203',rolname:'idms_wr_undeclared'});assert.throws(()=>workflowReviewFrozenInventoryV1(other.inventory,other.contract,resolve('work/target')),/WORKFLOW_SOURCE_UNDECLARED_READER/);
});
test('a source contract cannot project another system or a relative target',()=>{
 const {inventory,contract}=fixture();assert.throws(()=>workflowReviewFrozenInventoryV1({...inventory,identity:{...inventory.identity,system_id:'different'}},contract,resolve('work/target')),/WORKFLOW_SOURCE_CAPTURE_SYSTEM/);assert.throws(()=>workflowReviewFrozenInventoryV1(inventory,contract,'relative'),/WORKFLOW_SOURCE_CAPTURE_SYSTEM/);
});
