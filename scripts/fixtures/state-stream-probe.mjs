import {instrumentSql} from './sql-row-metrics.mjs';
import assert from 'node:assert/strict';
import pg from 'pg';
import {seedStore} from '../../server/store.ts';
import {appendAudit} from '../../server/audit.ts';
if(!process.send||!/^stateqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned workspace QA IPC required');
const baseline=process.argv.includes('--baseline'),api=await import(baseline?'./state-baseline-import-api.ts':'../../server/import-api.ts'),repo=await import(baseline?'./state-baseline-postgres-repository.ts':'../../server/postgres-repository.ts');
const reader=await import(baseline?'./state-baseline-entity-repository.ts':'../../server/entity-repository.ts');
const {canonicalDigest}=await import('../../server/canonical-state.ts');
const store=seedStore();const gates=new Map(),references=new Map();let activeRead,paused;

let metrics;function reset(){global.gc?.();metrics={cloneCalls:0,cloneOriginalBase64Characters:0,crossTenantCloneCalls:0,queries:0,sqlRowJsonBytes:0,fullWorkspaceQueries:0,streamQueries:0,maxDriverRows:0,heapAtStart:process.memoryUsage().heapUsed,observedHeapHigh:process.memoryUsage().heapUsed};}reset();
function sampledHeap(){metrics.observedHeapHigh=Math.max(metrics.observedHeapHigh,process.memoryUsage().heapUsed);}
const nativeClone=global.structuredClone;
global.structuredClone=function(value,...rest){
 metrics.cloneCalls++;const data=value?.imports||value;metrics.cloneOriginalBase64Characters+=(data?.batches||[]).reduce((n,b)=>n+(b.originalBase64?.length||0),0);
 const tenants=value?.business?.tenants||value?.tenants;if(tenants?.length>1)metrics.crossTenantCloneCalls++;const result=nativeClone(value,...rest);sampledHeap();return result;
};
instrumentSql(()=>metrics,sampledHeap);
const startTime=performance.now();await api.loadImports(store);sampledHeap();const startup={...metrics,elapsedMs:performance.now()-startTime,maxRssKiB:process.resourceUsage().maxRSS};reset();
const instrumented=pg.Client.prototype.query;pg.Client.prototype.query=function(config,...args){if(activeRead?.pause&&config?.text?.includes('IDMS_ENTITY_ROWS'))config.once('row',()=>{this.connection.stream.pause();paused=this;process.send({type:'PAUSED',id:activeRead.id,pid:activeRead.pid});});return instrumented.call(this,config,...args);};
const current=w=>w||{store,imports:api.importData};
async function rawRead(m){const client=await repo.tenantPool(m.tenant).connect();try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');if(m.op==='timeout'){await client.query("SET LOCAL statement_timeout='1ms'");await assert.rejects(reader.readEntities(client,m.tenant),e=>e.code==='57014');await client.query('ROLLBACK');return true;}if(m.pause)activeRead={...m,pid:(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid};const r=await reader.readEntities(client,m.tenant);await client.query('COMMIT');return {payloadDigest:canonicalDigest(r.payload),firstName:r.payload.business.devices[0]?.name,rows:r.payload.imports.records.length};}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{activeRead=undefined;client.release();}}

async function command(m){
 if(['raw','timeout'].includes(m.op))return rawRead(m);
 if(m.op==='read')return api.consistentRead(store,m.tenant,async w=>{w=current(w);if(m.checkFrozen){assert.throws(()=>w.store.devices[0].name='READ_POISON');if('idempotency'in w.store)assert.throws(()=>w.store.idempotency.set(m.tenant+':read-poison',{}));else assert.equal(w.store.idempotency,undefined);}return {devices:w.store.devices.filter(d=>d.tenantId===m.tenant).map(d=>({id:d.id,name:d.name})),batches:w.imports.batches.filter(b=>b.tenantId===m.tenant).length,audits:(await (w.readAudits?w.readAudits():Promise.resolve(w.store.audits))).filter(a=>a.tenantId===m.tenant).length};});
 if(m.op==='mutateReturned'){const item=references.get(m.reference);item.name='AFTER_COMMIT_REFERENCE';return true;}
 if(m.op==='receipt')return api.transactionalRequest(store,m.tenant+':workspace-receipt','same-hash',async(_client,w)=>{w=current(w);appendAudit(w.store,{tenantId:m.tenant,objectType:'QA',objectId:'receipt',action:'QA_RECEIPT_ONCE',actorType:'SYSTEM',actorId:'workspace-qa',correlationId:m.id});return {token:m.id};},m.tenant);
 return api.mutate(store,async(client,w)=>{
  w=current(w);const device=w.store.devices.find(d=>d.tenantId===m.tenant);assert.ok(device);if(m.op==='nested')return api.mutate(store,async()=>true,m.tenant);
  if(m.op==='foreign'){w.store.devices.push({...device,id:'foreign',tenantId:'sandbox'});return true;}
  device.name=m.label;appendAudit(w.store,{tenantId:m.tenant,objectType:'QA',objectId:device.id,action:'QA_WORKSPACE_WRITE',actorType:'SYSTEM',actorId:'workspace-qa',correlationId:m.id});
  if(m.op==='hold'){let release;const ready=new Promise(ok=>release=ok);gates.set(m.id,release);process.send({type:'ENTERED',id:m.id,pid:(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid});await ready;gates.delete(m.id);}
  if(m.fail)throw Error('QA_ROLLBACK');return device;
 },m.tenant);
}
process.on('message',m=>{
 if(m.type==='RELEASE'){if(paused){paused.connection.stream.resume();paused=undefined;}gates.get(m.id)?.();return;}
 if(m.type==='RESET'){reset();process.send({type:'DONE',id:m.id,value:true});return;}
 if(m.type==='METRICS'){sampledHeap();process.send({type:'DONE',id:m.id,value:{...metrics,maxRssKiB:process.resourceUsage().maxRSS}});return;}
 if(m.type==='CLOSE'){void api.waitForWrites().then(()=>repo.closePostgres()).then(()=>process.disconnect());return;}
 if(m.type!=='RUN')return;const start=performance.now();void command(m).then(value=>{references.set(m.id,value);sampledHeap();process.send({type:'DONE',id:m.id,value,elapsedMs:performance.now()-start});},error=>process.send({type:'DONE',id:m.id,error:error.message}));
});
process.send({type:'READY',baseline,rootFrozen:Object.isFrozen(store),startup});
