import test from 'node:test';
import assert from 'node:assert/strict';
import {seedStore} from './store.ts';
import {emptyImports,createBatch,canonical} from './imports.ts';
import {tenantPayload,splitBatch,writeEntities,validateTenantPayload} from './entity-repository.ts';
import {revisionMigrationChecksum} from './postgres-schema.ts';
const who={tenantId:'acme',actorId:'u',actorType:'USER',authMode:'oidc' as const,roles:['data-uploader'],correlationId:'qa'};
function snapshot(){const store=seedStore(),{audits,idempotency,...business}=store;return {version:2,business,audits,idempotency:[...idempotency],imports:emptyImports()};}
test('entity payload partitions every domain, audit, input and request by its authoritative tenant',()=>{
 const s=snapshot(),p=tenantPayload(s,'sandbox');assert.equal(p.business.tenants.length,1);assert.ok(p.business.devices.every(d=>d.tenantId==='sandbox'));validateTenantPayload(p,'sandbox');
 const wrong=structuredClone(p);wrong.business.templates.push(s.business.templates[0]);assert.throws(()=>validateTenantPayload(wrong,'sandbox'),/tenant business entity/);
 const unknown=structuredClone(p);(unknown.business as any).hidden=[];assert.throws(()=>validateTenantPayload(unknown,'sandbox'),/Unknown/);
});
test('normalized batch partition reconstructs valid rows and original bytes without losing duplicate input lines',()=>{
 const store=seedStore(),data=emptyImports(),row={source_record_id:'p',device_code:'P',device_name:'泵',site_code:'FACTORY-01',line_code:'LINE-01'},bytes=Buffer.from('原始输入\r\n多行'),b=createBatch(data,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'qa',rows:[row,{...row}],original:bytes,filename:'original.csv',mime:'text/csv',sourceKind:'MANUAL_FILE'},who),before=canonical(b),parts=splitBatch(b);
 assert.equal(parts.input.length,2);assert.deepEqual(parts.input.filter(r=>r.validOrdinal!==null).map(r=>r.body),b.validRows);assert.ok(parts.content.equals(bytes));assert.equal('rows' in parts.body,false);assert.equal('originalBase64' in parts.body,false);assert.equal(canonical(b),before);
 assert.throws(()=>splitBatch({...b,validRows:[{...row,device_name:'其他'}]}),/frozen input/);
 const other={...row,source_record_id:'q',device_code:'Q'};
 assert.deepEqual(splitBatch({...b,rows:[row,other,{...row}],validRows:[other,row,{...row}]}).input.map(r=>r.validOrdinal),[2,1,3]);
});
test('entity persistence updates only the changed domain row and rejects deletion, reordering and receipt replacement',async()=>{
 const before=tenantPayload(snapshot(),'acme'),after=structuredClone(before),calls:any[]=[];after.business.devices[0].name='核验后的名称';const client={query:async(text:string,values:any[])=>{calls.push({text,values});return {rowCount:1};}} as any;
 await writeEntities(client,before,after,'acme');assert.equal(calls.length,1);assert.match(calls[0].text,/UPDATE business_devices/);assert.equal(calls[0].values[3].name,before.business.devices[0].name);assert.notEqual(before.business.devices[0].name,after.business.devices[0].name);
 const removed=structuredClone(before);removed.business.devices.pop();await assert.rejects(writeEntities(client,before,removed,'acme'),/removed or reordered/);
 const reordered=structuredClone(before);reordered.business.devices.reverse();await assert.rejects(writeEntities(client,before,reordered,'acme'),/removed or reordered/);
 const receipts=structuredClone(before);receipts.idempotency=[['acme:key',{digest:'a',response:{ok:true}}]];const changed=structuredClone(receipts);changed.idempotency[0][1]={digest:'b',response:{ok:true}};await assert.rejects(writeEntities(client,receipts,changed,'acme'),/Command receipts/);
});
test('historical v2 schema identities stay byte-compatible while v3 is added',()=>{
 assert.equal(revisionMigrationChecksum(false),'72f4713579c76db19f1cbd2b6e2734f4fc8955cfbf89f3e65de07897cf77f00d');
 assert.equal(revisionMigrationChecksum(true),'7bb511d344cfa9294b9f681675bd7f99b70518d9aa6ad3eb1dc3c41d666857dc');
});
test('ordinary batch metadata cannot change physical source rows or original filename during a later status update',async()=>{
 const store=seedStore(),data=emptyImports(),b=createBatch(data,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'qa',rows:[{source_record_id:'p',device_code:'P',device_name:'泵',site_code:'FACTORY-01',line_code:'LINE-01'}],original:Buffer.from('original bytes'),filename:'original.csv',mime:'text/csv',sourceKind:'MANUAL_FILE'},who),{audits,idempotency,...business}=store,before=tenantPayload({version:2,business,audits,idempotency:[...idempotency],imports:data},'acme');
 for(const patch of [{filename:'rewritten.csv'},{lineNumbers:[999]},{snapshotDigest:'forged'}]){const after=structuredClone(before);Object.assign(after.imports.batches[0],patch);await assert.rejects(writeEntities({query:async()=>({rowCount:1})} as any,before,after,'acme'),/Frozen batch metadata/);}assert.equal(b.filename,'original.csv');
});
