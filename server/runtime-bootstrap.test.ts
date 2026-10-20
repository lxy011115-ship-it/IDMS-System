import test from 'node:test';
import assert from 'node:assert/strict';
import {BootstrapBuilder,applyRuntimeBootstrap,assertBusinessSnapshot,snapshotHistory,assertWorkflowHistory,assertAiHistory} from './runtime-bootstrap.ts';
import {seedStore} from './store.ts';
import {emptyImports,createBatch} from './imports.ts';
import {tenantPayload} from './entity-repository.ts';
const model='sha256:'+'a'.repeat(64);
function input(){const store=seedStore(),imports=emptyImports();createBatch(imports,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'bootstrap-unit',rows:[{source_record_id:'one',device_code:'BO-1',device_name:'泵',site_code:'F',line_code:'L'}],original:Buffer.from('original bytes'),filename:'fixture.json',mime:'application/json',sourceKind:'API_JSON'}, {tenantId:'acme',actorId:'demo.uploader',actorType:'USER',correlationId:'unit'});const {audits,idempotency,...business}=store;return tenantPayload({version:2,business,imports,audits,idempotency:[...idempotency]},'acme');}
test('bootstrap fold retains only isolated frozen tenant bindings and history pins',()=>{
 const payload=input(),builder=new BootstrapBuilder();payload.imports.batches[0].aiReview.gateway={requestId:'one',requestDigest:'x',mode:'SHADOW',promptVersion:'1',policyVersion:'1',modelDigest:model,sampledRows:1,totalRows:1};
 payload.business.workOrders.push({workflow:{caseId:'one'}} as any);(payload.business.tenants[0] as any).unrelated={batch:payload.imports.batches[0]};builder.acceptVerifiedTenant('acme',payload);const result=builder.finish();assert.deepEqual(Object.keys(result).sort(),['history','tenants']);assert.deepEqual(result.history,{workflowRequired:true,aiModelDigests:[model]});assert.notEqual(result.tenants[0],payload.business.tenants[0]);assert.deepEqual(Object.keys(result.tenants[0]).sort(),['id','modules','name','plan','status']);
 payload.business.tenants[0].name='changed';payload.business.tenants[0].modules.push('new');assert.notEqual(result.tenants[0].name,'changed');assert.ok(!result.tenants[0].modules.includes('new'));assert.throws(()=>result.tenants[0].modules.push('poison'));assert.throws(()=>result.tenants.push(result.tenants[0]));assert.throws(()=>builder.acceptVerifiedTenant('acme',payload));
});
test('bootstrap root cannot be mistaken for a complete business snapshot',()=>{
 const payload=input(),builder=new BootstrapBuilder();builder.acceptVerifiedTenant('acme',payload);const store=seedStore();assert.doesNotThrow(()=>assertBusinessSnapshot(store));applyRuntimeBootstrap(store,builder.finish());assert.equal(store.tenants.length,1);assert.equal(store.idempotency.size,0);for(const [key,value]of Object.entries(store))if(!['tenants','idempotency'].includes(key))assert.deepEqual(value,[]);assert.throws(()=>assertBusinessSnapshot(store),/启动绑定/);assert.throws(()=>snapshotHistory(store,{batches:[]}),/启动绑定/);
});
test('bootstrap rejects duplicate, foreign and missing tenant binding',()=>{
 const payload=input(),builder=new BootstrapBuilder();assert.throws(()=>new BootstrapBuilder().finish(),/No runtime tenant/);assert.throws(()=>builder.acceptVerifiedTenant('sandbox',payload));const empty=structuredClone(payload);empty.business.tenants=[];assert.throws(()=>builder.acceptVerifiedTenant('acme',empty));builder.acceptVerifiedTenant('acme',payload);assert.throws(()=>builder.acceptVerifiedTenant('acme',payload));
});
test('historical workflow and AI configuration cannot fall back after business data is discarded',()=>{
 const required={workflowRequired:true,aiModelDigests:[model]};assert.throws(()=>assertWorkflowHistory(required,false),/fallback/);assert.doesNotThrow(()=>assertWorkflowHistory(required,true));assert.throws(()=>assertAiHistory(required),/fallback/);assert.throws(()=>assertAiHistory(required,'sha256:'+'b'.repeat(64)),/Historical AI model pin/);assert.doesNotThrow(()=>assertAiHistory(required,model));const empty={workflowRequired:false,aiModelDigests:[]};assert.doesNotThrow(()=>assertWorkflowHistory(empty,false));assert.doesNotThrow(()=>assertAiHistory(empty));
});
test('history pins deduplicate without retaining batch bodies and invalid pins fail closed',()=>{
 const payload=input(),batch=payload.imports.batches[0];batch.aiReview.gateway={modelDigest:model} as any;payload.imports.batches.push(structuredClone(batch));assert.deepEqual(snapshotHistory(payload.business,payload.imports).aiModelDigests,[model]);batch.aiReview.gateway!.modelDigest='';assert.throws(()=>snapshotHistory(payload.business,payload.imports),/Invalid historical/);
});
