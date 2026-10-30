import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,unlink,stat} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import pg from 'pg';
import {seedStore} from '../server/store.ts';
import {appendAudit,verifyAuditChain} from '../server/audit.ts';
import {emptyImports,canonical} from '../server/imports.ts';
import {readEntities} from '../server/entity-repository.ts';
import {roleLayout,migrateTenant,businessRuntime} from './database-migrations.mjs';
import {updateQaPayload} from './qa-database.mjs';
import {writePrivate} from './keycloak-local.mjs';
const work=resolve('work/telemetry-cpu-profile-20261019'),resultFile=join(work,'verification.json');await assert.rejects(stat(resultFile),e=>e.code==='ENOENT');
const main=JSON.parse((await readFile('.local/postgres-runtime.json','utf8')).replace(/^\uFEFF/,'')),nonce=randomUUID().replaceAll('-','').slice(0,12),localRoot=resolve('.local'),directory=join(localRoot,'telemetry-cpu-qa-'+nonce);assert.ok(directory.startsWith(localRoot+sep));await mkdir(directory,{recursive:false});
const admin=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres',statement_timeout:10000}),config={host:main.host,port:main.port,tenants:{},businessRoles:{}},dbPins=new Map(),rolePins=new Map(),privateFiles=[];
let child,closed,connection;const stages=[],synthStore=seedStore(),hash=b=>createHash('sha256').update(b).digest('hex');
function fillAudits(payload,target){const audits=payload.audits;while(audits.length<target){const prior=audits.at(-1),e=appendAudit({audits:prior?[prior]:[]},{tenantId:'sandbox',objectType:'TELEMETRY_EVENT',objectId:randomUUID(),action:'TELEMETRY_STORED',actorType:'INTERFACE',actorId:'cpu-synthetic-history',correlationId:randomUUID(),metadata:{inputDigest:hash(String(audits.length)),origin:'SIMULATOR',deviceCode:'SIM-CNC-01',mapVersion:'cnc-simulator-1',pointId:randomUUID(),synthetic:true}});audits.push(e);}assert.ok(verifyAuditChain(audits,'sandbox'));}
async function privateJson(name,value){const file=join(directory,name);await writePrivate(file,JSON.stringify(value));privateFiles.push(file);return file;}
async function captureRoles(){for(const [tenant,a]of Object.entries(config.tenants)){const r=config.businessRoles[tenant];for(const name of [a.user,r.owner,r.migrator.user,r.backup.user]){const row=(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0];if(row){if(rolePins.has(name))assert.equal(row.oid,rolePins.get(name));else rolePins.set(name,row.oid);}}}}
try{
 await admin.connect();for(const tenant of ['acme','sandbox']){
  const name='idms_cpuqa_'+tenant+'_'+nonce,password=randomBytes(32).toString('base64url'),a=config.tenants[tenant]={database:name,user:name,password};config.businessRoles[tenant]={...roleLayout(a),telemetry:tenant==='sandbox'};
  const names=[name,config.businessRoles[tenant].owner,config.businessRoles[tenant].migrator.user,config.businessRoles[tenant].backup.user];assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1::text[])',[names])).rows[0].n,0);assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',[name])).rows[0].n,0);
  await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);rolePins.set(name,(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid);
  await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);dbPins.set(name,(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[name])).rows[0].oid);await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
 }
 const originalSandbox=synthStore.audits.filter(a=>a.tenantId==='sandbox');fillAudits({audits:originalSandbox},1000);synthStore.audits=[...synthStore.audits.filter(a=>a.tenantId!=='sandbox'),...originalSandbox];const {audits,idempotency,...business}=synthStore,seed={version:2,business,audits,idempotency:[...idempotency],imports:emptyImports()};
 for(const tenant of ['acme','sandbox']){console.log(JSON.stringify({phase:'MIGRATING_CPU_QA',tenant}));try{await migrateTenant({...config,bootstrapPassword:main.bootstrapPassword},tenant,seed);}finally{await captureRoles();}}
 const runtime=businessRuntime(config),businessFile=await privateJson('business.json',runtime),source={tenantId:'sandbox',edgeId:'cpu-'+nonce,deviceCode:'SIM-CNC-01',origin:'SIMULATOR',mapVersion:'cnc-simulator-1',signingKey:randomBytes(32).toString('base64url'),acknowledgementKey:randomBytes(32).toString('base64url'),statusKey:randomBytes(32).toString('base64url'),statusUrl:'http://127.0.0.1:9/status',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',unit:'mm/s'}]},telemetryFile=await privateJson('telemetry.json',{version:1,sources:[source]});
 connection=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:config.tenants.sandbox.database,statement_timeout:20000});await connection.connect();let sequence=100000;
 for(const target of [1000,10000,45000]){
  console.log(JSON.stringify({phase:'SEEDING_CPU_HISTORY',audits:target}));const before=(await readEntities(connection,'sandbox')).payload;if(before.audits.length<target){const payload=structuredClone(before);fillAudits(payload,target);await updateQaPayload(connection,'sandbox',payload);}
  const stage='history-'+target,setupFile=await privateJson(stage+'-setup.json',{telemetryFile,privateRoot:directory,stage,requestedHistory:target,sequenceBase:sequence});
  child=fork('scripts/fixtures/telemetry-cpu-profile.mjs',[setupFile],{env:{...process.env,NODE_ENV:'test',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:businessFile,IDMS_CAPACITY_CONFIG:'',IDMS_DEMO_NAMESPACE:'cpu-profile-'+nonce},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok({code,signal}));});console.log(JSON.stringify({phase:'PROFILING_CPU_HISTORY',audits:target,childPid:child.pid}));const terminal=await closed;assert.equal(terminal.code,0,'CPU profile child failed');child=undefined;closed=undefined;
  const result=JSON.parse(await readFile(join(directory,stage+'-result.json'),'utf8'));assert.equal(result.requestedHistory,target);assert.equal(result.baseline.audits,target+1);sequence=result.sequenceFinal;
  const verified=await readEntities(connection,'sandbox');assert.equal(verified.payload.audits.length,target+4);assert.ok(verifyAuditChain(verified.payload.audits,'sandbox'));assert.equal(canonical(verified.payload.audits.slice(0,before.audits.length)),canonical(before.audits));
  result.fullPersistedRootAndAuditChainVerifiedAfterChildExit=true;result.allPriorActualEventsAndAuditHistoryPreserved=true;stages.push(result);
 }
}finally{
 if(child){if(child.exitCode===null&&child.signalCode===null)child.kill();if(closed)await closed;}
 if(connection)await connection.end();
 for(const [name,oid]of dbPins){const current=(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[name])).rows[0];assert.equal(current?.oid,oid,'QA database OID replaced');
  let n;for(let i=0;i<50;i++){n=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[oid])).rows[0].n;if(!n)break;await new Promise(ok=>setTimeout(ok,100));}assert.equal(n,0,'QA SQL backends still active');await admin.query(`DROP DATABASE "${name}"`);
 }
 await captureRoles();for(const [name,oid]of rolePins){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0]?.oid,oid);}
 for(const tenant of ['acme','sandbox']){const a=config.tenants[tenant],r=config.businessRoles[tenant];if(!a)continue;for(const name of [r.migrator.user,r.backup.user,a.user,r.owner])if(rolePins.has(name))await admin.query(`DROP ROLE "${name}"`);}
 await admin.end();for(const file of privateFiles)await unlink(file);
}
assert.equal(stages.length,3);const proof={format:'idms-telemetry-cpu-profile-verification-v1',verifiedAt:new Date().toISOString(),stages,actualOriginalReceiverSha256:hash(await readFile('server/telemetry.ts')),actualOriginalCanonicalModuleSha256:hash(await readFile('server/canonical-state.ts')),defaultCapacityUnchanged:true,allActualChildrenTerminalAndOwnedQaDatabasesRolesAndCredentialsRemoved:true,privateRawCpuProfilesRetained:true,originalRuntimeNotAttachedOrRestarted:true,originalDatabasesNotUsedForFaultInjection:true,transportBenchmark:false,cpuOptimizationImplemented:false,productionCapacityOrSlaAcceptance:false,productionAcceptance:false};await writeFile(resultFile,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({phase:'CPU_PROFILE_VERIFIED',stages:stages.map(s=>({history:s.requestedHistory,newMs:s.results[0].timingsMs,replayMs:s.results[1].timingsMs}))}));
