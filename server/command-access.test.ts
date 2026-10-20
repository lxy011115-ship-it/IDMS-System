import test from 'node:test';
import assert from 'node:assert/strict';
import {commandAccess} from './command-access.ts';
import {emptyImports,createBatch,approveBatch} from './imports.ts';
import {seedStore} from './store.ts';
const ctx={tenantId:'acme',actorId:'u',actorType:'USER',authMode:'oidc' as const,roles:['tenant-admin','data-uploader'],correlationId:'qa'},reviewer={...ctx,actorId:'r',roles:['final-approver']};
test('write receipt authorization rechecks current role, tenant and factory before cached responses',()=>{
 const store=seedStore(),data=emptyImports(),b=createBatch(data,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'qa',rows:[{source_record_id:'a',device_code:'P',device_name:'泵',site_code:'FACTORY-01',line_code:'LINE-01'}],original:Buffer.from('original'),filename:'a.json',mime:'application/json',sourceKind:'API_JSON'},ctx);approveBatch(data,store,b.batchId,{expectedVersion:b.version,snapshotDigest:b.snapshotDigest,decision:'APPROVED',comment:'独立核验'},reviewer);
 assert.doesNotThrow(()=>commandAccess('/api/v1/templates','POST',{},ctx,data,store));assert.throws(()=>commandAccess('/api/v1/templates','POST',{}, {...ctx,roles:['data-uploader']},data,store),/权限/);
 assert.doesNotThrow(()=>commandAccess('/api/v1/equipment-profiles/points','POST',{deviceCode:'P'},ctx,data,store));assert.throws(()=>commandAccess('/api/v1/equipment-profiles/points','POST',{deviceCode:'P'},{...ctx,roles:['data-uploader'],scope:{provided:true,sites:['FACTORY-02'],lines:[],devices:[]}},data,store),/范围/);
 assert.throws(()=>commandAccess('/api/v1/templates/foreign/edit','POST',{},ctx,data,store),/不存在/);assert.throws(()=>commandAccess('/api/v1/equipment-profiles/points','POST',{deviceCode:'P'},{...ctx,tenantId:'sandbox',scope:{provided:true,sites:['FACTORY-02'],lines:[],devices:[]}},data,store));
 for(const [action,role]of [['certify','platform-certifier'],['activate','final-approver']])assert.doesNotThrow(()=>commandAccess('/api/v1/plugins/'+store.plugins[0].id+'/'+action,'POST',{}, {...ctx,roles:[role]},data,store));
});
test('telemetry analysis accepts an authenticated source registry without requiring a separate uploaded asset',()=>{
 const store=seedStore(),data=emptyImports(),sources=[{tenantId:'sandbox',edgeId:'edge',deviceCode:'SIM-CNC-01'}],who={...ctx,tenantId:'sandbox',roles:['data-uploader'],scope:{provided:true,sites:['*'],lines:[],devices:[]}};
 assert.doesNotThrow(()=>commandAccess('/api/v1/telemetry/analyze','POST',{edgeId:'edge'},who,data,store,sources));
 assert.throws(()=>commandAccess('/api/v1/telemetry/analyze','POST',{edgeId:'edge'},{...who,scope:{...who.scope,sites:['FACTORY-01']}},data,store,sources),/授权范围/);
 assert.throws(()=>commandAccess('/api/v1/telemetry/analyze','POST',{edgeId:'foreign'},who,data,store,sources),/不存在/);
});
