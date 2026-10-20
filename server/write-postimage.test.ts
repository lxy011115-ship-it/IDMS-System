import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {seedStore} from './store.ts';
import {createBatch,emptyImports,digest} from './imports.ts';
import {tenantPayload,type TenantPayload} from './entity-repository.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {entityTables} from './entity-schema.ts';
import {entityRowsSql} from './entity-reader.ts';
import {PostImageVerifier,postImageRowsSql,verifyPostImage,type PostImageRow} from './write-postimage.ts';
import {memoryTask,resident,limits,estimatedBytes} from './capacity.ts';
const tenant='acme',revision=7,oldDigest=digest('persisted-before'),invalid=(e:any)=>e.status===503&&/写入后/.test(e.message);
function fixture(){
 const store=seedStore(),imports=emptyImports(),a={source_record_id:'a',device_code:'PI-A',device_name:'甲',site_code:'F',line_code:'L'},b={...a,source_record_id:'b',device_code:'PI-B',device_name:'乙'};
 const batch=createBatch(imports,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'post-image',rows:[a,b],original:Buffer.from('post-image-original'),filename:'unit.json',mime:'application/json',sourceKind:'API_JSON'},{tenantId:tenant,actorId:'demo.uploader',actorType:'USER',correlationId:'unit'});
 // Exercise wire-level validOrdinal semantics with repeated equal input bodies.
 batch.rows=[a,b,a,{...a,source_record_id:'invalid',device_code:''}];batch.validRows=[b,a,a];
 imports.records.push({tenantId:tenant,dataType:'DEVICE',batchId:batch.batchId,row:2,sourceSystem:'post-image',value:a});imports.requests.push({key:'acme:upload:unit',digest:digest('request'),batchId:batch.batchId});store.idempotency.set('acme:command:unit',{ok:true});store.idempotency.set('acme:command:null',null);
 store.workOrders.push({id:'order-unit',tenantId:tenant,state:'OPEN',version:1,deviceCode:'PI-A',custom:{note:'核对冗余镜像'}} as any);
 const {audits,idempotency,...business}=store;return tenantPayload({version:2,business,imports,audits,idempotency:[...idempotency]},tenant);
}
// Independent small model of the SQL wire rows. Valid positions are assigned
// from validRows to matching unused input positions, not by the verifier logic.
function rowsFor(p:TenantPayload){
 const rows:PostImageRow[]=[],add=(kind:string,identity:string,ordinal:string,detail:any,content:string|null=null)=>rows.push({kind,tenant_id:tenant,identity,ordinal,detail,content});add('state',tenant,String(revision),{schemaVersion:3,payloadDigest:oldDigest});
 for(const [name,items]of Object.entries(p.business))for(const [i,item]of items.entries())add('business:'+name,item.id,String(i+1),item);
 for(const [i,batch]of p.imports.batches.entries()){
  add('batch',batch.batchId,String(i+1),Object.fromEntries(Object.entries(batch).filter(([k])=>!['rows','validRows','originalBase64'].includes(k))));add('file',batch.batchId,'0',{sha256:batch.fileSha256},batch.originalBase64);
  const valid:(number|null)[]=Array(batch.rows.length).fill(null);for(const [j,row]of batch.validRows.entries()){const input=batch.rows.findIndex((v,k)=>valid[k]===null&&canonicalEqual(v,row));assert.ok(input>=0);valid[input]=j+1;}
  for(const [j,row]of batch.rows.entries())add('input',batch.batchId,String(j+1),{body:row,validOrdinal:valid[j]});
 }
 for(const [i,row]of p.imports.records.entries())add('record',row.batchId,String(i+1),row);
 for(const [i,row]of p.imports.requests.entries())add('request',row.key,String(i+1),row);
 for(const [i,[key,body]]of p.idempotency.entries())add('receipt',key,String(i+1),body);
 for(const [i,event]of p.audits.entries())add('audit',event.eventId,String(11+i*3),{event,hash:event.hash,previousHash:event.previousHash});
 for(const order of p.business.workOrders)add('mirror',order.id,'0',order);return structuredClone(rows);
}
function check(p:TenantPayload,rows:PostImageRow[]){const verifier=new PostImageVerifier(p,tenant,revision,oldDigest);try{for(const row of rows)verifier.accept(row);return verifier.finish();}finally{verifier.dispose();}}
test('post-image SQL retains every full-reader section byte-for-byte and covers unordered rows with audit gaps',()=>{
 assert.equal(postImageRowsSql.replace('/* IDMS_POST_IMAGE_ROWS */','/* IDMS_ENTITY_ROWS */'),entityRowsSql);const p=fixture(),rows=rowsFor(p),before=canonicalDigest(p);assert.equal(check(p,rows.slice().reverse()).rows,rows.length);assert.equal(canonicalDigest(p),before);assert.ok(check(p,rows).indexBytes<200000);
 const audits=rows.filter(r=>r.kind==='audit');audits.forEach((r,i)=>r.ordinal=String(9223372036854775700n+BigInt(i)*3n));check(p,rows);
 const empty:TenantPayload={business:Object.fromEntries(Object.keys(entityTables).map(k=>[k,[]])) as any,imports:{batches:[],records:[],requests:[]},audits:[],idempotency:[]};assert.equal(check(empty,rowsFor(empty)).rows,1);
});
test('every source kind rejects missing, duplicated, changed identity, body or foreign rows',()=>{
 const p=fixture(),rows=rowsFor(p);for(const kind of new Set(rows.map(r=>r.kind))){const position=rows.findIndex(r=>r.kind===kind),without=rows.filter((_,i)=>i!==position);assert.throws(()=>check(p,without),invalid,kind+' missing');assert.throws(()=>check(p,[...rows,rows[position]]),invalid,kind+' duplicate');
  for(const field of ['identity','tenant_id','detail','content'] as const){const bad=structuredClone(rows);(bad[position] as any)[field]=field==='detail'?{changed:true}:'untrusted';assert.throws(()=>check(p,bad),invalid,kind+' '+field);}
 }
 for(const ordinal of ['-1','01','','1.5','9223372036854775808']){const bad=structuredClone(rows);bad[0].ordinal=ordinal;assert.throws(()=>check(p,bad),invalid);}assert.throws(()=>check(p,[...rows,{...rows[0],kind:'unknown'}]),invalid);
});
test('input body, valid ordinal coverage and order, orphan files and frozen bytes all remain checked',()=>{
 const p=fixture(),rows=rowsFor(p),input=rows.findIndex(r=>r.kind==='input'),file=rows.findIndex(r=>r.kind==='file');
 for(const mutate of [(r:PostImageRow[])=>r[input].detail.validOrdinal=0,(r:PostImageRow[])=>r[input].detail.validOrdinal='2',(r:PostImageRow[])=>r[input].detail.validOrdinal=1,(r:PostImageRow[])=>r[input].detail.validOrdinal=null,(r:PostImageRow[])=>r[input+1].detail.validOrdinal=r[input].detail.validOrdinal,(r:PostImageRow[])=>r[input].detail.body.device_name='CHANGED',(r:PostImageRow[])=>r[input].detail.extra=true,(r:PostImageRow[])=>r[file].identity='orphan',(r:PostImageRow[])=>r[file].detail.sha256='wrong',(r:PostImageRow[])=>r[file].content+='\n',(r:PostImageRow[])=>r[file].ordinal='1']){const bad=structuredClone(rows);mutate(bad);assert.throws(()=>check(p,bad),invalid);}
});
test('audit SQL order and every historical event/column are checked, including unchanged old events',()=>{
 const p=fixture(),rows=rowsFor(p),positions=rows.map((r,i)=>r.kind==='audit'?i:-1).filter(i=>i>=0);assert.ok(positions.length>=2);
 for(const mutate of [(r:PostImageRow[])=>r[positions[0]].detail.event.action='OLD_TAMPER',(r:PostImageRow[])=>r[positions[0]].detail.hash='wrong',(r:PostImageRow[])=>r[positions[0]].detail.previousHash='wrong',(r:PostImageRow[])=>r[positions[0]].ordinal=r[positions[1]].ordinal,(r:PostImageRow[])=>{const a=r[positions[0]].ordinal;r[positions[0]].ordinal=r[positions[1]].ordinal;r[positions[1]].ordinal=a;}]){const bad=structuredClone(rows);mutate(bad);assert.throws(()=>check(p,bad),invalid);}
});
test('state schema, original revision and digest must survive the domain callback until the final update',()=>{
 const p=fixture(),rows=rowsFor(p);for(const patch of [{ordinal:'8'},{detail:{schemaVersion:4,payloadDigest:oldDigest}},{detail:{schemaVersion:3,payloadDigest:digest('forged')}},{identity:'sandbox'}]){const bad=structuredClone(rows);bad[0]={...bad[0],...patch};assert.throws(()=>check(p,bad),invalid);}
 assert.throws(()=>new PostImageVerifier(p,tenant,Number.MAX_SAFE_INTEGER+1,oldDigest),invalid);assert.throws(()=>new PostImageVerifier(p,tenant,revision,'bad'),invalid);
});
test('unrepresentable envelope fields and receipt tuple tails cannot produce a digest absent from SQL reconstruction',()=>{
 for(const mutate of [(p:any)=>p.extra=[],(p:any)=>p.imports.extra=[],(p:any)=>p.business.extra=[],(p:any)=>p.idempotency[0].push('ignored-tail'),(p:any)=>delete p.imports.requests]){const p=fixture();mutate(p);assert.throws(()=>new PostImageVerifier(p,tenant,revision,oldDigest),invalid);}
});
function clientFor(rows:PostImageRow[],options:{fail?:boolean;afterRow?:()=>void;socket?:AsyncResource}={}){let consumed=0,max=0;const client:any={query(q:any){queueMicrotask(()=>{const run=()=>{const result={rows:[] as any[]};for(const row of rows){q.emit('row',row,result);result.rows.push(row);max=Math.max(max,result.rows.length);consumed++;options.afterRow?.();}q.callback(options.fail?Error('SQL_FAIL'):null,result);};options.socket?options.socket.runInAsyncScope(run):run();});}};return {client,stats:()=>({consumed,max})};}
test('post-image streaming drains early failures and database errors and releases all indexes and transient rows',async()=>{
 const p=fixture(),rows=rowsFor(p),before=resident.snapshot().total;let socket!:AsyncResource;await memoryTask(async()=>{socket=new AsyncResource('ended-bootstrap');},true);
 const ok=clientFor(rows,{socket});await memoryTask(()=>verifyPostImage(ok.client,tenant,p,revision,oldDigest),true);assert.equal(ok.stats().max,1);
 const bad=structuredClone(rows);bad[0].detail.payloadDigest='forged';const fault=clientFor(bad,{socket});await assert.rejects(memoryTask(()=>verifyPostImage(fault.client,tenant,p,revision,oldDigest),true),invalid);assert.equal(fault.stats().consumed,rows.length);assert.equal(fault.stats().max,1);
 await assert.rejects(memoryTask(()=>verifyPostImage(clientFor(rows,{fail:true}).client,tenant,p,revision,oldDigest),true),invalid);assert.equal(resident.snapshot().total,before);socket.emitDestroy();
});
test('write post-image row accounting is reusable rather than cumulative across many large facts',async()=>{
 const p=fixture();p.imports.records=Array.from({length:1000},(_,i)=>({...p.imports.records[0],row:i+2,value:{source_record_id:'r'+i,sample:'x'.repeat(8192)}}));const rows=rowsFor(p);let peak=0;const mock=clientFor(rows,{afterRow:()=>peak=Math.max(peak,resident.snapshot().categories.task||0)}),before=resident.snapshot().total;
 await memoryTask(()=>verifyPostImage(mock.client,tenant,p,revision,oldDigest),true);assert.ok(peak<estimatedBytes(rows)/10);assert.ok(peak<1024*1024);assert.equal(resident.snapshot().total,before);
});
test('index reservation rejects before issuing SQL and failed row reservation returns its owner budget',async()=>{
 const p=fixture(),rows=rowsFor(p),before=resident.snapshot().total,blocker=resident.account('task');blocker.grow(limits.taskTotalBytes-65537);const mock=clientFor(rows);try{await assert.rejects(memoryTask(()=>verifyPostImage(mock.client,tenant,p,revision,oldDigest),true),e=>(e as any).code==='MEMORY_BUDGET');assert.equal(mock.stats().consumed,0);}finally{blocker.release();}assert.equal(resident.snapshot().total,before);
 const verifier=new PostImageVerifier(p,tenant,revision,oldDigest),indexBytes=verifier.indexBytes;verifier.dispose();const other=resident.account('task');other.grow(limits.taskTotalBytes-65536-indexBytes-1024);try{await assert.rejects(memoryTask(()=>verifyPostImage(clientFor(rows).client,tenant,p,revision,oldDigest),true),e=>(e as any).code==='MEMORY_BUDGET');}finally{other.release();}assert.equal(resident.snapshot().total,before);
});
