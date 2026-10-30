import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spareQueryPlan,sparePageCursor,sparePageAnchor} from './spares-query-plan.ts';
import {readSparesQuery} from './spares-query-db.ts';
import {requestResources,resident} from './capacity.ts';
import {EventEmitter} from 'node:events';
const ctx={tenantId:'qa',actorId:'clerk',actorType:'USER',authMode:'oidc' as const,roles:['spare-parts-clerk'],correlationId:'test'},stamp={revision:'20001',publicRevision:'123'};
test('paged query parameters reject ambiguous, duplicate, unknown and oversized fields',()=>{
 for(const query of ['kind=part&kind=part','kind=part&limit=0','kind=part&limit=101','kind=part&limit=01','kind=part&page=1','kind=part&supplierId=123','kind=part&cursor=','kind=part&q=%00','kind=part&q='+('字'.repeat(161))])assert.throws(()=>spareQueryPlan('list',new URLSearchParams(query)),e=>e.status===400);
 assert.throws(()=>spareQueryPlan('summary',new URLSearchParams('limit=30')));
 assert.throws(()=>spareQueryPlan('list',new URLSearchParams('kind=part&supplierId=00000000-0000-0000-0000-000000000001')));
 assert.equal(spareQueryPlan('list',new URLSearchParams('kind=stock')).limit,30);
 assert.equal(spareQueryPlan('options',new URLSearchParams('kind=device&id=Pump-UPPER')).id,'Pump-UPPER');
 const id='00000000-0000-0000-0000-000000000001';assert.equal(spareQueryPlan('options',new URLSearchParams('kind=link&partId='+id+'&deviceCode=Pump-UPPER')).partId,id);
 assert.throws(()=>spareQueryPlan('options',new URLSearchParams('kind=part&deviceCode=Pump-UPPER')));assert.throws(()=>spareQueryPlan('list',new URLSearchParams('kind=part&workOrderId=wo')));
});
test('cursor binds actor, scope, tenant, query and both business revisions',()=>{
 const plan=spareQueryPlan('list',new URLSearchParams('kind=part&limit=2')),anchor={first:'2026-10-30T00:00:00.000Z',second:'00000000-0000-0000-0000-000000000001'},cursor=sparePageCursor(ctx,plan,stamp,anchor),next={...plan,cursor};
 assert.deepEqual(sparePageAnchor(ctx,next,stamp),anchor);
 for(const changed of [{...ctx,actorId:'other'},{...ctx,tenantId:'other'},{...ctx,roles:['auditor']},{...ctx,scope:{sites:['F2'],lines:['*'],devices:['*'],provided:true}}])assert.throws(()=>sparePageAnchor(changed,next,stamp),e=>e.status===409);
 for(const changed of [{...stamp,revision:'20002'},{...stamp,publicRevision:'124'}])assert.throws(()=>sparePageAnchor(ctx,next,changed),e=>e.status===409);
 assert.throws(()=>sparePageAnchor(ctx,{...next,q:'different'},stamp),e=>e.status===409);
 assert.throws(()=>sparePageAnchor(ctx,{...next,cursor:cursor.slice(0,-2)+'zz'},stamp),e=>e.status===400);
 assert.throws(()=>sparePageAnchor(ctx,{...next,cursor:'.invalid'},stamp),e=>e.status===400);
});
test('insight parameters require exact references and cursors bind the basis and tuple',()=>{
 const partId='00000000-0000-0000-0000-000000000001',warehouseId='00000000-0000-0000-0000-000000000002',params=new URLSearchParams({partId,warehouseId,limit:'1'}),plan=spareQueryPlan('stock-insight',params);
 assert.equal(plan.basis,'plans');assert.equal(spareQueryPlan('material-plans',new URLSearchParams('workOrderId=WO-UPPER')).workOrderId,'WO-UPPER');
 for(const query of ['partId='+partId,'partId='+partId+'&warehouseId='+warehouseId+'&basis=unknown','partId='+partId+'&warehouseId='+warehouseId+'&warehouseId='+warehouseId,'partId='+partId+'&warehouseId='+warehouseId+'&q=hidden'])assert.throws(()=>spareQueryPlan('stock-insight',new URLSearchParams(query)),e=>e.status===400);
 for(const endpoint of ['material-plans','replacement-insight'] as const)assert.throws(()=>spareQueryPlan(endpoint,new URLSearchParams()),e=>e.status===400);
 assert.equal(spareQueryPlan('replacement-insight',new URLSearchParams({linkId:partId})).linkId,partId);
 const anchor={first:'2026-12-01',second:partId},cursor=sparePageCursor(ctx,plan,stamp,anchor),next={...plan,cursor};
 assert.deepEqual(sparePageAnchor(ctx,next,stamp),anchor);
 for(const changed of [{...next,basis:'purchases'},{...next,warehouseId:partId},{...next,partId:warehouseId}])assert.throws(()=>sparePageAnchor(ctx,changed,stamp),e=>e.status===409);
});
test('cancelled reads do not borrow a connection and release a begun transaction after proof cancellation',async()=>{
 const before=resident.snapshot().total,controller=new AbortController();let acquired=0,released=0;const calls:string[]=[];
 let destroyed=false;const client=Object.assign(new EventEmitter(),{async query(sql:string){calls.push(sql);return {rows:sql.includes('to_regclass')?[{relation:'qa-present'}]:sql.includes('SELECT version')?[{version:1}]:[]};},release(remove?:boolean){released++;destroyed=!!remove;if(remove)queueMicrotask(()=>client.emit('end'));}}),pool={async connect(){acquired++;return client;}};
 controller.abort();await requestResources.run({signal:controller.signal} as any,async()=>assert.rejects(readSparesQuery(pool as any,ctx,'summary',new URLSearchParams(),async()=>{}),e=>e.status===499));assert.equal(acquired,0);
 const second=new AbortController();await requestResources.run({signal:second.signal} as any,async()=>assert.rejects(readSparesQuery(pool as any,ctx,'summary',new URLSearchParams(),async c=>{assert.equal(c,client);second.abort();}),e=>e.status===499));
 assert.equal(acquired,1);assert.equal(released,1);assert.equal(destroyed,true);assert.ok(!calls.includes('COMMIT'));assert.equal(resident.snapshot().total,before);
});
