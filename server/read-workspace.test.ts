import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {projectVerifiedRead,bindReadWorkspace} from './read-workspace.ts';
import {parseAuditPage} from './audit-page.ts';
import {memoryAuditCursorCodec} from './audit-cursor.ts';
import {streamRows} from './pg-row-stream.ts';
import {seedStore} from './store.ts';
import {createBatch,emptyImports,present,digest} from './imports.ts';
import {tenantPayload} from './entity-repository.ts';
import {workspacePayload,type Workspace} from './tenant-workspace.ts';
import {memoryTask,resident,requestResources,accountValue,limits} from './capacity.ts';
const make=()=>{const store=seedStore(),imports=emptyImports(),bytes=Buffer.from('original-content');createBatch(imports,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'read-unit',rows:[{source_record_id:'r1',device_code:'RW-1',device_name:'泵',site_code:'F',line_code:'L'}],original:bytes,filename:'unit.json',mime:'application/json',sourceKind:'API_JSON'},{tenantId:'acme',actorId:'demo.uploader',actorType:'USER',correlationId:'unit'});const {audits,idempotency,...business}=store;return {bytes,payload:tenantPayload({version:2,business,imports,audits,idempotency:[...idempotency]},'acme')};};
test('read projection excludes file, audit and receipts, freezes data and preserves public batch DTO',()=>{
 const {payload}=make(),read=projectVerifiedRead(payload);assert.equal('audits'in read.store,false);assert.equal('idempotency'in read.store,false);assert.equal('requests'in read.imports,false);assert.equal('originalBase64'in read.imports.batches[0],false);assert.deepEqual(present(read.imports.batches[0]),present(payload.imports.batches[0]));assert.equal('originalBase64'in present(payload.imports.batches[0]),false);assert.throws(()=>read.imports.batches[0].rows[0].device_name='poison');assert.notEqual(read.imports.batches[0].rows[0],payload.imports.batches[0].rows[0]);assert.throws(()=>workspacePayload(read as unknown as Workspace,'acme'));
});
test('original provider binds exact batch and snapshot lifetime and checks metadata and bytes',async()=>{
 const {payload,bytes}=make(),read=projectVerifiedRead(payload),calls:string[]=[];const client:any={query:async(sql:string)=>{calls.push(sql);return {rows:sql.includes('META')?[{sha256:digest(bytes),bytes:bytes.length}]:[{sha256:digest(bytes),content:bytes}]};}};const scope=bindReadWorkspace(read,client,'acme');await assert.rejects(scope.workspace.readOriginal({...read.imports.batches[0]}),/不匹配/);assert.equal(calls.length,0);assert.deepEqual(await scope.workspace.readOriginal(read.imports.batches[0]),bytes);await scope.close();await assert.rejects(scope.workspace.readOriginal(read.imports.batches[0]),/已结束/);assert.equal(calls.length,2);
 const bad=bindReadWorkspace(read,{query:async()=>({rows:[{sha256:'bad',bytes:bytes.length}]})} as any,'acme');await assert.rejects(bad.workspace.readOriginal(read.imports.batches[0]),/绑定/);await bad.close();
});
test('output refusal occurs before selecting original bytes',async()=>{
 const {payload,bytes}=make(),read=projectVerifiedRead(payload);let calls=0;const scope=bindReadWorkspace(read,{query:async()=>{calls++;return {rows:[{sha256:digest(bytes),bytes:bytes.length}]};}} as any,'acme');const controller=new AbortController();await requestResources.run({signal:controller.signal,bindTenant(){},reserveBody(){},prepareResult(){},reserveOutput(){throw Error('OUTPUT_DENIED');}},()=>assert.rejects(scope.workspace.readOriginal(read.imports.batches[0]),/OUTPUT_DENIED/));assert.equal(calls,1);await scope.close();
});
test('audit provider verifies full chain and SQL column binding and cannot escape the scope',async()=>{
 const {payload}=make(),read=projectVerifiedRead(payload);let corrupt='';const client:any={query:(q:any)=>queueMicrotask(()=>{const result={rows:[] as any[]};for(const event of payload.audits){q.emit('row',{tenant_id:'acme',event_id:event.eventId,hash:corrupt==='column'?'bad':event.hash,previous_hash:event.previousHash,event:corrupt==='event'?{...event,action:'CORRUPTED'}:event},result);result.rows.push(event);}q.callback(null,result);})};
 const scope=bindReadWorkspace(read,client,'acme');assert.deepEqual(await scope.workspace.readAudits(),payload.audits);corrupt='column';await assert.rejects(scope.workspace.readAudits(),/绑定/);corrupt='event';await assert.rejects(scope.workspace.readAudits(),/链/);await scope.close();await assert.rejects(scope.workspace.readAudits(),/已结束/);
});
test('audit page provider binds tenant and lifetime, drains hidden errors and releases all failed page leases',async()=>{
 const {payload}=make(),data=projectVerifiedRead(payload),event=payload.audits.at(-1)!,codec=memoryAuditCursorCodec(),ctx={tenantId:'acme',actorId:'demo.auditor',actorType:'USER',correlationId:'unit'},plan=parseAuditPage(new URLSearchParams('pageSize=1'),ctx,codec)!;let count=0,bad=false;
 const client:any={query:(q:any)=>{count++;if(typeof q==='string')return Promise.resolve({rows:[{sequence:String(payload.audits.length),tenant_id:'acme',event_id:event.eventId,hash:event.hash}]});queueMicrotask(()=>{const result={rows:[] as any[]};for(const [i,event]of payload.audits.entries()){q.emit('row',{sequence:String(i+1),tenant_id:'acme',event_id:event.eventId,hash:event.hash,previous_hash:event.previousHash,event:bad&&i===0?{...event,action:'HIDDEN_TAMPER'}:event},result);result.rows.push(event);}q.callback(null,result);});}};
 const scope=bindReadWorkspace(data,client,'acme');await assert.rejects(scope.workspace.readAuditPage({...plan,tenantId:'sandbox'},()=>true),e=>(e as any).code==='AUDIT_INTEGRITY');assert.equal(count,0);
 const result=await memoryTask(()=>scope.workspace.readAuditPage(plan,()=>true),true);assert.deepEqual(result.items,[event]);assert.equal(result.expected.total,payload.audits.length);bad=true;const before=resident.snapshot().total;await assert.rejects(memoryTask(()=>scope.workspace.readAuditPage(plan,()=>false),true),e=>(e as any).code==='AUDIT_INTEGRITY');assert.equal(resident.snapshot().total,before);await scope.close();const ended=count;await assert.rejects(scope.workspace.readAuditPage(plan,()=>true),/已结束/);assert.equal(count,ended);
});
test('provider close drains an unawaited read but blocks its late result',async()=>{
 const {payload,bytes}=make(),read=projectVerifiedRead(payload);let release!:()=>void;const gate=new Promise<void>(ok=>release=ok),scope=bindReadWorkspace(read,{query:async()=>{await gate;return {rows:[{sha256:digest(bytes),bytes:bytes.length}]};}} as any,'acme');const pending=scope.workspace.readOriginal(read.imports.batches[0]);const refused=assert.rejects(pending,/已结束/);let closed=false;const close=scope.close().then(()=>closed=true);await Promise.resolve();assert.equal(closed,false);release();await close;await refused;
});
test('new streams bind submitting resource context, clear driver rows, and drain row failures',async()=>{
 let socket!:AsyncResource;await memoryTask(async()=>{socket=new AsyncResource('released-startup');},true);let seen=0,max=0;const client:any={query:(q:any)=>queueMicrotask(()=>socket.runInAsyncScope(()=>{const r={rows:[] as any[]};for(let n=0;n<10;n++){q.emit('row',{n},r);r.rows.push(n);max=Math.max(max,r.rows.length);seen++;}q.callback(null,r);}))};const before=resident.snapshot().total;await memoryTask(()=>streamRows(client,'test',row=>accountValue(row),()=>{}),true);assert.equal(max,1);let cleared=false;await assert.rejects(streamRows(client,'test',()=>{throw Error('INVALID_ROW');},()=>cleared=true),/INVALID_ROW/);assert.equal(seen,20);assert.equal(cleared,true);assert.equal(resident.snapshot().total,before);socket.emitDestroy();
});

test('raw-file task reservation and audit row budget reject before exposing bodies',async()=>{
 const {payload,bytes}=make(),data=projectVerifiedRead(payload);let queries=0;const file=bindReadWorkspace(data,{query:async()=>{queries++;return {rows:[{sha256:digest(bytes),bytes:limits.taskBytes}]};}} as any,'acme');
 await assert.rejects(memoryTask(()=>file.workspace.readOriginal(data.imports.batches[0]),true),e=>(e as any).code==='MEMORY_BUDGET');assert.equal(queries,1);await file.close();
 const blocker=resident.account('task');blocker.grow(limits.taskTotalBytes-65537);const event=payload.audits[0],client:any={query:(q:any)=>queueMicrotask(()=>{const result={rows:[]};q.emit('row',{tenant_id:'acme',event_id:event.eventId,hash:event.hash,previous_hash:event.previousHash,event},result);q.callback(null,result);})};const scope=bindReadWorkspace(data,client,'acme');try{await assert.rejects(memoryTask(()=>scope.workspace.readAudits(),true),e=>(e as any).code==='MEMORY_BUDGET');}finally{blocker.release();await scope.close();}
});
