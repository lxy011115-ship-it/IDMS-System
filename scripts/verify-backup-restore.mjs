import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {generateKey,readKey,createTenantBackup,restoreTenantBackup,openBackup,privateNewFile} from './backup-support.mjs';
import {migrateQaDatabases,cleanupQaRoles,qaAdminAccount} from './qa-database.mjs';

const config=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),suffix=randomUUID().replaceAll('-','').slice(0,12),namespace='backupqa-'+suffix;
const directory=resolve('.local',namespace),temporary={host:config.host,port:config.port,bootstrapPassword:config.bootstrapPassword,tenants:{}},accounts=[],targets=[];
const admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:'postgres'});
const base='http://127.0.0.1:4049',keyFile=join(directory,'keys','test.json'),credentials=[];let core,sql,backup,log='';
async function stop(){if(!core||core.exitCode!==null||core.signalCode!==null)return;const done=new Promise(r=>core.once('exit',r));core.kill();await done;}
async function api(path,body,actor='demo.uploader'){
  const response=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{'X-Tenant-Id':'acme','X-Actor-Type':'USER','X-Actor-Id':actor,...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID()}:{})},body:body?JSON.stringify(body):undefined});const value=await response.json();assert.equal(response.status,body?202:200,JSON.stringify(value));return value;
}
try{
  await mkdir(directory,{recursive:true});await admin.connect();
  for(const tenant of ['acme','sandbox']){
    const name='idms_backupqa_'+tenant+'_'+suffix,account={database:name,user:name,password:randomBytes(32).toString('base64url')},owned={name};accounts.push(owned);temporary.tenants[tenant]=account;
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);owned.roleCreated=true;await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);owned.databaseCreated=true;await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
  }
  await privateNewFile(join(directory,'postgres.json'),JSON.stringify(await migrateQaDatabases(temporary,config)));
  core=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'4049',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:join(directory,'postgres.json'),IDMS_DEMO_NAMESPACE:namespace,IDMS_AUTH_MODE:'demo',IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const stream of [core.stdout,core.stderr])stream.on('data',b=>log=(log+b).slice(-2000));
  let ready=false;for(let i=0;i<100;i++){if(core.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/v1/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'Isolated QA core must start');
  const device={source_record_id:'backup-device',device_code:'PUMP-01',device_name:'备份恢复泵组',site_code:'FACTORY-01',line_code:'LINE-01',equipment_type:'泵组'};
  const uploaded=await api('/data-imports/records',{dataType:'DEVICE',records:[device],templateVersion:'1.0.0',sourceSystem:'backup-qa'});
  await api('/data-imports/'+uploaded.batchId+'/approval',{decision:'APPROVED',comment:'独立核对设备',expectedVersion:uploaded.version,snapshotDigest:uploaded.snapshotDigest},'demo.approver');
  await stop();sql=new pg.Client(qaAdminAccount(config,temporary.tenants.acme));await sql.connect();
  await sql.query("CREATE TABLE backup_qa_extra(id bigserial PRIMARY KEY,tenant_id text NOT NULL,body jsonb NOT NULL,bytes bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now()); INSERT INTO backup_qa_extra(tenant_id,body,bytes) VALUES ('acme','{\"original\":\"验证全部公共表而非界面导出\"}',decode('0001ff','hex'))");
  await sql.query(`GRANT SELECT ON backup_qa_extra,backup_qa_extra_id_seq TO "${temporary.businessRoles.acme.backup.user}"`);
  const generated=await generateKey(keyFile);assert.ok(generated.keyId);
  // Modify a non-business QA table while exporting: dump and facts must share the exported MVCC snapshot.
  const writer=new pg.Client(qaAdminAccount(config,temporary.tenants.acme));await writer.connect();
  let writing=false,writerError,writes=0;
  const timer=setInterval(()=>{if(writing)return;writing=true;writer.query("UPDATE backup_qa_extra SET body=body||jsonb_build_object('tick',clock_timestamp()::text)").then(()=>writes++).catch(e=>writerError=e).finally(()=>writing=false);},10);
  try{backup=await createTenantBackup({config:temporary,tenantId:'acme',keyFile,outputDirectory:join(directory,'archives')});}
  finally{clearInterval(timer);while(writing)await new Promise(r=>setTimeout(r,10));await writer.end();}
  assert.equal(writerError,undefined);assert.ok(writes>0,'The source writer must actually run during export');const archive=await readFile(backup.file);assert.equal(archive.includes(Buffer.from('backup-device')),false);
  const opened=openBackup(archive,await readKey(keyFile),'acme');assert.ok(opened.manifest.facts.some(f=>f.table==='backup_qa_extra'&&f.rows===1));
  assert.ok(opened.manifest.facts.some(f=>f.table==='audit_ledger'&&f.rows>0));
  const target='idms_restore_acme_'+suffix,credentialFile=join(directory,'restore.json'),ownership={name:target};targets.push(ownership);credentials.push(credentialFile);
  const restored=await restoreTenantBackup({config:temporary,tenantId:'acme',keyFile,backupFile:backup.file,targetDatabase:target,credentialFile,ownership});
  assert.equal(restored.verified,true);assert.equal(restored.checks.batches,1);assert.equal(restored.checks.records,1);assert.equal(restored.liveConfigurationChanged,false);
  const account=JSON.parse(await readFile(credentialFile,'utf8')),readback=new pg.Client(account);await readback.connect();
  try{assert.equal((await readback.query('SELECT payload FROM runtime_state')).rows[0].payload.imports.batches[0].approval.approver,'demo.approver');await assert.rejects(readback.query("UPDATE audit_ledger SET hash='tampered'"),/append-only/);assert.equal((await readback.query("SELECT rolcanlogin,rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user")).rows[0].rolsuper,false);}
  finally{await readback.end();}
  await assert.rejects(restoreTenantBackup({config:temporary,tenantId:'acme',keyFile,backupFile:backup.file,targetDatabase:target,credentialFile:join(directory,'must-not-exist.json')}),/already exists/);
  const bad=Buffer.from(archive);bad[bad.length-1]^=1;const badFile=join(directory,'tampered.idmsbackup');await privateNewFile(badFile,bad);
  const forbidden='idms_restore_acme_'+randomUUID().replaceAll('-','').slice(0,12);
  await assert.rejects(restoreTenantBackup({config:{...temporary,port:1},tenantId:'acme',keyFile,backupFile:badFile,targetDatabase:forbidden,credentialFile:join(directory,'never.json')}),/authentication/,'Tampered archive must fail before connecting to any DB');
  await assert.rejects(restoreTenantBackup({config:temporary,tenantId:'sandbox',keyFile,backupFile:backup.file,targetDatabase:'idms_restore_sandbox_'+suffix,credentialFile:join(directory,'never.json')}),/tenant/);
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[forbidden])).rowCount,0);
  await mkdir('outputs',{recursive:true});
  const evidence={verifiedAt:new Date().toISOString(),namespace,syntheticDataOnly:true,encryptedBackupWithoutPlaintextDump:true,independentKeyAndExclusiveFiles:true,actualPgDumpPgRestore:true,concurrentWriterConsistentExportedSnapshot:true,allPublicTablesAndOriginalApprovalAuditRestored:true,appendOnlyAuditTriggerRestored:true,nonSuperuserIsolatedRecovery:true,tamperRejectedBeforeDatabaseConnection:true,crossTenantRestoreRejected:true,existingTargetNotOverwritten:true,productionAcceptance:false,scope:'TENANT_BUSINESS_DATABASE',recoveryMode:'ISOLATED_BUSINESS_ONLY'};
  await writeFile('outputs/backup-restore-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));await unlink(badFile);
}finally{
  await stop();await sql?.end();
  // Only this run's exact, verified QA names are eligible for cleanup.
  for(const owned of [...targets,...accounts]){
    const {name}=owned;
    assert.ok(name.endsWith('_'+suffix)&&/^idms_(?:restore_acme|backupqa_acme|backupqa_sandbox)_[0-9a-f]{12}$/.test(name));
    if(owned.databaseCreated)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);if(owned.roleCreated)await admin.query(`DROP ROLE "${name}"`);
  }
  await cleanupQaRoles(admin,temporary);await admin.end();
  for(const file of [backup?.file,...credentials,keyFile,join(directory,'postgres.json')].filter(Boolean))await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});
  for(const path of [join(directory,'archives'),join(directory,'keys'),directory])await rmdir(path).catch(e=>{if(!['ENOENT','ENOTEMPTY'].includes(e.code))throw e;});
}
