import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import {migrateQaDatabases,cleanupQaRoles} from './qa-database.mjs';
const config=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),suffix=randomUUID().replaceAll('-','').slice(0,10);
const temporary={host:config.host,port:config.port,tenants:Object.fromEntries(Object.keys(config.tenants).map(id=>{const name=`idms_qa_${id}_${suffix}`;return [id,{user:name,password:randomBytes(32).toString('base64url'),database:name}];}))};
const configPath=resolve('.local',`qa-postgres-${suffix}.json`),namespace=`postgres-qa-${suffix}`,base='http://127.0.0.1:4024';
const admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:'postgres'});
let child,conn;
async function start(){
  child=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'4024',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:configPath,IDMS_DEMO_NAMESPACE:namespace},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let log='';child.stderr.on('data',b=>log+=b);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/v1/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('startup timeout '+log);
}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
async function api(path,{actor='demo.approver',tenant='acme',body,expected=200,key=randomUUID()}={}){
  const response=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{'X-Tenant-Id':tenant,'X-Actor-Id':actor,'X-Actor-Type':'USER',...(body?{'Content-Type':'application/json','Idempotency-Key':key,'X-Correlation-Id':randomUUID()}: {})},body:body?JSON.stringify(body):undefined});
  const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
}
try{
  await admin.connect();
  for(const account of Object.values(temporary.tenants)){
    assert.match(account.database,/^idms_qa_(acme|sandbox)_[0-9a-f]{10}$/);
    await admin.query(`CREATE ROLE "${account.user}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`CREATE DATABASE "${account.database}" OWNER "${account.user}"`);
    await admin.query(`REVOKE CONNECT ON DATABASE "${account.database}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${account.database}" TO "${account.user}"`);
  }
  await writeFile(configPath,JSON.stringify(await migrateQaDatabases(temporary,config)),{mode:0o600});await start();
  assert.equal((await api('/health')).storage,'postgres-tenant-databases');
  const input={decision:'APPROVED',comment:'独立数据库事务测试',expectedVersion:1},key=randomUUID();
  const alert=await api('/predictive/alerts/palert-001/approval',{body:input,key});assert.ok(alert.workOrderId);
  const orderId=alert.workOrderId;
  await api('/predictive/alerts/palert-001/approval',{body:{...input,comment:'同键不同请求'},key,expected:409});
  await api(`/work-orders/${orderId}/start`,{actor:'demo.technician',body:{expectedVersion:1}});
  const submitted=await api(`/work-orders/${orderId}/submit`,{actor:'demo.technician',body:{expectedVersion:2,failureCode:'BRG-WEAR',cause:'轴承磨损',action:'更换并复测',verification:'同负载复测3.1mm/s',minutes:90,partsUsed:['6205']}});
  await api(`/work-orders/${orderId}/approval`,{body:{expectedVersion:submitted.version,decision:'APPROVED',comment:'证据充分，关单',snapshotDigest:submitted.resolution.digest}});
  await api(`/work-orders/${orderId}`,{tenant:'sandbox',expected:404});
  const before=await api('/audit');assert.equal(before.chainValid,true);
  conn=new pg.Client({host:config.host,port:config.port,...temporary.tenants.acme});await conn.connect();
  const projected=(await conn.query('SELECT state,body FROM work_orders WHERE id=$1',[orderId])).rows[0];assert.equal(projected.state,'CLOSED');
  assert.equal(Number((await conn.query('SELECT count(*) FROM audit_ledger')).rows[0].count),before.items.length);
  await assert.rejects(conn.query("UPDATE audit_ledger SET hash='tampered'"),/permission denied/);
  const cross=new pg.Client({host:config.host,port:config.port,...temporary.tenants.acme,database:temporary.tenants.sandbox.database});
  await assert.rejects(cross.connect(),/permission denied/);await cross.end().catch(()=>{});
  await stop();await start();
  assert.deepEqual(await api(`/work-orders/${orderId}`),projected.body);
  assert.deepEqual(await api('/predictive/alerts/palert-001/approval',{body:input,key}),alert);
  assert.equal((await api('/audit')).chainValid,true);
  // A committed revision from another database transaction no longer requires process restart.
  await assert.rejects(conn.query('UPDATE runtime_state SET revision=revision+1 WHERE singleton=true'),e=>e.code==='55000'||e.code==='42501');
  await conn.query("UPDATE business_state SET revision=revision+1 WHERE tenant_id='acme'");
  const fresh=await api('/alarms/alm-2408/approval',{body:{decision:'APPROVED',comment:'核对最新提交后批准'}});assert.equal(fresh.state,'CLOSED');
  assert.equal((await api('/alarms')).items.find(a=>a.id==='alm-2408').state,'CLOSED');assert.equal((await api('/audit')).items.length,before.items.length+1);
  const reset=await api('/demo/reset',{actor:'demo.admin',body:{},expected:403});assert.ok(reset.error);
  await mkdir('outputs',{recursive:true});const result={postgres:'16.10',independentTenantDatabases:true,databaseConnectIsolation:true,workOrderProjection:true,appendOnlyAudit:true,transactionalApproval:true,persistentIdempotency:true,latestCommittedRevisionLoadedWithoutRestart:true,legacyAggregateWriteBlocked:true,restartRecovery:true,testDatabases:'isolated generated databases, removed after test'};
  await writeFile('outputs/postgres-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{
  await stop();if(conn)await conn.end();
  for(const account of Object.values(temporary.tenants)){
    if(/^idms_qa_(acme|sandbox)_[0-9a-f]{10}$/.test(account.database)){await admin.query(`DROP DATABASE IF EXISTS "${account.database}" WITH (FORCE)`);await admin.query(`DROP ROLE IF EXISTS "${account.user}"`);}
  }
  await cleanupQaRoles(admin,temporary);await admin.end();await unlink(configPath).catch(()=>{});
}
