import {createServer} from 'node:http';
import pg from 'pg';
import {MemoryLedger,resident,sqlScheduler,workScheduler} from '../../server/capacity.ts';
import {httpCapacitySnapshot} from '../../server/request-capacity.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^telequalityqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned telemetry quality IPC required');
let stats,fault,hold,release;const reset=()=>stats={full:0,lean:0,proofs:0,statsQueries:0,faults:0,peakTaskBytes:0};reset();
const sample=()=>stats.peakTaskBytes=Math.max(stats.peakTaskBytes,resident.snapshot().categories.task||0),factory=MemoryLedger.prototype.account;
MemoryLedger.prototype.account=function(...args){const a=factory.apply(this,args),grow=a.grow,hold=a.hold;a.grow=n=>{grow(n);sample();};a.hold=n=>{const r=hold(n);sample();return r;};return a;};
const original=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 const text=typeof config==='string'?config:config?.text||'',kind=text.includes('IDMS_OPERATIONAL_POLICY_ROWS')?'OPOL':text.includes('IDMS_OPERATIONAL_POLICY_HEAD')?'OPHEAD':text.includes('IDMS_OPERATIONAL_IMPORT_ROWS')?'OINPUT':text.includes('IDMS_OPERATIONAL_IMPORT_HEAD')?'OIHEAD':text.includes('IDMS_QUALITY_POLICY_ROWS')?'QPOL':text.includes('IDMS_QUALITY_POLICY_HEAD')?'QHEAD':text.includes('IDMS_REPLAY_TELEMETRY_ROWS')?'RROWS':text.includes('IDMS_REPLAY_TELEMETRY_HEAD')?'RHEAD':text.includes('IDMS_REPORT_APPEND')?'RAPPEND':text.includes('IDMS_REPORT_PAYLOAD')?'RPAYLOAD':text.includes('IDMS_CALENDAR_HISTORY_ROWS')?'HISTORY':text.includes('IDMS_CALENDAR_HISTORY_COUNT')?'HISTCOUNT':text.includes('IDMS_COVERAGE_TELEMETRY')?'COVSTATS':text.includes('IDMS_COVERAGE_CALENDAR')?'CALENDAR':text.includes('IDMS_TELEMETRY_QUALITY_INTAKE')?'INTAKE':text.includes('IDMS_TELEMETRY_QUALITY_STATS')?'STATS':text.includes('IDMS_TELEMETRY_QUALITY_DEFINITIONS')?'DEFINITIONS':text.includes('IDMS_TELEMETRY_QUALITY_ASSETS')?'ASSETS':text.includes('IDMS_COLD_IMPORT_STATE')?'ROOT':'';
 if(text.includes('IDMS_ENTITY_ROWS'))stats.full++;if(text.includes('IDMS_READ_WORKSPACE_ROWS'))stats.lean++;if(kind==='ROOT')stats.proofs++;if(kind==='STATS')stats.statsQueries++;
 const [target,operation]=fault?.split(':')||[],selected=kind&&kind===target?operation:undefined;if(selected)fault=undefined;
 if(config instanceof pg.Query&&selected){stats.faults++;if(selected==='SQL')config.text+=' QA_INVALID_SYNTAX (';else if(selected==='DROP')config.text='SELECT * FROM ('+config.text+') qa WHERE false';else if(selected==='DUPLICATE')config.text='SELECT * FROM ('+config.text+') qa CROSS JOIN generate_series(1,2)';else config.prependListener('row',row=>{if(selected==='DIGEST')row.snapshot_digest='0'.repeat(64);if(selected==='ANCHOR')row.anchor=null;if(selected==='FOREIGN')row.tenant_id='sandbox';if(selected==='APPROVAL')row.approval_count='2';if(selected==='BUDGET')row.extraAllocation='x'.repeat(600000);});return original.call(this,config,...args);}
 const run=()=>{if(selected==='SQL'){stats.faults++;return original.call(this,typeof config==='string'?config+' QA_INVALID_SYNTAX (':config,...args);}return original.call(this,config,...args);};
 let pending;if(hold&&hold===kind){hold=undefined;pending=new Promise(ok=>release=ok).then(run);process.send({type:'ENTERED',target:kind});}else pending=run();
 if(!pending?.then)return pending;return pending.then(result=>{sample();if(!selected||selected==='SQL')return result;stats.faults++;const rows=result.rows,row=rows[0];
  if(selected==='DROP')rows.shift();else if(selected==='DUPLICATE')rows.push(structuredClone(row));else if(selected==='COUNT')row.records=String(Number(row.records)+1);else if(selected==='FOREIGN'){if(kind==='STATS')row.latest.edgeId='hidden-edge';else if(kind==='COVSTATS')row.device_code='SECRET-FOREIGN';else row.tenant_id='sandbox';}
  else if(selected==='ANCHOR')row.items[0].anchor=null;else if(selected==='TOTAL')row.total='0';else if(selected==='RCOUNT')row.count=String(Number(row.count)+1);else if(selected==='BUDGET')row.extraAllocation='x'.repeat(600000);else if(selected==='EXCESS')row.examples.NON_GOOD_QUALITY=Array(6).fill(row.latest);else if(selected==='FUTURE')row.latest.eventTime='2099-01-01T00:00:00.000Z';else if(selected==='POLICY')row.quality_policy.gapMultiplier=0;else if(selected==='DIGEST')row.payload_digest='0'.repeat(64);result.rowCount=rows.length;return result;
 });
};
try{
 const runtime=await import('../../server/index.ts'),server=createServer(runtime.handler);await new Promise(ok=>server.listen(Number(process.env.PORT),'127.0.0.1',ok));
 process.on('message',m=>{if(m.type==='RELEASE'){release?.();release=undefined;return;}void(async()=>{
  if(m.type==='RESET'){reset();return;}if(m.type==='FAULT'){fault=m.target;return;}if(m.type==='HOLD'){hold=m.target;return;}
  if(m.type==='STATS')return {...stats,memory:resident.snapshot(),sql:sqlScheduler.snapshot(),work:workScheduler.snapshot(),http:httpCapacitySnapshot()};
  if(m.type==='CLOSE'){release?.();await new Promise(ok=>server.close(ok));await runtime.closeRuntime();process.send({type:'DONE',id:m.id},()=>process.disconnect());return 'CLOSED';}
  throw Error('Unknown telemetry quality IPC');
 })().then(value=>{if(value!=='CLOSED')process.send({type:'DONE',id:m.id,value});},error=>process.send({type:'DONE',id:m.id,error:{message:error.message,code:error.code}}));});process.send({type:'READY'});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message},()=>process.exit(2));}


