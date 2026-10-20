import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute,basename} from 'node:path';
import pg from 'pg';
import {quoteIdentifier as q} from '../server/postgres-schema.ts';
import {connectionFor,verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {verifyFieldModule} from '../server/field-schema-check.ts';
import {canonical} from '../server/imports.ts';
import {migrateQaDatabases,cleanupQaRoles,backupRuntime} from './qa-database.mjs';
import {migrationRuntime} from './database-migrations.mjs';
import {migrateFieldTenant} from './field-migration.mjs';
import {telemetryQualityFixture} from './fixtures/telemetry-quality-model.mjs';
import {writePrivate} from './keycloak-local.mjs';
import {sourceSecurityFrame,applySourceFrozenPrivileges} from './field-source-freeze-security.mjs';
import {stageFieldRuntimePrivileges} from './field-activation-security.mjs';

const root=JSON.parse(await readFile('.local/postgres-runtime.json','utf8'));
const suffix=randomUUID().replaceAll('-','').slice(0,10),name='idms_activationqa_acme_'+suffix;
const base=resolve('work/field-channel-20261017'),directory=resolve(base,'activation-security-'+suffix);
const config={host:root.host,port:root.port,tenants:{acme:{user:name,database:name,password:randomBytes(32).toString('base64url')}}};
const superConfig={host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database:'postgres'};
const admin=new pg.Client(superConfig),clients=[],workers=[];
const connect=async options=>{const c=new pg.Client({...options,connectionTimeoutMillis:4000,query_timeout:6000});c.on('error',()=>{});clients.push(c);await c.connect();return c;};
const roleImage=async()=>canonical((await admin.query('SELECT oid::text,rolname,rolcanlogin FROM pg_roles ORDER BY oid')).rows);
let roleBaseline,runtime,migrator,app,backup,observer,writer,lateApp,lateMig,proof;
await mkdir(directory);await admin.connect();roleBaseline=await roleImage();
async function noLogin(account){const c=new pg.Client({...connectionFor(runtime,account),connectionTimeoutMillis:4000});c.on('error',()=>{});try{await assert.rejects(c.connect(),e=>e.code==='28000');}finally{await c.end().catch(()=>{});}}
async function invisible(){
 await noLogin(app);await noLogin(migrator);
 await sourceSecurityFrame(observer,app,migrator.user,'FROZEN');
 assert.equal((await lateApp.query("SELECT has_table_privilege(current_user,'public.business_state','UPDATE') AS writable")).rows[0].writable,false);
 await assert.rejects(lateApp.query('UPDATE public.business_state SET revision=revision'),e=>e.code==='42501');
 await assert.rejects(lateApp.query("SELECT nextval('public.audit_ledger_sequence_no_seq')"),e=>e.code==='42501');
 await assert.rejects(lateMig.query(`SET ROLE ${q(app.ownerRole)}`),e=>e.code==='42501');
}
async function unchanged(){
 const tables=(await observer.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','idms_field') AND c.relkind='r' ORDER BY n.nspname COLLATE \"C\",c.relname COLLATE \"C\"")).rows;
 const rows=[];for(const t of tables)rows.push({table:t,rows:(await observer.query(`SELECT to_jsonb(t)::text AS row FROM ${q(t.schema)}.${q(t.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows});
 return canonical({rows,sequence:(await observer.query('SELECT * FROM public.audit_ledger_sequence_no_seq')).rows});
}
async function worker(){
 const record={terminal:false},child=record.child=fork(resolve('scripts/fixtures/field-activation-security-probe.mjs'),[resolve(directory,'probe.json')],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_ENV:'test'}});workers.push(record);
 let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-2048));
 record.closed=new Promise(ok=>child.once('close',(code,signal)=>{record.terminal=true;ok({code,signal,stderr});}));
 const staged=await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('Activation security probe stage timed out')),15000);child.once('message',v=>{clearTimeout(timer);if(v.type==='STAGED')ok(v);else no(Error('Unexpected stage result'));});child.once('error',e=>{clearTimeout(timer);no(e);});child.once('exit',()=>{clearTimeout(timer);no(Error('Probe exited before stage: '+stderr));});});
 record.backend=staged.pid;return record;
}
async function backendGone(record){const end=Date.now()+5000;while((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[record.backend])).rowCount){assert.ok(Date.now()<end,'Terminated controller backend did not close');await new Promise(ok=>setTimeout(ok,20));}}
try{
 await admin.query(`CREATE ROLE ${q(name)} LOGIN PASSWORD '${config.tenants.acme.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
 await admin.query(`CREATE DATABASE ${q(name)} OWNER ${q(name)}`);
 runtime=await migrateQaDatabases(config,root,{snapshot:telemetryQualityFixture({count:0}).snapshot});
 const migration=migrationRuntime(config);migrator=migration.tenants.acme;app=runtime.tenants.acme;
 await migrateFieldTenant(runtime,migration,'acme');
 backup=await connect(connectionFor(runtime,backupRuntime(config).tenants.acme));
 observer=await connect({...superConfig,database:name});writer=await connect({...superConfig,database:name});
 lateApp=await connect(connectionFor(runtime,app));lateMig=await connect(connectionFor(runtime,migrator));
 await writer.query('BEGIN');await applySourceFrozenPrivileges(writer,app,migrator.user);await writer.query('COMMIT');
 const baseline=await unchanged();await invisible();
 await assert.rejects(stageFieldRuntimePrivileges(writer,app,migrator.user,'acme'),e=>e.code==='FIELD_ACTIVATION_TRANSACTION_REQUIRED');
 await backup.query('BEGIN');await assert.rejects(stageFieldRuntimePrivileges(backup,app,migrator.user,'acme'),e=>e.code==='FIELD_ACTIVATION_AUTHORITY_REQUIRED');await backup.query('ROLLBACK');
 await writer.query('BEGIN');await stageFieldRuntimePrivileges(writer,app,migrator.user,'acme');
 await invisible();assert.equal(await unchanged(),baseline);await writer.query('ROLLBACK');await invisible();assert.equal(await unchanged(),baseline);
 await writePrivate(resolve(directory,'probe.json'),JSON.stringify({connection:{...superConfig,database:name},account:app,migrator:migrator.user,tenantId:'acme'}));
 const held=await worker();await invisible();assert.equal(await unchanged(),baseline);
 assert.equal(held.child.kill(),true);await held.closed;await backendGone(held);await invisible();assert.equal(await unchanged(),baseline);
 const committing=await worker();await invisible();committing.child.send({type:'COMMIT'});const end=await committing.closed;assert.equal(end.code,23,end.stderr);await backendGone(committing);
 await sourceSecurityFrame(observer,app,migrator.user,'RUNTIME');assert.equal(await unchanged(),baseline);
 const liveApp=await connect(connectionFor(runtime,app)),liveMig=await connect(connectionFor(runtime,migrator));
 await liveApp.query('BEGIN');await verifyDatabaseSecurity(liveApp,app,'acme');await verifyFieldModule(liveApp,app,'acme');await liveApp.query('UPDATE public.business_state SET revision=revision');await liveApp.query('ROLLBACK');
 await liveMig.query(`SET ROLE ${q(app.ownerRole)}`);await liveMig.query('RESET ROLE');
 await assert.rejects(backup.query('UPDATE public.business_state SET revision=revision'),e=>e.code==='42501');
 await assert.rejects(backup.query("SELECT nextval('public.audit_ledger_sequence_no_seq')"),e=>e.code==='42501');
 await assert.rejects(backup.query(`SET ROLE ${q(app.ownerRole)}`),e=>e.code==='42501');
 assert.equal(await unchanged(),baseline);
 proof={verifiedAt:new Date().toISOString(),actualOwnedPostgresClusterAndCompiledBusinessAndFieldSchema:true,stagingRequiresOpenTransactionAndBootstrapIdentity:true,exactRuntimePrivilegesReuseExistingCompiledVerifiers:true,actualNewAppAndMigratorLoginsRefusedBeforeCommit:true,existingAppUpdateAndSequenceAndMigratorSetRoleRefusedBeforeCommit:true,observerSeesFrozenRolePolicyUntilCommit:true,explicitRollbackRestoresExactFrozenRolePolicy:true,actualControllerTerminatedBeforeCommitAndBackendClosed:true,controllerTerminationRollsBackStagedCatalog:true,actualCommitSucceededWithoutSuccessAcknowledgement:true,onlyAfterCommitNewAppAndMigratorCanConnect:true,onlyAfterCommitExactRuntimeRolePolicyVisible:true,backupRemainsReadOnlyWithoutOwnerMembership:true,allBusinessFieldTablesAndAuditSequenceUnchanged:true,allOwnedProbeProcessesTerminal:true,realActivationControlFilePublicationTested:false,formalActivationCoordinatorImplemented:false,registrationObservationAndActivationAuditCommitted:false,actualTlsPeerMaterialVerified:false,newFieldCodeDeployed:false,fieldCommissioned:false,productionAcceptance:false};
}finally{
 for(const w of workers){if(!w.terminal)w.child.kill();await w.closed;}
 for(const c of clients)await c.end().catch(()=>{});
 assert.ok(workers.every(w=>w.terminal));
 assert.equal(config.tenants.acme.database,'idms_activationqa_acme_'+suffix);
 await admin.query(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`);await admin.query(`DROP ROLE IF EXISTS ${q(name)}`);
 if(config.businessRoles)await cleanupQaRoles(admin,config);
 assert.equal(await roleImage(),roleBaseline);await admin.end();
 const rel=relative(base,directory);assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&/^activation-security-[a-f0-9]{10}$/.test(basename(directory)));await rm(directory,{recursive:true,force:true});
}
proof.originalRoleCatalogAndOwnedResourcesRestored=true;
await writeFile(resolve(base,'activation-security-verification.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
