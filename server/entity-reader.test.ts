import test from 'node:test';
import assert from 'node:assert/strict';
import {EntityRows,readEntityRows} from './entity-reader.ts';
import {seedStore} from './store.ts';
import {emptyImports} from './imports.ts';
import {tenantPayload} from './entity-repository.ts';
import {AsyncResource} from 'node:async_hooks';
import {memoryTask,resident,estimatedBytes,holdAllocation,limits} from './capacity.ts';
const make=()=>{const {audits,idempotency,...business}=seedStore(),p=tenantPayload({version:2,business,imports:emptyImports(),audits,idempotency:[...idempotency]},'acme');return [{kind:'state',tenant_id:'acme',identity:'acme',ordinal:'1',detail:{schemaVersion:3,payloadDigest:'test'},content:null},...Object.entries(p.business).flatMap(([key,items])=>items.map((body,i)=>({kind:'business:'+key,tenant_id:'acme',identity:body.id,ordinal:String(i+1),detail:body,content:null})))];};
test('relational reconstruction orders by authoritative ordinal and keeps validated input objects independent',()=>{
 const rows:any[]=make();rows.push({kind:'batch',tenant_id:'acme',identity:'batch',ordinal:'1',detail:{batchId:'batch',fileSha256:'sha'},content:null},{kind:'file',tenant_id:'acme',identity:'batch',ordinal:'0',detail:{sha256:'sha'},content:'YWJj'},...[[2,'B'],[1,'A']].map(([i,x])=>({kind:'input',tenant_id:'acme',identity:'batch',ordinal:String(i),detail:{validOrdinal:i,body:{x}},content:null})));
 const state=new EntityRows('acme');for(const row of rows.reverse())state.add(row);const loaded=state.finish(),b=loaded.payload.imports.batches[0];assert.deepEqual(b.rows,[{x:'A'},{x:'B'}]);assert.deepEqual(b.validRows,b.rows);assert.notEqual(b.validRows[0],b.rows[0]);assert.equal(loaded.payload.business.devices[0].id,'dev-1');
});
test('the pg result array stays bounded and row validation errors reject after drain',async()=>{
 let maximum=0,seen=0;const rows=make();
 const client:any={query:(q:any)=>queueMicrotask(()=>{const result={rows:[] as any[]};for(const row of rows){q.emit('row',row,result);result.rows.push(row);maximum=Math.max(maximum,result.rows.length);seen++;}q.callback(null,result);})};
 await readEntityRows(client,'acme');assert.equal(maximum,1);assert.equal(seen,rows.length);
 seen=0;await assert.rejects(readEntityRows(client,'sandbox'),/foreign tenant/);assert.equal(seen,rows.length);
 const broken:any={query:(q:any)=>queueMicrotask(()=>q.callback(Error('SQL unavailable')))};await assert.rejects(readEntityRows(broken,'acme'),/SQL unavailable/);
});
test('orphan input/files and SQL audit-column drift cannot be hidden by payload assembly',()=>{
 for(const row of [{kind:'file',identity:'orphan',detail:{sha256:'sha'}},{kind:'input',identity:'orphan',detail:{body:{},validOrdinal:null}},{kind:'audit',identity:'id',detail:{event:{eventId:'id',tenantId:'acme',hash:'h',previousHash:'p'},hash:'bad',previousHash:'p'}}]){const state=new EntityRows('acme');for(const x of make())state.add(x as any);state.add({...row,tenant_id:'acme',ordinal:'1',content:null} as any);assert.throws(()=>state.finish());}
});
test('row accounting uses its submitting task context even on a socket created by a released startup task',async()=>{
 let socket!:AsyncResource;await memoryTask(async()=>{socket=new AsyncResource('old-startup-socket');},true);let high=0;
 const client:any={query:(q:any)=>queueMicrotask(()=>socket.runInAsyncScope(()=>{const result={rows:[] as any[]};for(const row of make()){q.emit('row',row,result);result.rows.push(row);high=Math.max(high,resident.snapshot().categories.task||0);}q.callback(null,result);}))};
 const before=resident.snapshot().total;await memoryTask(()=>readEntityRows(client,'acme'),true);assert.ok(high>65536);assert.equal(resident.snapshot().total,before);socket.emitDestroy();
});
test('finished SQL envelopes transfer to the retained payload exactly once',async()=>{
 const baseline=resident.snapshot().total;
 await memoryTask(async()=>{
  const initial=resident.snapshot().total,state=new EntityRows('acme');
  for(const row of make())state.add(row as any);
  const wire=resident.snapshot().total-initial,loaded=state.finish();
  assert.equal(resident.snapshot().total-initial,estimatedBytes(loaded.payload));
  assert.ok(wire>estimatedBytes(loaded.payload));
  state.discard();state.discard();
  assert.equal(resident.snapshot().total-initial,estimatedBytes(loaded.payload),'discard cannot release the returned payload');
  assert.throws(()=>state.finish(),/closed/);assert.throws(()=>state.add(make()[0] as any),/closed/);
 },true);
 assert.equal(resident.snapshot().total,baseline);
});
test('assembly failure and over-budget row release only their own lease before task completion',async()=>{
 const baseline=resident.snapshot().total;
 await memoryTask(async()=>{
  const releaseOther=holdAllocation(100000),initial=resident.snapshot().total;
  for(const invalid of ['audit','unknown']){
   const state=new EntityRows('acme');for(const row of make())state.add(row as any);
   state.add({kind:invalid,tenant_id:'acme',identity:'bad',ordinal:'1',content:null,detail:{event:{}}});
   assert.throws(()=>state.finish());assert.equal(resident.snapshot().total,initial);
  }
  const state=new EntityRows('acme');for(const row of make())state.add(row as any);
  assert.throws(()=>state.add({kind:'unknown',tenant_id:'acme',identity:'large',ordinal:'1',content:null,detail:'x'.repeat(limits.taskBytes/2)}),(error:any)=>error.code==='MEMORY_BUDGET');
  assert.equal(resident.snapshot().total,initial);state.discard();releaseOther();
 },true);
 assert.equal(resident.snapshot().total,baseline);
});
test('partial SQL failure, synchronous submission failure and invalid-row drain release temporary rows',async()=>{
 const baseline=resident.snapshot().total;
 await memoryTask(async()=>{
  const initial=resident.snapshot().total;let drained=0;
  const partial:any={query:(q:any)=>queueMicrotask(()=>{for(const row of make())q.emit('row',row,{rows:[]});q.callback(Error('cancelled'));})};
  await assert.rejects(readEntityRows(partial,'acme'),/cancelled/);assert.equal(resident.snapshot().total,initial);
  const synchronous:any={query:(q:any)=>{q.emit('row',make()[0],{rows:[]});throw Error('submit failed');}};
  await assert.rejects(readEntityRows(synchronous,'acme'),/submit failed/);assert.equal(resident.snapshot().total,initial);
  const invalid:any={query:(q:any)=>queueMicrotask(()=>{for(const row of make()){q.emit('row',{...row,tenant_id:'other'},{rows:[]});drained++;}q.callback(null,{rows:[]});})};
  await assert.rejects(readEntityRows(invalid,'acme'),/foreign tenant/);assert.equal(drained,make().length);assert.equal(resident.snapshot().total,initial);
 },true);assert.equal(resident.snapshot().total,baseline);
});
