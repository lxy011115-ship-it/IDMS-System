import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {migrateQaDatabases,cleanupQaRoles,qaAdminAccount,backupRuntime} from './qa-database.mjs';
import {businessSchema,workflowSchema,aiSchema,moduleTables,migrationVersion} from '../server/postgres-schema.ts';
import {tenantSeed,migrateTenant} from './database-migrations.mjs';
import {seedStore} from '../server/store.ts';
import {emptyImports,canonical} from '../server/imports.ts';
import {writePrivate} from './keycloak-local.mjs';
import {generateKey,createTenantBackup,restoreTenantBackup} from './backup-support.mjs';

const root=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),suffix=randomUUID().replaceAll('-','').slice(0,10),namespace='rolesqa-'+suffix;
const directory=resolve('.local',namespace),config={host:root.host,port:root.port,tenants:{}},base='http://127.0.0.1:4052',created=[],restores=[];
const admin=new pg.Client({host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database:'postgres'});
const {audits,idempotency,...business}=seedStore(),snapshot={version:2,business,audits,idempotency:[...idempotency],imports:emptyImports()};
let child,sql;const evidence={namespace,syntheticDataOnly:true,productionAcceptance:false},pause=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const end=new Promise(r=>child.once('exit',r));child.kill();await end;}
async function start(configFile=join(directory,'business.json')){
  let log='';child=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'4052',IDMS_STORAGE:'postgres',IDMS_AUTH_MODE:'demo',IDMS_POSTGRES_CONFIG:configFile,IDMS_DEMO_NAMESPACE:namespace,IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const s of [child.stdout,child.stderr])s.on('data',b=>log=(log+b).slice(-6000));
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/v1/health')).ok)return;}catch{}await pause(100);}throw Error('Isolated core startup unconfirmed: '+log);
}
async function api(path,body,actor='demo.approver',expected=200,key=randomUUID()){
  const r=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{'X-Tenant-Id':'acme','X-Actor-Id':actor,'X-Actor-Type':'USER',...(body?{'Content-Type':'application/json','Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.equal(r.status,expected,JSON.stringify(v));return v;
}
async function denied(client,statement){await assert.rejects(client.query(statement),e=>e.code==='42501'||(statement.startsWith('UPDATE runtime_state')&&e.code==='55000'),'App must be denied: '+statement);}
try{
  await mkdir(directory,{recursive:true});await admin.connect();
  for(const tenant of ['acme','sandbox']){
    const name='idms_rolesqa_'+tenant+'_'+suffix,a={user:name,database:name,password:randomBytes(32).toString('base64url')};config.tenants[tenant]=a;
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${a.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);created.push(a);await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);a.created=true;
    await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
  }
  // Simulate the old app-owned schema in one tenant; the other starts empty.
  const legacy=new pg.Client({host:root.host,port:root.port,...config.tenants.acme});await legacy.connect();
  const original=tenantSeed(snapshot,'acme');try{await legacy.query(businessSchema);await legacy.query(workflowSchema);await legacy.query(aiSchema);await legacy.query('INSERT INTO runtime_state(singleton,revision,schema_version,payload) VALUES(true,7,2,$1)',[original]);}finally{await legacy.end();}
  const runtime=await migrateQaDatabases(config,root,{telemetryTenants:['sandbox'],snapshot});await writePrivate(join(directory,'business.json'),JSON.stringify(runtime));
  sql=new pg.Client(qaAdminAccount(root,config.tenants.acme));await sql.connect();assert.equal((await sql.query('SELECT revision FROM runtime_state')).rows[0].revision,'7');assert.equal(canonical((await sql.query('SELECT payload FROM runtime_state')).rows[0].payload),canonical(original));
  const deployment={...config,bootstrapPassword:root.bootstrapPassword};await migrateTenant(deployment,'acme',snapshot);await Promise.all([migrateTenant(deployment,'sandbox',snapshot),migrateTenant(deployment,'sandbox',snapshot)]);evidence.legacyAndEmptyDatabaseMigrationAndConcurrentRerun=true;
  const deploymentFile=join(directory,'deployment.json'),backupFile=join(directory,'backup.json'),migrationFile=join(directory,'migration.json');await writePrivate(deploymentFile,JSON.stringify(deployment));
  const cliArgs=['scripts/migrate-postgres.mjs','--config',deploymentFile,'--business-config',join(directory,'business.json'),'--backup-config',backupFile,'--migration-config',migrationFile,'--telemetry-tenants','sandbox'],exec=promisify(execFile);
  await exec(process.execPath,cliArgs,{windowsHide:true,env:{...process.env,IDMS_STORAGE:'file'}});
  assert.deepEqual(JSON.parse(await readFile(join(directory,'business.json'),'utf8')),runtime);assert.equal(JSON.parse(await readFile(backupFile,'utf8')).purpose,'BUSINESS_BACKUP');assert.equal(JSON.parse(await readFile(migrationFile,'utf8')).purpose,'BUSINESS_MIGRATION');
  await assert.rejects(exec(process.execPath,['scripts/migrate-postgres.mjs','--config',deploymentFile,'--business-config',deploymentFile],{windowsHide:true,env:{...process.env,IDMS_STORAGE:'file'}}),/paths must be distinct/);assert.deepEqual(JSON.parse(await readFile(deploymentFile,'utf8')).tenants,deployment.tenants);evidence.actualCliSeparatesPrivateConfigurationsAndRejectsPathCollisions=true;
  const app=new pg.Client({host:root.host,port:root.port,...config.tenants.acme});await app.connect();
  try{
    for(const command of ["UPDATE audit_ledger SET hash='x'",'DELETE FROM audit_ledger','TRUNCATE audit_ledger',"UPDATE managed_assets SET brand='x'",'DELETE FROM managed_measurements','TRUNCATE managed_import_rows','ALTER TABLE audit_ledger DISABLE TRIGGER USER','DROP TABLE work_orders','CREATE TABLE forbidden(id int)',"CREATE FUNCTION forbidden() RETURNS int LANGUAGE sql AS 'SELECT 1'",`SET ROLE "${config.businessRoles.acme.owner}"`,`SET ROLE "${config.businessRoles.acme.migrator.user}"`,`SET ROLE "${config.tenants.sandbox.user}"`,"SELECT setval('audit_ledger_sequence_no_seq',1)",'CREATE ROLE forbidden','CREATE TEMP TABLE forbidden(id int)'])await denied(app,command);
    const other=new pg.Client({host:root.host,port:root.port,...config.tenants.acme,database:config.tenants.sandbox.database});await assert.rejects(other.connect(),e=>e.code==='42501');await other.end().catch(()=>{});
  }finally{await app.end();}
  evidence.applicationDdlMutationSetRoleSetvalAndCrossTenantDenied=true;
  await start();const input={decision:'APPROVED',comment:'低权限账号事务验证',expectedVersion:1},key=randomUUID();const alert=await api('/predictive/alerts/palert-001/approval',input,'demo.approver',200,key);assert.ok(alert.workOrderId);await stop();await start();assert.deepEqual(await api('/predictive/alerts/palert-001/approval',input,'demo.approver',200,key),alert);assert.equal((await api('/audit')).chainValid,true);await stop();evidence.normalWorkOrderAuditIdempotencyAndRestart=true;
  await sql.query("UPDATE idms_schema_migrations SET checksum=repeat('0',64)");await assert.rejects(start(),/checksum|migration/i);await stop();await assert.rejects(migrateTenant(deployment,'acme',snapshot),/checksum/);
  const {migrationChecksum,latestMigrationChecksum,normalizedMigrationChecksum,revisionMigrationChecksum,legacyMigrationChecksum}=await import('../server/postgres-schema.ts');await sql.query('UPDATE idms_schema_migrations SET checksum=CASE WHEN version=1 THEN $1 WHEN version=2 THEN $2 WHEN version=3 THEN $3 WHEN version=4 THEN $4 WHEN version=5 THEN $5 END',[legacyMigrationChecksum(false),revisionMigrationChecksum(false),normalizedMigrationChecksum(false),migrationChecksum(false),latestMigrationChecksum(false)]);evidence.checksumMismatchBlocksMigrationAndRuntime=true;
  await sql.query(`GRANT DELETE ON audit_ledger TO "${config.tenants.acme.user}"`);await assert.rejects(start(),/privileges|permission/i);await stop();await sql.query(`REVOKE DELETE ON audit_ledger FROM "${config.tenants.acme.user}"`);evidence.excessPrivilegeBlocksStartup=true;
  await sql.query('ALTER TABLE audit_ledger DISABLE TRIGGER immutable_audit');await assert.rejects(start(),/protection/i);await stop();await sql.query('ALTER TABLE audit_ledger ENABLE TRIGGER immutable_audit');evidence.disabledAuditProtectionBlocksStartup=true;
  await sql.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${config.businessRoles.acme.owner}" IN SCHEMA public GRANT SELECT ON TABLES TO "${config.tenants.acme.user}"`);await assert.rejects(start(),/default privileges/i);await stop();await sql.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${config.businessRoles.acme.owner}" IN SCHEMA public REVOKE SELECT ON TABLES FROM "${config.tenants.acme.user}"`);evidence.defaultPrivilegeDriftBlocksStartup=true;
  await sql.query(`GRANT UPDATE(revision) ON runtime_state TO "${config.businessRoles.acme.backup.user}"`);await assert.rejects(start(),/backup column/i);await stop();await sql.query(`REVOKE UPDATE(revision) ON runtime_state FROM "${config.businessRoles.acme.backup.user}"`);evidence.backupColumnWriteBlocksStartup=true;
  await sql.query("CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'");await assert.rejects(start(),/function/i);await stop();await sql.query("CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit ledger is append-only'; END $$");evidence.triggerBodyDriftBlocksStartup=true;
  await writePrivate(join(directory,'forbidden-config.json'),JSON.stringify({...runtime,bootstrapPassword:root.bootstrapPassword}));await assert.rejects(start(join(directory,'forbidden-config.json')),/BUSINESS_RUNTIME/);await stop();evidence.deploymentSecretsRejectedByRuntime=true;
  const backupConfig=backupRuntime(config),backupAccount=backupConfig.tenants.acme,reader=new pg.Client({host:root.host,port:root.port,...backupAccount});await reader.connect();try{await denied(reader,"UPDATE runtime_state SET revision=1");await denied(reader,'CREATE TABLE forbidden(id int)');assert.equal(Number((await reader.query('SELECT count(*) FROM idms_schema_migrations')).rows[0].count),migrationVersion);}finally{await reader.end();}
  const keyFile=join(directory,'backup-key.json');await generateKey(keyFile);const backup=await createTenantBackup({config:backupConfig,tenantId:'acme',keyFile,outputDirectory:join(directory,'backups')});
  const target='idms_restore_acme_'+randomUUID().replaceAll('-','').slice(0,12),ownership={database:target};restores.push(ownership);
  const recovered=await restoreTenantBackup({config:deployment,tenantId:'acme',keyFile,backupFile:backup.file,targetDatabase:target,credentialFile:join(directory,'restore.json'),ownership});assert.equal(recovered.verified,true);assert.equal(recovered.tables,moduleTables(false).length-1);evidence.readOnlyBackupAndIsolatedRecoveryWithMigrationTable=true;
  await start();await stop();evidence.verifiedAt=new Date().toISOString();await writeFile('outputs/database-roles-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{
  await stop();await sql?.end();
  for(const r of restores){assert.match(r.database,/^idms_restore_acme_[a-f0-9]{12}$/);if(r.databaseCreated)await admin.query(`DROP DATABASE "${r.database}" WITH(FORCE)`);if(r.roleCreated)await admin.query(`DROP ROLE "${r.database}"`);}
  for(const a of created){assert.match(a.database,new RegExp('^idms_rolesqa_(acme|sandbox)_'+suffix+'$'));if(a.created)await admin.query(`DROP DATABASE "${a.database}" WITH(FORCE)`);await admin.query(`DROP ROLE "${a.user}"`);}
  await cleanupQaRoles(admin,config);await admin.end();for(const file of ['business.json','forbidden-config.json','restore.json','backup-key.json','deployment.json','backup.json','migration.json'])await unlink(join(directory,file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
}


