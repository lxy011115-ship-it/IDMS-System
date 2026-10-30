import assert from 'node:assert/strict';
import {readFile,open,mkdir,link,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {samplePgCapacity,sampleQueueCapacity,sampleEdgeStatus} from './telemetry-capacity-sample.mjs';
import {safeCount,summarizeCapacity} from './telemetry-capacity-model.mjs';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,'')),hash=b=>createHash('sha256').update(b).digest('hex'),exec=promisify(execFile);
export function capacityArguments(args){
 const o={};const allowed=new Set(['business-config','edge-config','tenant','edge','out','seconds','interval','core-pid','core-created']);
 for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');assert.ok(args[i]?.startsWith('--')&&allowed.has(key)&&args[i+1]&&!Object.hasOwn(o,key),'Invalid capacity arguments');o[key]=args[i+1];}
 for(const k of ['business-config','edge-config','tenant','edge','out'])assert.ok(o[k],'Missing --'+k);
 o.seconds=Number(o.seconds??300);o.interval=Number(o.interval??15);assert.ok(Number.isInteger(o.seconds)&&o.seconds>=15&&o.seconds<=3600&&Number.isInteger(o.interval)&&o.interval>=5&&o.interval<=60&&o.interval<=o.seconds/2,'Invalid observation duration');
 assert.equal(!!o['core-pid'],!!o['core-created']);if(o['core-pid']){assert.ok(process.platform==='win32');o['core-pid']=safeCount(o['core-pid']);assert.ok(o['core-pid']>0&&Number.isFinite(Date.parse(o['core-created'])));}
 assert.ok(/^[A-Za-z0-9_-]{1,80}$/.test(o.tenant)&&/^[A-Za-z0-9_-]{1,80}$/.test(o.edge));return o;
}
export async function observeTelemetryCapacity(o){
 const businessPath=resolve(o['business-config']),edgePath=resolve(o['edge-config']),businessBytes=await readFile(businessPath),edgeBytes=await readFile(edgePath),business=JSON.parse(businessBytes.toString('utf8').replace(/^\uFEFF/,'')),edge=JSON.parse(edgeBytes.toString('utf8').replace(/^\uFEFF/,''));
 assert.ok(['127.0.0.1','localhost','::1'].includes(business.host),'Capacity diagnostics currently require a loopback database');
 const account=business.tenants?.[o.tenant],source=edge.sources?.find(s=>s.tenantId===o.tenant&&s.edgeId===o.edge);assert.ok(account?.database&&account?.user&&source&&edge.edge?.spool,'Unknown capacity tenant/edge');
 assert.equal(edge.sources.filter(s=>s.tenantId===o.tenant&&s.edgeId===o.edge).length,1);assert.equal(source.origin,'SIMULATOR','This diagnostic entry currently covers legacy simulator telemetry');
 const output=resolve(o.out);await mkdir(output,{recursive:false});
 const journal=await open(join(output,'observations.jsonl'),'wx',0o600);let client;const samples=[];
 const captureProcess=async()=>{if(!o['core-pid'])return null;return JSON.parse((await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(dirname(fileURLToPath(import.meta.url)),'telemetry-capacity-process.ps1'),'-TargetProcess',String(o['core-pid']),'-ExpectedCreatedAt',o['core-created']],{windowsHide:true,timeout:10000,maxBuffer:16384})).stdout);};
 try{
  client=new pg.Client({host:business.host,port:business.port,database:account.database,user:account.user,password:account.password,application_name:'idms-capacity-readonly',connectionTimeoutMillis:3000,statement_timeout:10000,query_timeout:12000});await client.connect();
  const started=performance.now();let baseline;
  const sample=async()=>{
   assert.equal(hash(await readFile(businessPath)),hash(businessBytes),'Business configuration changed');assert.equal(hash(await readFile(edgePath)),hash(edgeBytes),'Edge configuration changed');
   const before=await sampleEdgeStatus(source),sql=await samplePgCapacity(client,baseline);if(!baseline){assert.equal(sql.identity.database,account.database);assert.equal(sql.identity.role,account.user);baseline=sql;}
   const queue=await sampleQueueCapacity(resolve(edge.edge.spool),source),core=await captureProcess(),after=await sampleEdgeStatus(source);
   for(const k of ['sequence','acknowledged'])assert.ok(before[k]<=queue[k]&&queue[k]<=after[k],'Cross-store observation boundary changed');
   if(samples.length){const previous=samples.at(-1);for(const key of ['gaps','retries','published'])assert.ok(before[key]>=previous.edgeAfter[key],'Edge process counters restarted');}
   const value={at:new Date().toISOString(),elapsedMs:performance.now()-started,tenantId:o.tenant,edgeId:o.edge,edgeBefore:before,pg:sql,queue,core,edgeAfter:after};samples.push(value);if(samples.length>1)summarizeCapacity(samples);
   await journal.write(JSON.stringify(value)+'\n');await journal.sync();console.log(JSON.stringify({phase:'OBSERVING_CAPACITY',observerPid:process.pid,samples:samples.length,seconds:Math.round(value.elapsedMs/1000),pending:queue.pending,points:sql.tables.telemetry_points.rows,databaseBytes:sql.databaseBytes}));
  };
  await sample();while(performance.now()-started<o.seconds*1000){const remaining=o.seconds*1000-(performance.now()-started);await new Promise(ok=>setTimeout(ok,Math.min(o.interval*1000,Math.max(0,remaining))));await sample();}
  const report={...summarizeCapacity(samples),scope:'WHOLE_BUSINESS_DATABASE_WITH_SELECTED_LEGACY_EDGE_QUEUE',tenantId:o.tenant,edgeId:o.edge,observerPid:process.pid,sourceConfigurationSha256:hash(edgeBytes),businessConfigurationSha256:hash(businessBytes),actualReadOnlyPgAndSqlite:true,coreProcessIdentityBound:!!o['core-pid'],physicalVolumeIncludesOtherApplications:true};
  const stage=join(output,'report.stage.json'),target=join(output,'report.json'),f=await open(stage,'wx',0o600);try{await f.writeFile(JSON.stringify(report,null,2));await f.sync();}finally{await f.close();}await link(stage,target);await unlink(stage);console.log(JSON.stringify({phase:'CAPACITY_COMPLETE',output:target,samples:report.sampleCount,seconds:report.seconds,pendingNetReduction:report.pendingNetReduction,productionAcceptance:false}));return report;
 }finally{await journal.close();if(client)await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await observeTelemetryCapacity(capacityArguments(process.argv.slice(2)));}catch(e){console.error(JSON.stringify({phase:'CAPACITY_FAILED',errorCode:typeof e.code==='string'?e.code:'CAPACITY_VALIDATION_FAILED'}));process.exitCode=1;}}
