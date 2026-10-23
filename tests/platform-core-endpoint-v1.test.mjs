import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFile,lstat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {prepareCoreEndpointApplicationQaV1} from '../scripts/fixtures/platform-core-v3-qa.mjs';
import {WorkflowCancelReservationTransportV1} from '../server/workflow-cancel-reservation-transport-v1.ts';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){
 const base=resolve('work/core-endpoint-unit-20261023',randomUUID());await privateDirectory(base);
 const components=[];for(const tenant of ['acme','sandbox'])for(const kind of ['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION'])components.push({id:tenant+'-'+kind.toLowerCase(),kind,tenantId:tenant,runtimeFile:join(base,tenant+'-'+kind+'.json')});
 components.push({id:'site',kind:'SITE',tenantId:null,runtimeFile:join(base,'site.json')});
 const original={format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(base,'old-registry'),trustFile:join(base,'trust.json'),authorityRuntimeFile:join(base,'authority.json'),binding:{controlId:randomUUID(),sourceHash:'1'.repeat(64),authorityHash:'2'.repeat(64)},tenantIds:['acme','sandbox'],components};
 const files=[original.trustFile,original.authorityRuntimeFile,...components.map(c=>c.runtimeFile)];for(const f of files)await privateNewFile(f,JSON.stringify({immutableSource:f}));
 const manifest=join(base,'original.private.json');await privateNewFile(manifest,JSON.stringify(original));files.push(manifest);
 const flowConfigs=Object.fromEntries(original.tenantIds.map((tenant,i)=>[tenant,{workflow:{baseUrl:'http://127.0.0.1:34789',tenantId:tenant,serviceToken:String(i+1).repeat(43)},reservation:{baseUrl:'http://127.0.0.1:34789',tenantId:tenant,token:String(i+3).repeat(43),authorityId:randomUUID(),catalogHash:'a'.repeat(64)}}]));
 return{base,original,manifest,files,flowConfigs};
}
test('new direct JVM keeps the sealed origin and every runtime pointer, preserving actual transport fingerprints',async()=>{
 const f=await fixture(),before=new Map(await Promise.all(f.files.map(async p=>[p,digest(await readFile(p))]))),expected=f.original.tenantIds.map(t=>new WorkflowCancelReservationTransportV1(f.flowConfigs[t]));
 const result=await prepareCoreEndpointApplicationQaV1({root:join(f.base,'core-input'),originalManifestFile:f.manifest,flowConfigs:f.flowConfigs});
 assert.equal(result.port,34789);assert.equal(result.origin,'http://127.0.0.1:34789');assert.deepEqual(result.app.components,f.original.components);assert.equal(result.app.trustFile,f.original.trustFile);assert.equal(result.app.authorityRuntimeFile,f.original.authorityRuntimeFile);assert.notEqual(result.app.registryDirectory,f.original.registryDirectory);
 for(const [i,tenant] of f.original.tenantIds.entries()){
  const actual=new WorkflowCancelReservationTransportV1(f.flowConfigs[tenant]);assert.equal(actual.binding,expected[i].binding);assert.equal(result.bindings[i].reservationBinding,actual.binding);
  const c=f.flowConfigs[tenant],wrong=new WorkflowCancelReservationTransportV1({workflow:{...c.workflow,baseUrl:'http://127.0.0.1:35890'},reservation:{...c.reservation,baseUrl:'http://127.0.0.1:35890'}});assert.notEqual(wrong.binding,actual.binding);assert.notEqual(wrong.workflowBinding,actual.workflowBinding);
 }
 for(const [path,hash] of before)assert.equal(digest(await readFile(path)),hash);
});
test('two different sealed origins are rejected before creating a core manifest',async()=>{
 const f=await fixture(),root=join(f.base,'rejected');for(const type of ['workflow','reservation'])f.flowConfigs.sandbox[type].baseUrl='http://127.0.0.1:35890';
 await assert.rejects(prepareCoreEndpointApplicationQaV1({root,originalManifestFile:f.manifest,flowConfigs:f.flowConfigs}),/CORE_QA_SEALED_ENDPOINTS_DIFFER/);await assert.rejects(lstat(root),{code:'ENOENT'});
});
