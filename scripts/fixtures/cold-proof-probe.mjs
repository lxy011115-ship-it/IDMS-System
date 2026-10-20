import {createServer} from 'node:http';
import pg from 'pg';
import {MemoryLedger,resident,limits,memoryTask,sqlScheduler,workScheduler} from '../../server/capacity.ts';
import {httpCapacitySnapshot} from '../../server/request-capacity.ts';
import {readEntities} from '../../server/entity-repository.ts';
import {verifyDataProjection} from '../../server/data-projection.ts';
import {readColdSnapshot} from '../../server/cold-proof.ts';
import * as api from '../../server/import-api.ts';
import {tenantPool} from '../../server/postgres-repository.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^coldproofqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned cold-proof QA IPC required');
let metrics,fault=process.env.IDMS_QA_COLD_FAULT,hold=false,release;const reset=()=>metrics={full:0,lean:0,cold:0,projection:0,revisions:0,coldRows:0,audits:0,receipts:0,requests:0,fileMeta:0,chunks:0,maxChunkBytes:0,maxDriverRows:0,peakTaskBytes:0,faults:0};reset();
const sample=()=>metrics.peakTaskBytes=Math.max(metrics.peakTaskBytes,resident.snapshot().categories.task||0),factory=MemoryLedger.prototype.account;MemoryLedger.prototype.account=function(...args){const account=factory.apply(this,args),grow=account.grow,hold=account.hold;account.grow=bytes=>{grow(bytes);sample();};account.hold=bytes=>{const release=hold(bytes);sample();return release;};return account;};
const originalQuery=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 const sql=typeof config==='string'?config:config?.text||'',cold=sql.includes('IDMS_COLD_CANONICAL_ROWS'),lean=sql.includes('IDMS_READ_WORKSPACE_ROWS'),projection=sql.includes('IDMS_PROJECTION_ROWS'),revisions=sql.includes('IDMS_REVISION_PROJECTION_ROWS');for(const [key,match]of Object.entries({full:sql.includes('IDMS_ENTITY_ROWS'),lean,cold,projection,revisions}))if(match)metrics[key]++;
 if(config?.on){
  const target=fault,eligible=cold&&!['PROJECTION','REVISION'].includes(target)&&!target?.startsWith('LEAN_')||lean&&target?.startsWith('LEAN_')||projection&&target==='PROJECTION'||revisions&&target==='REVISION';if(eligible&&target)fault=undefined;let changed=false;const emit=config.emit;
  if(eligible&&target==='QUERY'){config.text+=' missing_cold_proof_syntax';metrics.faults++;}
  config.emit=function(event,...args){if(event!=='row')return emit.call(this,event,...args);const [row,result]=args;
   if(cold){metrics.coldRows++;if(row.kind==='audit')metrics.audits++;if(row.kind==='receipt')metrics.receipts++;if(row.kind==='request')metrics.requests++;if(row.kind==='file-meta')metrics.fileMeta++;if(row.kind==='file-chunk'){metrics.chunks++;metrics.maxChunkBytes=Math.max(metrics.maxChunkBytes,row.content?.length||0);}}
   const match=cold&&(target==='AUDIT_OLD'?row.kind==='audit'&&row.detail?.event?.metadata?.deviceCode==='P-050':target==='RECEIPT'?row.kind==='receipt':target==='REQUEST'?row.kind==='request':target==='STATE'?row.kind==='state':target==='FRAME'?row.kind==='frame'&&row.phase===2:target==='FILE_META'?row.kind==='file-meta':target==='FOREIGN'?row.kind==='audit':['FILE_BYTES','DROP_CHUNK','DUPLICATE_CHUNK'].includes(target)&&row.kind==='file-chunk')||lean&&(target==='LEAN_INPUT'?row.kind==='input':target==='LEAN_BATCH'&&row.kind==='batch')||projection&&target==='PROJECTION'||revisions&&target==='REVISION';
   if(eligible&&target!=='QUERY'&&!changed&&match){changed=true;metrics.faults++;
    if(target==='DROP_CHUNK'){if(result)result.rows.length=0;return false;}
    if(target==='DUPLICATE_CHUNK'){emit.call(this,event,...args);return emit.call(this,event,...args);}
    if(target==='FILE_BYTES')row.content[0]^=1;
    else if(target==='FILE_META')row.detail.bytes++;
    else if(target==='AUDIT_OLD')row.detail.event.action='COLD_OLD_HIDDEN_TAMPER';
    else if(target==='RECEIPT')row.detail={tamper:true};
    else if(target==='REQUEST')row.detail.digest='tamper';
    else if(target==='STATE')row.detail.payloadDigest='0'.repeat(64);
    else if(target==='FRAME')row.phase=3;
    else if(target==='FOREIGN')row.tenant_id='sandbox';
    else if(target==='LEAN_INPUT')row.detail.validOrdinal=0;
    else if(target==='LEAN_BATCH')row.detail.filename='tamper';
    else if(target==='PROJECTION')row.body={...row.body,device_name:'tamper'};
    else if(target==='REVISION')row.previous_digest='tamper';
   }
   return emit.call(this,event,...args);
  };
  config.on('row',(_row,result)=>{sample();if(result&&!result.qaMeasured){result.qaMeasured=true;const add=result.addRow;result.addRow=function(row){add.call(this,row);metrics.maxDriverRows=Math.max(metrics.maxDriverRows,this.rows.length);};}});
 }
 if(cold&&hold==='cold'||projection&&hold==='projection'){hold=false;const gate=new Promise(ok=>release=ok);process.send({type:'ENTERED',target:cold?'cold':'projection'});void gate.then(()=>originalQuery.call(this,config,...args));return config;}
 return originalQuery.call(this,config,...args);
};
try{
 const runtime=await import('../../server/index.ts'),startup=structuredClone(metrics),server=createServer(runtime.handler);await new Promise(ok=>server.listen(Number(process.env.PORT),'127.0.0.1',ok));
 process.on('message',m=>{if(m.type==='RELEASE'){release?.();release=undefined;return;}void(async()=>{
  if(m.type==='RESET'){reset();return;}
  if(m.type==='FAULT'){fault=m.target;return;}
  if(m.type==='HOLD'){hold=m.target||'cold';return;}
  if(m.type==='CLEAR'){api.clearWorkspaceCache();return;}
  if(m.type==='STATS')return {...metrics,memory:resident.snapshot(),policy:{taskBytes:limits.taskBytes,taskTotalBytes:limits.taskTotalBytes},sql:sqlScheduler.snapshot(),work:workScheduler.snapshot(),http:httpCapacitySnapshot(),cache:api.workspaceCacheSnapshot()};
  if(m.type==='MEASURE')return memoryTask(async()=>{const client=await tenantPool('acme').connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');let shape;if(m.mode==='FULL'){const loaded=await readEntities(client,'acme');await verifyDataProjection(client,loaded.payload.imports,'acme');shape={facts:loaded.payload.imports.records.length,batches:loaded.payload.imports.batches.length,fullBodies:true};}else if(m.mode==='SEGMENTED'){const loaded=await readColdSnapshot(client,'acme');shape={facts:loaded.data.imports.records.length,batches:loaded.data.imports.batches.length,fullBodies:false};}else throw Error('Unknown QA measurement');await client.query('COMMIT');return shape;}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}},true);
  if(m.type==='CLOSE'){release?.();await new Promise(ok=>server.close(ok));await runtime.closeRuntime();process.send({type:'DONE',id:m.id},()=>process.disconnect());return 'CLOSED';}
  throw Error('Unknown owned cold-proof operation');
 })().then(value=>{if(value!=='CLOSED')process.send({type:'DONE',id:m.id,value});},error=>process.send({type:'DONE',id:m.id,error:{message:error.message,code:error.code}}));});process.send({type:'READY',startup,url:'http://127.0.0.1:'+server.address().port});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message,code:error.code,metrics},()=>process.exit(2));}
