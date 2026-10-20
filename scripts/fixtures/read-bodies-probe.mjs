import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import pg from 'pg';
import * as api from '../../server/import-api.ts';
import {estimatedBytes,resident} from '../../server/capacity.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^bodiesqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned read-body QA IPC required');
let metrics,hold,release,escaped;const reset=()=>metrics={full:0,lean:0,audit:0,fileMeta:0,fileBytes:0,fileBodyBytes:0,fileBatchIds:[],maxDriverRows:0};reset();const originalQuery=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 const sql=typeof config==='string'?config:config?.text||'';for(const [key,marker]of Object.entries({full:'IDMS_ENTITY_ROWS',lean:'IDMS_READ_WORKSPACE_ROWS',audit:'IDMS_ON_DEMAND_AUDIT',fileMeta:'IDMS_ORIGINAL_META',fileBytes:'IDMS_ORIGINAL_BYTES'}))if(sql.includes(marker))metrics[key]++;
 if(config?.on)config.on('row',(_row,result)=>{if(result&&!result.qaMeasured){result.qaMeasured=true;const add=result.addRow;result.addRow=function(row){add.call(this,row);metrics.maxDriverRows=Math.max(metrics.maxDriverRows,this.rows.length);};}});
 if(hold==='audit'&&sql.includes('IDMS_ON_DEMAND_AUDIT')){hold=undefined;const gate=new Promise(ok=>release=ok);process.send({type:'ENTERED',target:'audit'});void gate.then(()=>originalQuery.call(this,config,...args));return config;}
 let result=originalQuery.call(this,config,...args);
 if(sql.includes('IDMS_ORIGINAL_BYTES')){metrics.fileBatchIds.push(args[0][1]);void result.then(r=>{metrics.fileBodyBytes+=r.rows[0]?.content?.length||0;},()=>{});}
 if(hold==='file'&&sql.includes('IDMS_ORIGINAL_META')){hold=undefined;result=result.then(async value=>{const gate=new Promise(ok=>release=ok);process.send({type:'ENTERED',target:'file'});await gate;return value;});}
 return result;
};
try{
 const runtime=await import('../../server/index.ts'),server=createServer(runtime.handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 const shape=workspace=>({bytes:estimatedBytes({store:workspace.store,imports:workspace.imports}),files:workspace.imports.batches.filter(b=>'originalBase64'in b).length,audits:'audits'in workspace.store,commands:'idempotency'in workspace.store,requests:'requests'in workspace.imports,batches:workspace.imports.batches.length,facts:workspace.imports.records.length,frozen:Object.isFrozen(workspace.store)&&Object.isFrozen(workspace.imports.batches)});
 process.on('message',m=>{
  if(m.type==='RELEASE'){release?.();release=undefined;return;}
  if(m.type==='RESET'){reset();process.send({type:'DONE',id:m.id});return;}
  if(m.type==='HOLD'){hold=m.target;process.send({type:'DONE',id:m.id});return;}
  if(m.type==='STATS'){process.send({type:'DONE',id:m.id,value:{...metrics,cache:api.workspaceCacheSnapshot(),memory:resident.snapshot()}});return;}
  if(m.type==='CLEAR'){api.clearWorkspaceCache();process.send({type:'DONE',id:m.id});return;}
  if(m.type==='INSPECT')void api.consistentRead(runtime.store,'acme',async workspace=>{escaped=workspace;return shape(workspace);}).then(value=>process.send({type:'DONE',id:m.id,value}));
  if(m.type==='AFTER_SCOPE')void (async()=>{assert.ok(escaped);const previous={...metrics};await assert.rejects(escaped.readOriginal(escaped.imports.batches[0]),/已结束/);await assert.rejects(escaped.readAudits(),/已结束/);escaped=undefined;assert.deepEqual(metrics,previous);process.send({type:'DONE',id:m.id,value:true});})();
  if(m.type==='CLOSE')void (async()=>{release?.();await new Promise(ok=>server.close(ok));await runtime.closeRuntime();process.send({type:'DONE',id:m.id},()=>process.disconnect());})();
 });process.send({type:'READY',url:'http://127.0.0.1:'+server.address().port});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message},()=>process.exit(2));}
