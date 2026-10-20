import {createServer} from 'node:http';
import pg from 'pg';
import {resident,MemoryLedger,sqlScheduler,workScheduler} from '../../server/capacity.ts';
import * as api from '../../server/import-api.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^batchpagesqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned batch-pages QA IPC required');
let metrics,fault,hold,release;const reset=()=>metrics={full:0,lean:0,cold:0,batch:0,inputPages:0,factPages:0,scopeRows:0,maxPageRows:0,maxDriverRows:0,peakTaskBytes:0,faults:0};reset();
const sample=()=>metrics.peakTaskBytes=Math.max(metrics.peakTaskBytes,resident.snapshot().categories.task||0),factory=MemoryLedger.prototype.account;MemoryLedger.prototype.account=function(...args){const a=factory.apply(this,args),grow=a.grow,hold=a.hold;a.grow=bytes=>{grow(bytes);sample();};a.hold=bytes=>{const r=hold(bytes);sample();return r;};return a;};
const original=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 const sql=typeof config==='string'?config:config?.text||'',input=sql.includes('IDMS_BATCH_INPUT_PAGE'),facts=sql.includes('IDMS_BATCH_FACT_PAGE'),scope=sql.includes('IDMS_BATCH_SCOPE_');
 if(sql.includes('IDMS_ENTITY_ROWS'))metrics.full++;if(sql.includes('IDMS_READ_WORKSPACE_ROWS'))metrics.lean++;if(sql.includes('IDMS_COLD_CANONICAL_ROWS'))metrics.cold++;if(sql.includes('IDMS_BATCH_'))metrics.batch++;if(input)metrics.inputPages++;if(facts)metrics.factPages++;
 if(config?.on){config.on('row',(_r,result)=>{if(scope)metrics.scopeRows++;sample();if(result&&!result.qaMeasured){result.qaMeasured=true;const add=result.addRow;result.addRow=function(row){add.call(this,row);metrics.maxDriverRows=Math.max(metrics.maxDriverRows,this.rows.length);};}});return original.call(this,config,...args);}
 const run=()=>original.call(this,config,...args);let pending;if(hold&&sql.includes(hold)){hold=undefined;pending=new Promise(ok=>release=ok).then(run);process.send({type:'ENTERED',target:'page'});}else pending=run();
 if(!pending?.then)return pending;return pending.then(result=>{sample();if(input||facts){metrics.maxPageRows=Math.max(metrics.maxPageRows,result.rows.length);if(fault){const target=fault;fault=undefined;metrics.faults++;const rows=result.rows,row=rows[0];if(target==='DROP')rows.shift();else if(target==='DUPLICATE')rows.push(structuredClone(row));else if(target==='TENANT')row.tenant_id='sandbox';else if(target==='SOURCE')row.source_line=0;else if(target==='ORDER')row.input_index='99';else if(target==='HASH')row.snapshot_digest='0'.repeat(64);else if(target==='SYSTEM')row.source_system='other';else if(target==='BODY')row.body={...row.body,source_record_id:'foreign'};else if(target==='QUERY')throw Error('PRIVATE QUERY MUST NOT ESCAPE');}}return result;});
};
try{const runtime=await import('../../server/index.ts'),startup=structuredClone(metrics),server=createServer(runtime.handler);await new Promise(ok=>server.listen(Number(process.env.PORT),'127.0.0.1',ok));
process.on('message',m=>{if(m.type==='RELEASE'){release?.();release=undefined;return;}void(async()=>{
 if(m.type==='RESET'){reset();return;}if(m.type==='FAULT'){fault=m.target;return;}if(m.type==='HOLD'){hold=m.target||'IDMS_BATCH_INPUT_PAGE';return;}if(m.type==='CLEAR'){api.clearWorkspaceCache();return;}
 if(m.type==='STATS')return {...metrics,memory:resident.snapshot(),sql:sqlScheduler.snapshot(),work:workScheduler.snapshot(),cache:api.workspaceCacheSnapshot()};
 if(m.type==='CLOSE'){release?.();await new Promise(ok=>server.close(ok));await runtime.closeRuntime();process.send({type:'DONE',id:m.id},()=>process.disconnect());return 'CLOSED';}
 throw Error('Unknown owned batch-pages operation');})().then(value=>{if(value!=='CLOSED')process.send({type:'DONE',id:m.id,value});},error=>process.send({type:'DONE',id:m.id,error:{message:error.message,code:error.code}}));});process.send({type:'READY',startup});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message,code:error.code},()=>process.exit(2));}
