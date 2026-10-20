import {createServer} from 'node:http';
import pg from 'pg';
import {resident,limits} from '../../server/capacity.ts';
import * as api from '../../server/import-api.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^postimageqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned post-image QA IPC required');
let metrics,fault,hold=false,release;const reset=()=>metrics={full:0,postImage:0,postRows:0,maxDriverRows:0,peakTaskBytes:0,faults:0};reset();const originalQuery=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 const sql=typeof config==='string'?config:config?.text||'',post=sql.includes('IDMS_POST_IMAGE_ROWS');if(sql.includes('IDMS_ENTITY_ROWS'))metrics.full++;if(post)metrics.postImage++;
 if(config?.on){
  if(post){const target=fault;fault=undefined;let changed=false;const emit=config.emit;
   if(target==='QUERY'){config.text+=' WHERE missing_post_image_column IS NULL';metrics.faults++;}
   config.emit=function(event,...values){
    if(event!=='row')return emit.call(this,event,...values);metrics.postRows++;const [row,result]=values;
    const match=target==='business'?row.kind==='business:tenants':target==='duplicate'?row.kind==='business:tenants':target==='drop'?row.kind==='file':target==='audit'?row.kind==='audit'&&row.detail.event.objectType==='TELEMETRY_EVENT'&&row.detail.event.metadata.deviceCode==='P-050':row.kind===target;
    if(target&&target!=='QUERY'&&!changed&&match){changed=true;metrics.faults++;
     if(target==='drop'){if(result)result.rows.length=0;return false;}
     if(target==='duplicate'){emit.call(this,event,...values);return emit.call(this,event,...values);}
     if(target==='file')row.content=(row.content.startsWith('A')?'B':'A')+row.content.slice(1);
     else if(target==='audit')row.detail.event.action='QA_OLD_AUDIT_WIRE_TAMPER';
     else if(target==='input')row.detail.validOrdinal=0;
     else if(target==='record')row.detail.value.device_code='QA_WIRE_TAMPER';
     else if(target==='state')row.detail.payloadDigest='0'.repeat(64);
     else if(target==='batch')row.detail.filename='QA_WIRE_TAMPER';
     else row.detail.name='QA_WIRE_TAMPER';
    }
    return emit.call(this,event,...values);
   };
  }
  config.on('row',(_row,result)=>{metrics.peakTaskBytes=Math.max(metrics.peakTaskBytes,resident.snapshot().categories.task||0);if(result&&!result.qaMeasured){result.qaMeasured=true;const add=result.addRow;result.addRow=function(row){add.call(this,row);metrics.maxDriverRows=Math.max(metrics.maxDriverRows,this.rows.length);};}});
 }
 if(post&&hold){hold=false;const gate=new Promise(ok=>release=ok);process.send({type:'ENTERED'});void gate.then(()=>originalQuery.call(this,config,...args));return config;}
 return originalQuery.call(this,config,...args);
};
try{
 const runtime=await import('../../server/index.ts'),server=createServer(runtime.handler);await new Promise(ok=>server.listen(Number(process.env.PORT),'127.0.0.1',ok));
 process.on('message',m=>{if(m.type==='RELEASE'){release?.();release=undefined;return;}void(async()=>{
  if(m.type==='RESET'){reset();return;}
  if(m.type==='FAULT'){fault=m.target;return;}
  if(m.type==='HOLD'){hold=true;return;}
  if(m.type==='STATS')return {...metrics,policy:{taskBytes:limits.taskBytes,taskTotalBytes:limits.taskTotalBytes},memory:resident.snapshot(),cache:api.workspaceCacheSnapshot()};
  if(m.type==='CLOSE'){release?.();await new Promise(ok=>server.close(ok));await runtime.closeRuntime();process.send({type:'DONE',id:m.id},()=>process.disconnect());return 'CLOSED';}
  throw Error('Unknown owned QA operation');
 })().then(value=>{if(value!=='CLOSED')process.send({type:'DONE',id:m.id,value});},error=>process.send({type:'DONE',id:m.id,error:error.message}));});process.send({type:'READY',url:'http://127.0.0.1:'+server.address().port});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message},()=>process.exit(2));}
