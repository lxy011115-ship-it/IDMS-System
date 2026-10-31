// Small owned PostgreSQL fixture for cancellation and read-only enforcement.
// Does not stop real services or write enterprise business databases.
import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {localHost} from './runtime-inspection-input.mjs';
import {readOnlyDatabase} from './runtime-inspection-probes.mjs';
import {cancelSpareQuery} from '../server/spares-cancel.ts';

const root=resolve('.'),run=randomBytes(6).toString('hex'),out=join(root,'work/runtime-inspection-20261031',run);await mkdir(out,{recursive:true});
const runtime=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),host=localHost(runtime.host),database='idms_inspect_qa_'+run,role=database,marker='owned-runtime-inspection:'+run,password=randomBytes(32).toString('base64url'),quote=s=>'"'+s.replaceAll('"','""')+'"';
const admin=new pg.Client({host,port:runtime.port,user:'idms_bootstrap',password:runtime.bootstrapPassword,database:'postgres',connectionTimeoutMillis:5000,statement_timeout:5000});
let db=false,user=false,owner,failed=false;const checks=[];const result={run,passed:false,checks,customerBusinessWrites:0,identityChanges:0,processesStopped:0};
await admin.connect();
try{
 await admin.query('CREATE ROLE '+quote(role)+" LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION");user=true;
 await admin.query('CREATE DATABASE '+quote(database));db=true;await admin.query('COMMENT ON DATABASE '+quote(database)+" IS '"+marker+"'");await admin.query('REVOKE ALL ON DATABASE '+quote(database)+' FROM PUBLIC');await admin.query('GRANT CONNECT ON DATABASE '+quote(database)+' TO '+quote(role));
 owner=new pg.Client({host,port:runtime.port,user:'idms_bootstrap',password:runtime.bootstrapPassword,database});await owner.connect();
 await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await owner.query('GRANT USAGE ON SCHEMA public TO '+quote(role));await owner.query('CREATE TABLE public.inspection_qa_values(value integer NOT NULL)');await owner.query('INSERT INTO public.inspection_qa_values VALUES (1),(2)');await owner.query('GRANT SELECT ON public.inspection_qa_values TO '+quote(role));
 const config={host,port:runtime.port},account={user:role,password,database};
 await readOnlyDatabase(config,account,async c=>{assert.equal((await c.query('SELECT count(*)::int AS count FROM public.inspection_qa_values')).rows[0].count,2);await assert.rejects(c.query('INSERT INTO public.inspection_qa_values VALUES (3)'),e=>e.code==='25006');});checks.push('actual application connection is read-only; attempted fixture-only write is rejected');
 assert.equal((await owner.query('SELECT count(*)::int AS count FROM public.inspection_qa_values')).rows[0].count,2);checks.push('fixture data unchanged after probe');
 const controller=new AbortController();let queryPid,cancelledPid,controlSocketCleanEnd,userCancellation=false,timer;const started=performance.now();
 try{await assert.rejects(readOnlyDatabase(config,account,async c=>{queryPid=c.processID;timer=setTimeout(()=>controller.abort(),60);try{await c.query('SELECT pg_sleep(5)');}catch(e){userCancellation=e.code==='57014'&&/user request/i.test(e.message);throw e;}},{signal:controller.signal,timeoutMs:3000,cancel:async c=>{cancelledPid=c.processID;controlSocketCleanEnd=await cancelSpareQuery(c);return controlSocketCleanEnd;}}),e=>e.code==='OBSERVATION_TIMEOUT'&&e.status==='UNKNOWN');}finally{clearTimeout(timer);result.cancelAttempt={queryPid,cancelledPid,controlSocketCleanEnd,userCancellation,timerFired:controller.signal.aborted};}
 assert.equal(cancelledPid,queryPid);assert.equal(userCancellation,true);result.cancelObservedMs=Math.round(performance.now()-started);checks.push('CancelRequest targets exactly the borrowed backend; original query confirms user cancellation and transport settles before return');
 let active=1;for(let i=0;i<50&&active;i++){active=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[queryPid])).rows[0].n;if(active)await new Promise(r=>setTimeout(r,20));}assert.equal(active,0);assert.equal((await admin.query('SELECT 1 AS value')).rows[0].value,1);checks.push('cancelled backend absent while original admin and real services remain undisplaced');
 const already=new AbortController();already.abort();await assert.rejects(readOnlyDatabase(config,account,()=>{throw Error('Must not execute');},{signal:already.signal}),e=>e.code==='OBSERVATION_TIMEOUT');checks.push('already-aborted inspection performs no query');
 result.passed=true;
}catch(e){failed=true;result.error='OWNED_INSPECTION_VERIFICATION_FAILED';result.diagnostic={name:e.name,code:/^[A-Z0-9_]{1,64}$/.test(e.code||'')?e.code:null,actual:typeof e.actual==='boolean'||typeof e.actual==='number'?e.actual:null,expected:typeof e.expected==='boolean'||typeof e.expected==='number'?e.expected:null};}
finally{
 await owner?.end();let removedDatabase=false,removedRole=false;
 try{
  if(db){const row=(await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",[database])).rows[0];assert.equal(row?.marker,marker);let active=1;for(let i=0;i<100&&active;i++){active=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n;if(active)await new Promise(r=>setTimeout(r,25));}assert.equal(active,0);await admin.query('DROP DATABASE '+quote(database));removedDatabase=true;}
  if(user){await admin.query('DROP ROLE '+quote(role));removedRole=true;}
 }catch{failed=true;result.cleanupError='OWNED_FIXTURE_RETAINED_FOR_REVIEW';}
 await admin.end();result.cleanup={removedDatabase,removedRole,forcedDisconnects:0};await writeFile(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({passed:result.passed&&!failed,checks:checks.length,run,cleanup:result.cleanup,evidence:'work/runtime-inspection-20261031/'+run}));if(failed)process.exitCode=1;
