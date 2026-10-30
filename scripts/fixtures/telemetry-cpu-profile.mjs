import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Session} from 'node:inspector';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {seedStore} from '../../server/store.ts';
import {loadRuntimeImports,waitForWrites} from '../../server/import-api.ts';
import {closePostgres,tenantPool} from '../../server/postgres-repository.ts';
import {TelemetryService} from '../../server/telemetry.ts';
import {observeRegistrySql} from '../../server/registry-history-sql.ts';
import {publicRegistry} from '../../server/registry-history.ts';
import {signEvent,authenticAck,sha,topicFor} from '../../integrations/telemetry.ts';
import {summarizeCpuProfile} from '../telemetry-cpu-profile-summary.mjs';
const setup=JSON.parse(await readFile(process.argv[2],'utf8')),config=JSON.parse(await readFile(setup.telemetryFile,'utf8')),source=config.sources[0],store=seedStore(),intake=new TelemetryService();
const counts=async()=>{const c=tenantPool('sandbox');return(await c.query("SELECT (SELECT count(*)::int FROM telemetry_points) AS points,(SELECT count(*)::int FROM telemetry_receipts) AS receipts,(SELECT count(*)::int FROM audit_ledger) AS audits")).rows[0];};
const acks=[];let sequence=setup.sequenceBase,activeStats;
const originalQuery=pg.Client.prototype.query;
pg.Client.prototype.query=function(...args){
 const sql=typeof args[0]==='string'?args[0]:args[0]?.text||'',stats=activeStats,started=performance.now();
 let group=sql.includes('IDMS_ENTITY_ROWS')?'full_entity_rows':sql.includes('IDMS_POST_IMAGE_ROWS')?'full_postimage_rows':/^SELECT revision FROM business_state/.test(sql)?'business_lock':/telemetry_(points|receipts)/.test(sql)?'telemetry_rows':/audit_ledger/.test(sql)?'audit_append':/^UPDATE business_state/.test(sql)?'root_update':'other';
 const result=originalQuery.apply(this,args);if(stats){let done=false;const finish=()=>{if(done)return;done=true;const r=stats[group]??={calls:0,wallMs:0};r.calls++;r.wallMs+=performance.now()-started;};if(result?.then)result.then(finish,finish);else result?.once?.('end',finish);}
 return result;
};
let session;try{
 await loadRuntimeImports(store);await observeRegistrySql(tenantPool('sandbox'),'sandbox',publicRegistry(config.sources,'sandbox'),'cpu-qa-'+randomUUID());
 intake.config=config;intake.scopeStore=store;intake.client={connected:true,publish:(topic,bytes)=>{assert.equal(topic,topicFor(source,'ack'));const ack=JSON.parse(bytes);assert.ok(authenticAck(ack,source.acknowledgementKey));assert.equal(ack.status,'STORED');acks.push(ack);}};
 const event=()=>signEvent({version:1,eventId:randomUUID(),tenantId:'sandbox',edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion,sequenceNo:++sequence,...source.points[0],eventTime:new Date(Date.now()-sequence).toISOString(),value:1,quality:'GOOD'},source.signingKey);
 const receive=async e=>{const prior=acks.length;await intake.receive(store,topicFor(source,'telemetry'),Buffer.from(JSON.stringify(e)));assert.equal(acks.length,prior+1);assert.equal(acks.at(-1).eventId,e.eventId);assert.equal(acks.at(-1).digest,sha(e));};
 await receive(event());const baseline=await counts(),results=[];let duplicate;
 session=new Session();session.connect();const post=promisify(session.post.bind(session));await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});
 for(const kind of ['NEW_EVENT','EXACT_REPLAY']){
  const before=await counts(),timings=[],cpu=process.cpuUsage(),memoryBefore=process.memoryUsage();activeStats={};await post('Profiler.start');
  for(let i=0;i<3;i++){const e=kind==='NEW_EVENT'?event():duplicate;if(kind==='NEW_EVENT')duplicate=e;const started=performance.now();await receive(e);timings.push(performance.now()-started);}
  const {profile}=await post('Profiler.stop'),usage=process.cpuUsage(cpu),stats=activeStats;activeStats=undefined;const after=await counts();for(const key of ['points','receipts','audits'])assert.equal(after[key]-before[key],kind==='NEW_EVENT'?3:0);
  const raw=JSON.stringify(profile),file=join(setup.privateRoot,setup.stage+'-'+kind+'.cpuprofile');await writeFile(file,raw,{flag:'wx',mode:0o600});
  results.push({kind,timingsMs:timings,cpuUserMs:usage.user/1000,cpuSystemMs:usage.system/1000,memoryBefore,memoryAfter:process.memoryUsage(),queryCategories:stats,queryTimesIncludeDriverAndJavaScriptRowProcessing:true,before,after,actualSignedBusinessAcks:3,cpuProfileSha256:createHash('sha256').update(raw).digest('hex'),profile:summarizeCpuProfile(profile)});
 }
 const final=await counts();assert.equal(final.audits-baseline.audits,3);const result={stage:setup.stage,requestedHistory:setup.requestedHistory,baseline,final,results,sequenceFinal:sequence,actualOriginalReceiverAndDefaultBudget:true,transportIsDirectQaReceiveNotMqttBenchmark:true};await writeFile(join(setup.privateRoot,setup.stage+'-result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({phase:'CPU_STAGE_DONE',stage:setup.stage,audits:baseline.audits,newMs:results[0].timingsMs,replayMs:results[1].timingsMs}));
}finally{activeStats=undefined;pg.Client.prototype.query=originalQuery;if(session){session.disconnect();}intake.client=undefined;await waitForWrites();await closePostgres();}
