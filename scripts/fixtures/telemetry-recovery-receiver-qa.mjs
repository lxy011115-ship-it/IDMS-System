// Real legacy receiver + app-role PostgreSQL + real MQTT. Faults exist only in
// this owned QA process, never in product startup or the public API.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import pg from 'pg';
import {seedStore} from '../../server/store.ts';
import {loadRuntimeImports,waitForWrites} from '../../server/import-api.ts';
import {closePostgres,tenantPool} from '../../server/postgres-repository.ts';
import {TelemetryService} from '../../server/telemetry.ts';
import {topicFor} from '../../integrations/telemetry.ts';
import {resident} from '../../server/capacity.ts';
const setup=JSON.parse(await readFile(process.argv[2],'utf8')),service=new TelemetryService(),store=seedStore();let fault,held,closing=false,ackPackets=0,originalQuery=pg.Client.prototype.query;
const writes=new WeakSet(),send=m=>process.connected&&process.send(m),counts=async()=>{
 const c=tenantPool('sandbox');return(await c.query("SELECT (SELECT count(*)::int FROM telemetry_points) AS points,(SELECT count(*)::int FROM telemetry_receipts) AS receipts,(SELECT count(*)::int FROM telemetry_receipts WHERE status='REJECTED') AS rejected,(SELECT count(*)::int FROM audit_ledger) AS audits")).rows[0];
};
pg.Client.prototype.query=function(...args){
 const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'';
 if(/^INSERT INTO telemetry_receipts/.test(sql))writes.add(this);
 if(sql==='ROLLBACK')writes.delete(this);
 if(/^UPDATE business_state SET revision=revision\+1/.test(sql)&&fault?.kind==='BEFORE_COMMIT'){
  fault=null;return originalQuery.apply(this,args).then(()=>{throw Error('QA_AFTER_ROOT_UPDATE_BEFORE_COMMIT');});
 }
 if(sql==='COMMIT'&&writes.has(this)){
  writes.delete(this);const selected=fault;fault=null;
  if(selected)return (async()=>{
   if(selected.kind==='HOLD')await new Promise(ok=>{held={release:ok,id:selected.id};send({type:'HELD',id:selected.id});});
   const result=await originalQuery.apply(this,args);
   if(selected.kind==='RESULT_LOST')throw Error('QA_RESULT_LOST_AFTER_ACTUAL_COMMIT');
   return result;
  })();
 }
 return originalQuery.apply(this,args);
};
async function close(){if(closing)return;closing=true;service.closing=true;if(held){held.release();held=null;}await waitForWrites();await service.close();await closePostgres();pg.Client.prototype.query=originalQuery;}
async function command(m){
 switch(m.type){
  case 'STATS':return {counts:await counts(),diagnostics:service.intake.snapshot(),ackPackets,held:!!held,faultArmed:!!fault,accountedBytes:resident.snapshot().total};
  case 'ARM':assert(!fault&&!held);assert(['HOLD','BEFORE_COMMIT','RESULT_LOST'].includes(m.kind));fault={kind:m.kind,id:m.id};return {armed:true};
  case 'RELEASE':assert(held);held.release();held=null;return {released:true};
  case 'CLOSE':await close();return {closed:true};
  default:throw Error('QA_COMMAND_INVALID');
 }
}
try{
 await loadRuntimeImports(store);await service.start(store);
 service.client.on('packetsend',p=>{if(p.cmd==='publish'&&p.topic===topicFor(service.config.sources[0],'ack'))ackPackets++;});
 for(let i=0;!service.subscribed&&i<200;i++)await new Promise(ok=>setTimeout(ok,25));assert(service.subscribed,'QA_SUBSCRIPTION_UNCONFIRMED');
 process.on('message',m=>{void command(m).then(value=>{send({type:'DONE',id:m.id,value});if(m.type==='CLOSE')process.disconnect();},async error=>{await writeFile(join(setup.directory,'receiver-'+process.pid+'-failure.private.json'),JSON.stringify({message:error.message,stack:error.stack}),{mode:0o600});send({type:'DONE',id:m.id,error:'QA_COMMAND_FAILED'});});});
 send({type:'READY',pid:process.pid,counts:await counts()});
}catch(error){await writeFile(join(setup.directory,'receiver-'+process.pid+'-boot.private.json'),JSON.stringify({message:error.message,stack:error.stack}),{mode:0o600});send({type:'BOOT_ERROR',code:'RECOVERY_RECEIVER_BOOT_FAILED'});await close();if(process.connected)process.disconnect();process.exitCode=1;}
