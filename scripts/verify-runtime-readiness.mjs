// One small owned PostgreSQL cluster; never starts/stops an enterprise dependency.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {runtimeReadOnly} from '../server/runtime-db-probe.ts';
import {readOnlyDatabase} from './runtime-inspection-probes.mjs';
import {cancelSpareQuery} from '../server/spares-cancel.ts';
import {runtimeDependencyTasks} from '../server/runtime-adapters.ts';
import {PostgresAuthStore,keyWitnessBinding} from '../server/auth-store.ts';
import {sealState} from '../server/auth-state.ts';
import {authSchemaChecksum} from '../server/auth-store-schema.ts';

const exec=promisify(execFile),run=randomBytes(6).toString('hex'),parent=resolve('work/runtime-readiness-20261031');
const out=join(parent,run),owned=join(out,'owned-pg'),data=join(owned,'data'),marker='runtime-readiness:'+run;
const bin=process.env.IDMS_PG_BIN || (process.platform==='win32'?join(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin'):'/usr/lib/postgresql/16/bin');
const executable=name=>join(bin,name+(process.platform==='win32'?'.exe':''));
const password=randomBytes(32).toString('base64url'),appPassword=randomBytes(32).toString('base64url');
const result={run,passed:false,checks:[],customerBusinessWrites:0,enterpriseServicesStarted:0,enterpriseServicesStopped:0,cleanup:{}};
await mkdir(out,{recursive:true});await privateDirectory(owned);await writeFile(join(owned,'owner.json'),JSON.stringify({marker}));
let child,terminal,admin,pool,ownedPid,ownedPort,started=false,failed=false;
try {
 result.phase='INITDB';await privateNewFile(join(owned,'password'),password);
 await exec(executable('initdb'),['-D',data,'-U','idms_runtime_qa','-A','scram-sha-256','--pwfile',join(owned,'password'),'--encoding=UTF8','--locale=C'],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 let port;
 for(let i=0;i<40&&port===undefined;i++){const candidate=20000+randomBytes(2).readUInt16BE()%10000,reservation=createServer();try{await new Promise((ok,no)=>{reservation.once('error',no);reservation.listen(candidate,'127.0.0.1',ok);});await new Promise(r=>reservation.close(r));port=candidate;}catch(e){if(!['EADDRINUSE','EACCES'].includes(e.code))throw e;}}
 assert(port!==undefined);ownedPort=port;result.phase='START_OWNED_PG';
 child=spawn(executable('pg_ctl'),['start','-D',data,'-l',join(owned,'postgres.log'),'-w','-t','20','-o',`-h 127.0.0.1 -p ${port} -c shared_buffers=16MB -c max_connections=16 -c max_wal_size=64MB -c min_wal_size=32MB`],{windowsHide:true,stdio:'ignore'});
 terminal=new Promise((ok,no)=>{child.once('exit',code=>code===0?ok():no(Error('OWNED_PG_START_FAILED')));child.once('error',no);});started=true;await terminal;
 const pidLines=(await readFile(join(data,'postmaster.pid'),'utf8')).split(/\r?\n/);ownedPid=Number(pidLines[0]);assert(ownedPid>0);assert.equal(resolve(pidLines[1]),resolve(data));assert.equal(Number(pidLines[3]),port);
 const config={host:'127.0.0.1',port,database:'postgres',user:'idms_runtime_qa',password,connectionTimeoutMillis:500,statement_timeout:5000};
 for(let i=0;i<100;i++){
  const candidate=new pg.Client(config);
  try {await candidate.connect();admin=candidate;break;}catch{await candidate.end().catch(()=>{});await new Promise(r=>setTimeout(r,100));}
 }
 result.phase='CONNECT_OWNED_PG';assert(admin,'Owned PostgreSQL startup unconfirmed');
 result.serverVersion=(await admin.query('SHOW server_version')).rows[0].server_version;result.phase='CREATE_FIXTURE';await admin.query("CREATE ROLE idms_probe_app LOGIN PASSWORD '"+appPassword+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION");
 await admin.query('CREATE TABLE business_state(tenant_id text NOT NULL, value integer NOT NULL)');await admin.query("INSERT INTO business_state VALUES('qa',1)");
 await admin.query('CREATE TABLE auth_store_meta(deployment_digest text NOT NULL,key_check jsonb NOT NULL)');
 await admin.query('CREATE TABLE auth_schema_migrations(version integer NOT NULL,checksum text NOT NULL,deployment_digest text NOT NULL)');
 const deployment='a'.repeat(64),ring={format:1,activeKeyId:'qa-key',keys:[{keyId:'qa-key',key:randomBytes(32).toString('base64url')}]};
 const witness=sealState({marker:'IDMS_AUTH_STORE_V1',deploymentDigest:deployment},keyWitnessBinding(deployment),ring);
 await admin.query('INSERT INTO auth_store_meta VALUES($1,$2)',[deployment,witness]);await admin.query('INSERT INTO auth_schema_migrations VALUES(1,$1,$2)',[authSchemaChecksum,deployment]);
 await admin.query('REVOKE CREATE,TEMP ON DATABASE postgres FROM PUBLIC');await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
 await admin.query('GRANT SELECT ON business_state,auth_store_meta,auth_schema_migrations TO idms_probe_app');
 await admin.query('GRANT UPDATE ON business_state TO idms_probe_app'); // Permission exists; READ ONLY must still reject it.
 pool=new pg.Pool({...config,user:'idms_probe_app',password:appPassword,max:1,connectionTimeoutMillis:400,statement_timeout:5000});pool.on('error',()=>{});
 result.phase='READ_ONLY';await assert.rejects(runtimeReadOnly(pool,c=>c.query('UPDATE business_state SET value=2')),e=>e.code==='DATABASE_UNAVAILABLE');
 assert.equal((await admin.query('SELECT value FROM business_state')).rows[0].value,1);
 const dirty=await pool.connect();await dirty.query('BEGIN');await dirty.query('SELECT 1');dirty.release();let dirtyCallback=false;
 await assert.rejects(runtimeReadOnly(pool,async()=>{dirtyCallback=true;}),e=>e.code==='DATABASE_UNAVAILABLE');assert.equal(dirtyCallback,false);
 let cliPid;await readOnlyDatabase({host:config.host,port},{user:'idms_probe_app',database:'postgres',password:appPassword},async c=>{cliPid=c.processID;assert.equal((await c.query('SELECT value FROM business_state')).rows[0].value,1);});
 let cliActive=1;for(let i=0;i<50&&cliActive;i++){cliActive=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[cliPid])).rows[0].n;if(cliActive)await new Promise(r=>setTimeout(r,20));}assert.equal(cliActive,0);
 result.checks.push('effective READ ONLY confirmed, dirty inherited transaction refused before callback, fixture write rejected; CLI role-checked owned pool also reads successfully and closes backend; fixture unchanged');
 const runtime={format:1,purpose:'AUTH_SESSION_RUNTIME',host:config.host,port,deploymentDigest:deployment,account:{user:'idms_probe_app',database:'postgres',password:appPassword,ownerRole:'idms_runtime_qa',backupRole:'unused_qa_backup'},keyFile:'unused-qa-file'};
 const authState=new PostgresAuthStore(pool,runtime,ring,'qa-scope');
 const tasks=runtimeDependencyTasks({databases:[{tenantId:'qa',pool,database:'postgres',user:'idms_probe_app'}],authState,authConfig:{mode:'oidc'},workflow:{},ai:{},telemetry:{connected:false,subscribed:false,closing:false}});
 const ctx=()=>({signal:new AbortController().signal,deadline:performance.now()+3000,timeoutMs:1000});
 assert.equal((await tasks.business(ctx())).status,'PASS');assert.equal((await tasks.sessions(ctx())).status,'PASS');
 await admin.query("UPDATE auth_store_meta SET key_check='{}'");await assert.rejects(tasks.sessions(ctx()),e=>e.code==='SESSION_BINDING_MISMATCH');await admin.query('UPDATE auth_store_meta SET key_check=$1',[witness]);
 result.checks.push('actual process pools verify tenant/session binding and encrypted key witness; corrupt witness rejected');
 const held=await pool.connect();let callback=false;const at=performance.now();const delayed=runtimeReadOnly(pool,async()=>{callback=true;},{timeoutMs:60});
 const release=setTimeout(()=>held.release(),160);try{await assert.rejects(delayed,e=>e.code==='OBSERVATION_TIMEOUT');}finally{clearTimeout(release);}
 assert.equal(callback,false);assert(performance.now()-at>=140);assert.equal(pool.waitingCount,0);result.checks.push('saturated shared pool acquisition awaited; late borrowed client discarded without running query or spawning another probe');
 const controller=new AbortController();let pid,cancelPid,userCancellation=false,timer;
 try {await assert.rejects(runtimeReadOnly(pool,async c=>{pid=c.processID;timer=setTimeout(()=>controller.abort(),60);try{await c.query('SELECT pg_sleep(5)');}catch(e){userCancellation=e.code==='57014'&&/user request/i.test(e.message);throw e;}},{signal:controller.signal,timeoutMs:5000,cancel:async c=>{cancelPid=c.processID;return cancelSpareQuery(c);}}),e=>e.code==='OBSERVATION_TIMEOUT');}finally{clearTimeout(timer);}
 assert.equal(pid,cancelPid);assert.equal(userCancellation,true);assert.equal((await admin.query('SELECT 1 AS value')).rows[0].value,1);
 let active=1;for(let i=0;i<50&&active;i++){active=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0].n;if(active)await new Promise(r=>setTimeout(r,20));}assert.equal(active,0);
 result.checks.push('exact CancelRequest confirmed by original query; backend gone while unrelated original admin remains usable');
 const first=await pool.connect(),endListeners=first.listenerCount('end'),errorListeners=first.listenerCount('error');first.release();
 for(let i=0;i<20;i++)await runtimeReadOnly(pool,async c=>assert.equal((await c.query('SELECT 1 AS value')).rows[0].value,1));
 const last=await pool.connect();assert.equal(last.listenerCount('end'),endListeners);assert.equal(last.listenerCount('error'),errorListeners);last.release();assert.equal(pool.totalCount,1);assert.equal(pool.idleCount,1);
 result.checks.push('normal probe releases shared client without listener growth or pool.end; same pool remains usable for 20 cycles');result.phase='VERIFIED';result.passed=true;
} catch(e) {failed=true;result.error='OWNED_RUNTIME_READINESS_QA_FAILED';result.diagnostic={code:/^[A-Z0-9_]{1,64}$/.test(e.code||'')?e.code:null,name:e.name,message:String(e.message).replaceAll(password,'[redacted]').replaceAll(appPassword,'[redacted]').slice(0,600)};}
finally {
 await pool?.end().catch(()=>{});await admin?.end().catch(()=>{});
 try {
  if(started){
   const pidText=await readFile(join(data,'postmaster.pid'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(pidText){const lines=pidText.split(/\r?\n/);const pid=Number(lines[0]);assert(pid>0&&resolve(lines[1])===resolve(data)&&Number(lines[3])===ownedPort);if(ownedPid)assert.equal(pid,ownedPid);ownedPid=pid;assert.equal(JSON.parse(await readFile(join(owned,'owner.json'),'utf8')).marker,marker);assert.equal(await realpath(data),resolve(data));await exec(executable('pg_ctl'),['-D',data,'-m','fast','-w','-t','20','stop'],{windowsHide:true,timeout:25000,maxBuffer:65536});}
   if(ownedPid){let absent=false;for(let i=0;i<100&&!absent;i++){try{process.kill(ownedPid,0);await new Promise(r=>setTimeout(r,20));}catch(e){assert.equal(e.code,'ESRCH');absent=true;}}assert(absent);}
  }
  result.cleanup.ownedProcessTerminal=true;
  const rel=relative(parent,owned);assert(!rel.startsWith('..')&&!isAbsolute(rel)&&rel===join(run,'owned-pg'));assert.equal(await realpath(owned),resolve(owned));assert.equal(JSON.parse(await readFile(join(owned,'owner.json'),'utf8')).marker,marker);
  await rm(owned,{recursive:true});result.cleanup.ownedDataAndSecretsRemoved=true;
 }catch{failed=true;result.cleanup.error='OWNED_FIXTURE_RETAINED_FOR_REVIEW';}
 await writeFile(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({run,passed:result.passed&&!failed,checks:result.checks.length,cleanup:result.cleanup,evidence:out}));if(failed)process.exitCode=1;
