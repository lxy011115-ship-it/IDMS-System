import {createServer} from 'node:http';
import pg from 'pg';
import {MemoryLedger,resident,sqlScheduler,workScheduler} from '../../server/capacity.ts';
import {httpCapacitySnapshot,stopHttpAdmission} from '../../server/request-capacity.ts';
import {csvExportQueueSnapshot,closeCsvExports} from '../../server/data-export-stream.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^csvstreamqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned CSV QA IPC required');
let metrics,hold,release,fault;const reset=()=>metrics={full:0,preflightFetches:0,deliveryFetches:0,preflightRows:0,deliveryRows:0,maxBatchRows:0,openCursors:0,commits:0,rollbacks:0,peakTask:0,peakResponse:0,faults:0,sqlTimeouts:0,writes:0};reset();
const sample=()=>{const m=resident.snapshot().categories;metrics.peakTask=Math.max(metrics.peakTask,m.task||0);metrics.peakResponse=Math.max(metrics.peakResponse,m.response||0);};const accountFactory=MemoryLedger.prototype.account;MemoryLedger.prototype.account=function(...args){const account=accountFactory.apply(this,args),grow=account.grow,retain=account.hold;account.grow=bytes=>{grow(bytes);sample();};account.hold=bytes=>{const release=retain(bytes);sample();return release;};return account;};
const originalQuery=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 const text=typeof config==='string'?config:config?.text||'';if(text.includes('IDMS_ENTITY_ROWS'))metrics.full++;
 if(config?.on)config.on('row',sample);
 if(hold==='DECLARE'&&text.includes('IDMS_CSV_DELIVERY_DECLARE')){hold=undefined;const gate=new Promise(ok=>release=ok);process.send({type:'ENTERED',target:'DECLARE'});return gate.then(()=>originalQuery.call(this,config,...args));}
 if(fault==='SQL_WAIT'&&text.includes('IDMS_CSV_PREFLIGHT_FETCH')){fault=undefined;return originalQuery.call(this,'SELECT pg_sleep(5)').catch(error=>{if(error.code==='57014')metrics.sqlTimeouts++;throw error;});}
 const result=originalQuery.call(this,config,...args);if(typeof config!=='string'||!result||typeof result.then!=='function')return result;
 return result.then(r=>{
  if(text.includes('_DECLARE')){metrics.openCursors++;this.csvQaTransaction=true;}
  if(text.includes('_CLOSE'))metrics.openCursors--;
  if(text==='COMMIT'&&this.csvQaTransaction){metrics.commits++;metrics.openCursors=0;this.csvQaTransaction=false;}if(text==='ROLLBACK'&&this.csvQaTransaction){metrics.rollbacks++;metrics.openCursors=0;this.csvQaTransaction=false;}
  const phase=text.includes('IDMS_CSV_PREFLIGHT_FETCH')?'preflight':text.includes('IDMS_CSV_DELIVERY_FETCH')?'delivery':undefined;
  if(phase){metrics[phase+'Fetches']++;const previous=metrics[phase+'Rows'];metrics[phase+'Rows']+=r.rows.length;metrics.maxBatchRows=Math.max(metrics.maxBatchRows,r.rows.length);
   if(fault==='FOREIGN'&&phase==='preflight'&&r.rows.length){r.rows[0].tenant_id='sandbox';fault=undefined;metrics.faults++;}
   if(fault==='VALUE'&&phase==='delivery'&&previous>=1536&&r.rows.length){r.rows[0].body.value=-999;fault=undefined;metrics.faults++;}
  }return r;
 });
};
try{
 const runtime=await import('../../server/index.ts'),server=createServer((req,res)=>{const writeHead=res.writeHead;res.writeHead=function(status,...args){const headers=args.find(v=>v&&typeof v==='object');this.csvQaResponse=String(headers?.['content-type']||this.getHeader('content-type')||'').startsWith('text/csv');return writeHead.call(this,status,...args);};const write=res.write;res.write=function(bytes,...args){if(res.csvQaResponse){metrics.writes++;if(hold==='WRITE'){hold=undefined;const index=typeof args[0]==='function'?0:1,callback=args[index];args[index]=error=>{process.send({type:'ENTERED',target:'WRITE'});release=()=>callback?.(error);};}}return write.call(this,bytes,...args);};void runtime.handler(req,res);});await new Promise(ok=>server.listen(Number(process.env.PORT),'127.0.0.1',ok));
 process.on('message',m=>{if(m.type==='RELEASE'){release?.();release=undefined;return;}void(async()=>{
  if(m.type==='RESET'){reset();return;}
  if(m.type==='HOLD'){hold=m.target;return;}
  if(m.type==='FAULT'){fault=m.target;return;}
  if(m.type==='STATS')return {...metrics,exports:csvExportQueueSnapshot(),sql:sqlScheduler.snapshot(),work:workScheduler.snapshot(),http:httpCapacitySnapshot(),memory:resident.snapshot()};
  if(m.type==='DRAIN'){stopHttpAdmission();await closeCsvExports();return true;}
  if(m.type==='CLOSE'){release?.();await new Promise(ok=>server.close(ok));await runtime.closeRuntime();process.send({type:'DONE',id:m.id},()=>process.disconnect());return 'CLOSED';}
  throw Error('Unknown owned CSV QA operation');
 })().then(value=>{if(value!=='CLOSED')process.send({type:'DONE',id:m.id,value});},error=>process.send({type:'DONE',id:m.id,error:error.message}));});process.send({type:'READY',url:'http://127.0.0.1:'+server.address().port});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message},()=>process.exit(2));}
