import {createServer} from 'node:http';
import pg from 'pg';
import {resident} from '../../server/capacity.ts';
import * as api from '../../server/import-api.ts';
import {createRuntimeAuthStore} from '../../server/auth-store.ts';
import {authConfigFromEnv} from '../../server/auth.ts';
import {auditPageLifetime} from '../../server/audit-page.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^auditpageqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned audit-page QA IPC required');
let metrics,fault=false;const reset=()=>metrics={full:0,lean:0,legacy:0,pageHeads:0,pageStreams:0,rows:0,maxDriverRows:0,peakTaskBytes:0,faults:0};reset();const originalQuery=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 const sql=typeof config==='string'?config:config?.text||'';for(const [key,marker]of Object.entries({full:'IDMS_ENTITY_ROWS',lean:'IDMS_READ_WORKSPACE_ROWS',legacy:'IDMS_ON_DEMAND_AUDIT',pageHeads:'IDMS_AUDIT_PAGE_HEAD',pageStreams:'IDMS_AUDIT_PAGE_ROWS'}))if(sql.includes(marker))metrics[key]++;
 if(config?.on){if(fault&&sql.includes('IDMS_AUDIT_PAGE_ROWS')){fault=false;let changed=false;config.prependListener('row',row=>{if(!changed&&row.event.objectType==='TELEMETRY_EVENT'&&row.event.metadata.deviceCode==='P-050'){changed=true;row.event.action='QA_WIRE_TAMPER_HIDDEN_OLD_ROW';metrics.faults++;}});}
  config.on('row',(_row,result)=>{metrics.rows++;metrics.peakTaskBytes=Math.max(metrics.peakTaskBytes,resident.snapshot().categories.task||0);if(result&&!result.qaMeasured){result.qaMeasured=true;const add=result.addRow;result.addRow=function(row){add.call(this,row);metrics.maxDriverRows=Math.max(metrics.maxDriverRows,this.rows.length);};}});
 }
 return originalQuery.call(this,config,...args);
};
try{
 const runtime=await import('../../server/index.ts'),authState=await createRuntimeAuthStore(authConfigFromEnv(),'postgres-tenant-databases'),codec=authState.auditCursors;await authState.close();const server=createServer(runtime.handler);await new Promise(ok=>server.listen(Number(process.env.PORT),'127.0.0.1',ok));
 process.on('message',m=>{void(async()=>{
  if(m.type==='RESET'){reset();return;}
  if(m.type==='FAULT'){fault=true;return;}
  if(m.type==='STATS')return {...metrics,cache:api.workspaceCacheSnapshot(),memory:resident.snapshot()};
  if(m.type==='EXPIRED'){const body=codec.open(m.token);body.window.capturedAt=Date.now()-auditPageLifetime-1000;body.window.expiresAt=body.window.capturedAt+auditPageLifetime;return codec.seal(body);}
  if(m.type==='CLOSE'){await new Promise(ok=>server.close(ok));await runtime.closeRuntime();process.send({type:'DONE',id:m.id},()=>process.disconnect());return 'CLOSED';}
  throw Error('Unknown owned QA operation');
 })().then(value=>{if(value!=='CLOSED')process.send({type:'DONE',id:m.id,value});},error=>process.send({type:'DONE',id:m.id,error:error.message}));});process.send({type:'READY',url:'http://127.0.0.1:'+server.address().port});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message},()=>process.exit(2));}
