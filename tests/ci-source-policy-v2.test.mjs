import test from 'node:test';
import assert from 'node:assert/strict';
import {ciSourceFilesV2,ciSourcePolicyContractV2} from '../scripts/ci-source-policy-v2.mjs';

function fixture(){
  const parent={format:'IDMS_CI_SOURCE_PARENT_V2',parentCommit:'2772e939e8cecfcccb773c818402d898e5716c9c',blobs:[...ciSourceFilesV2.map(path=>({path,sha256:'1'.repeat(64)})),...Array.from({length:756},(_,i)=>({path:'server/source-'+i+'.ts',sha256:'2'.repeat(64)}))]};
  const value={format:'IDMS_CI_SOURCE_POLICY_V2',parentCommit:parent.parentCommit,parentManifestFile:'docs/validation/ci-source-parent-v2.json',parentManifestSha256:'961e4f3a5c30fe07795d724fe20aff44d1635b2e20f95817c3fe5d5ac28f0190',ciBindings:ciSourceFilesV2.map(path=>({path,beforeSha256:'1'.repeat(64),afterSha256:'3'.repeat(64)})),runtimeChanges:[]};
  return {parent,value};
}

test('all six exact CI bindings admit both unchanged and deliberately updated bytes',()=>{
  for(const changed of [false,true]){const f=fixture();if(!changed)for(const row of f.value.ciBindings)row.afterSha256=row.beforeSha256;assert.deepEqual(ciSourcePolicyContractV2(f.value,f.parent),f.value);}
});
test('runtime source, tests, traversal and arbitrary workflows cannot replace a CI binding',()=>{
  for(const path of ['server/source-0.ts','tests/contract.test.mjs','../outside.yml','.github/workflows/unlisted.yml']){const f=fixture();f.value.ciBindings[0].path=path;assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_BINDING_SCOPE/);}
  const f=fixture();f.value.runtimeChanges=['server/source-0.ts'];assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_RUNTIME_CHANGE/);
});
test('wrong old digest, non-digest new bytes and duplicated binding coverage are rejected',()=>{
  let f=fixture();f.value.ciBindings[0].beforeSha256='4'.repeat(64);assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_BINDING_DIGEST/);
  f=fixture();f.value.ciBindings[0].afterSha256='any';assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_BINDING_DIGEST/);
  f=fixture();f.value.ciBindings[1]=f.value.ciBindings[0];assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_BINDING_SCOPE/);
});
test('missing runtime coverage, case collisions and unsafe historical paths are rejected',()=>{
  let f=fixture();f.parent.blobs.pop();assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_BASELINE_COUNT/);
  f=fixture();f.parent.blobs[7]={...f.parent.blobs[6],path:f.parent.blobs[6].path.toUpperCase()};assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_BASELINE_DUPLICATE/);
  f=fixture();f.parent.blobs[6].path='server/../outside';assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_BASELINE_ROW/);
});
test('a substituted parent, manifest digest or additional policy field cannot widen admission',()=>{
  let f=fixture();f.parent.parentCommit='0'.repeat(40);assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_PARENT_FIELDS/);
  f=fixture();f.value.parentManifestSha256='0'.repeat(64);assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_POLICY_FIELDS/);
  f=fixture();f.value.allowAnyRuntime=true;assert.throws(()=>ciSourcePolicyContractV2(f.value,f.parent),/CI_SOURCE_POLICY_FIELDS/);
});
