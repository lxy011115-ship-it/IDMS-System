import assert from 'node:assert/strict';
import {readFile,readdir,access,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {seedStore} from '../server/store.ts';
import {emptyImports,canonical} from '../server/imports.ts';
import {roleLayout,migrateTenant,businessRuntime} from './database-migrations.mjs';
import {privateDirectory,privateNewFile,generateKey,databaseFacts,validateBusinessDatabase} from './backup-support.mjs';
import {inspectBusinessMaintenanceBinding,BusinessMaintenanceGate} from './business-maintenance-gate.mjs';
import {captureCoreUpgradeArchives} from './core-upgrade-archives-observed-r5.mjs';
import {reconcilePrivateRestoreTargets} from './reconcile-private-restore-targets-r5.mjs';
import {withRestoreClientR5} from './restore-client-lifecycle-r5.mjs';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,'')),sha=b=>createHash('sha256').update(b).digest('hex');
const nonce=randomUUID().replaceAll('-','').slice(0,12),work=resolve('work/restore-cleanup-r5-qa-20261021',nonce),source='idms_restoreqa_'+nonce,q=n=>{assert.match(n,/^(?:idms_restoreqa_[a-f0-9]{12}(?:_(?:owner|migrator|backup))?|idms_restore_acme_[a-f0-9]{12})$/);return '"'+n+'"';};
await privateDirectory(work);console.log('RESTORE_R5_QA_DIRECTORY '+work);
const names=['scripts/restore-client-lifecycle-r5.mjs','scripts/core-upgrade-archives-observed-r5.mjs','scripts/reconcile-private-restore-targets-r5.mjs','scripts/verify-restore-cleanup-r5.mjs','scripts/backup-support.mjs','scripts/core-upgrade-archives-observed-r4.mjs','scripts/reconcile-private-restore-targets-r4.mjs','scripts/business-maintenance-gate.mjs','scripts/database-migrations.mjs'];
const pins=[];for(const path of names)pins.push({path,sha256:sha(await readFile(path))});await privateNewFile(join(work,'input-source-pins.json'),JSON.stringify(pins,null,2));
const authority=await read('.local/postgres-runtime.json'),adminAccount={host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres',application_name:'idms-restore-r5-qa-'+nonce},admin=new pg.Client(adminAccount),databases=new Map(),roles=new Map(),checks=[],attempts=[];
const config={host:authority.host,port:authority.port,bootstrapPassword:authority.bootstrapPassword,tenants:{acme:{database:source,user:source,password:randomBytes(32).toString('base64url')}},businessRoles:{}};config.businessRoles.acme=roleLayout(config.tenants.acme);
let gate,foreign,report,sourceCreated=false,completed=false;const keyFile=join(work,'archive-key.private.json');
const journal=()=>privateNewFile(join(work,'resource-event-'+randomUUID()+'.json'),JSON.stringify({databases:[...databases],roles:[...roles]},null,2));
const remember=async name=>{const d=(await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[name])).rows[0];if(d){if(databases.has(name))assert.deepEqual(databases.get(name),d);else databases.set(name,d);}const r=(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0];if(r){if(roles.has(name))assert.equal(roles.get(name),r.oid);else roles.set(name,r.oid);}await journal();};
const absent=async p=>{try{await access(p);return false;}catch(e){if(e.code!=='ENOENT')throw e;return true;}};
const noR5Clients=async()=>{let n;for(let i=0;i<50;i++){n=(await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=ANY($1::text[])",[['idms-restore-capture-r5-','idms-restore-check-r5-','idms-restore-reconcile-r5-','idms-restore-recheck-r5-'].map(p=>p+process.pid)])).rows[0].n;if(!n)return;await new Promise(ok=>setTimeout(ok,20));}assert.equal(n,0,'R5 client survived its failed operation');};
const reconcile=async(directory,proofName)=>reconcilePrivateRestoreTargets({directory,authority,bindings:{acme:{account:businessRuntime(config).tenants.acme,expected:gate.bindings.acme.expected}},keyFile,keySha256:sha(await readFile(keyFile)),proofFile:join(directory,proofName)});
await admin.connect();
try{
 assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])',[source,[source,config.businessRoles.acme.owner,config.businessRoles.acme.migrator.user,config.businessRoles.acme.backup.user]])).rowCount,0);
 await admin.query(`CREATE ROLE ${q(source)} LOGIN PASSWORD '${config.tenants.acme.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);await remember(source);await admin.query(`CREATE DATABASE ${q(source)} OWNER ${q(source)} TEMPLATE template0`);sourceCreated=true;await remember(source);
 const s=seedStore(),{audits,idempotency,...business}=s;
 try{await migrateTenant(config,'acme',{version:2,business,audits,idempotency:[...idempotency],imports:emptyImports()});}finally{databases.delete(source);await remember(source);for(const n of [config.businessRoles.acme.owner,config.businessRoles.acme.migrator.user,config.businessRoles.acme.backup.user])await remember(n);}
 const runtime=businessRuntime(config),c=new pg.Client({...adminAccount,database:source});const expected=await withRestoreClientR5(c,async()=>{await c.connect();return inspectBusinessMaintenanceBinding(c,runtime.tenants.acme,'acme');});
 gate=new BusinessMaintenanceGate(config,{acme:{account:runtime.tenants.acme,expected}});await gate.acquire();await gate.probe(true);const originalSummary=gate.summary();await generateKey(keyFile);
 const sourceBefore=new pg.Client({...adminAccount,database:source}),sourceFacts=await withRestoreClientR5(sourceBefore,async()=>{await sourceBefore.connect();return {facts:await databaseFacts(sourceBefore),checks:await validateBusinessDatabase(sourceBefore,'acme')};});
 for(const mode of ['CLEANUP_FAILURE','BODY_AND_CLEANUP_FAILURE']){
  const directory=join(work,mode.toLowerCase());await privateDirectory(directory);let injected=false,target,credentialFile,foreignIdentity,problem;
  const wrapper={summary:()=>gate.summary(),assertHeld:async()=>{await gate.assertHeld();if(injected)return;const files=(await readdir(directory)).filter(n=>/^idms_restore_acme_[a-f0-9]{12}\.private\.json$/.test(n));if(!files.length)return;assert.equal(files.length,1);credentialFile=join(directory,files[0]);target=files[0].slice(0,-'.private.json'.length);await remember(target);foreign=new pg.Client({...adminAccount,database:target,application_name:'idms-r5-qa-foreign-'+nonce});await foreign.connect();foreignIdentity=(await foreign.query('SELECT pg_backend_pid() AS pid,backend_start::text,usesysid::text,usename,backend_type FROM pg_stat_activity WHERE pid=pg_backend_pid()')).rows[0];injected=true;if(mode==='BODY_AND_CLEANUP_FAILURE')throw Error('R5_QA_BODY_FAILURE_AFTER_REAL_RESTORE');}};
  try{await captureCoreUpgradeArchives({phase:'qa',directory,keyFile,config,gate:wrapper});}catch(e){problem=e;}
  assert.ok(injected&&problem);if(mode==='CLEANUP_FAILURE')assert.match(problem.message,/Unexpected principal/);else{assert.ok(problem instanceof AggregateError);assert.equal(problem.errors.length,2);assert.equal(problem.errors[0].message,'R5_QA_BODY_FAILURE_AFTER_REAL_RESTORE');assert.match(problem.errors[1].message,/Unexpected principal/);}
  await noR5Clients();assert.equal((await foreign.query('SELECT 1 AS alive')).rows[0].alive,1);assert.equal(await absent(credentialFile),false);assert.equal(await absent(join(directory,'qa-archives-verification.json')),true);const credentialSha=sha(await readFile(credentialFile)),beforePin=databases.get(target);
  await assert.rejects(reconcile(directory,'must-not-exist.json'),/Unexpected principal/);await noR5Clients();assert.equal((await foreign.query('SELECT 1 AS alive')).rows[0].alive,1);assert.equal(sha(await readFile(credentialFile)),credentialSha);
  checks.push(mode+': real unknown connection refused without termination; capture and reconcile administrators absent; target and credential retained');
  await foreign.end();foreign=undefined;
  if(mode==='CLEANUP_FAILURE'){
   const account=await read(credentialFile),tamper=new pg.Client({host:authority.host,port:authority.port,...account});await withRestoreClientR5(tamper,async()=>{await tamper.connect();await tamper.query('CREATE TABLE r5_qa_fact_mismatch(id integer)');});
   await assert.rejects(reconcile(directory,'mismatch-must-not-exist.json'),e=>e.code==='ERR_ASSERTION');await noR5Clients();assert.equal(sha(await readFile(credentialFile)),credentialSha);
   const repair=new pg.Client({host:authority.host,port:authority.port,...account});await withRestoreClientR5(repair,async()=>{await repair.connect();await repair.query('DROP TABLE r5_qa_fact_mismatch');});
   checks.push('real target facts mismatch refuses reconciliation while both read and administrative clients close and credentials remain');
  }
  const recovered=await reconcile(directory,'authenticated-cleanup.json');assert.equal(recovered.targets.length,1);assert.equal(recovered.targets[0].targetDatabaseOid,beforePin.oid);assert.equal(await absent(credentialFile),true);await noR5Clients();assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$1',[target])).rowCount,0);
  attempts.push({mode,target,databaseOid:beforePin.oid,roleOid:roles.get(target),foreignIdentity,credentialRetainedUntilAuthenticatedCleanup:true,errorNames:problem instanceof AggregateError?problem.errors.map(e=>e.message):[problem.message],r5ClientsActuallyAbsent:true,unknownConnectionNotTerminated:true,authenticatedReconciliationCompleted:true});
 }
 const successDirectory=join(work,'success');await privateDirectory(successDirectory);const successGate={summary:()=>gate.summary(),assertHeld:async()=>{await gate.assertHeld();for(const n of await readdir(successDirectory))if(/^idms_restore_acme_[a-f0-9]{12}\.private\.json$/.test(n))await remember(n.slice(0,-'.private.json'.length));}};
 const success=await captureCoreUpgradeArchives({phase:'qa',directory:successDirectory,keyFile,config,gate:successGate});assert.equal(success.tenants.length,1);assert.ok(success.tenants[0].authenticatedActualIsolatedRestore&&success.tenants[0].nonMvccAuditSequenceEqual);await noR5Clients();
 checks.push('actual successful pg_dump/pg_restore keeps facts business and sequence equal, observes zero target connections and removes owned credentials');
 await gate.assertHeld();assert.deepEqual(gate.summary(),originalSummary);const sourceAfter=new pg.Client({...adminAccount,database:source});const after=await withRestoreClientR5(sourceAfter,async()=>{await sourceAfter.connect();return {facts:await databaseFacts(sourceAfter),checks:await validateBusinessDatabase(sourceAfter,'acme')};});assert.equal(canonical(after),canonical(sourceFacts));
 checks.push('actual QA maintenance gate remains held and the entire source facts and business content remain unchanged through failure and success');
 for(const p of pins)assert.equal(sha(await readFile(p.path)),p.sha256,p.path+' changed during verification');
 report={passed:true,checkedAt:new Date().toISOString(),checks,attempts,sourcePins:pins,actualPgDumpPgRestore:true,syntheticQaSourceOnly:true,originalRuntimeChanged:false,productionAcceptance:false};completed=true;
}catch(e){report={passed:false,error:{name:e.name,message:e.message},checks,attempts,sourcePins:pins};throw e;}
finally{
 await foreign?.end();await gate?.release();
 // Only this exact source and its generated role OIDs are eligible. Failed restore targets remain for explicit reconciliation.
 let sourceRemoved=false,sourceRolesRemoved=0;
 try{if(sourceCreated){const pin=databases.get(source);assert.deepEqual((await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[source])).rows[0],pin);assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[pin.oid])).rows[0].n,0);await admin.query('DROP DATABASE '+q(source));sourceRemoved=true;}for(const name of [config.businessRoles.acme.migrator.user,config.businessRoles.acme.backup.user,config.businessRoles.acme.owner,source]){const oid=roles.get(name);if(!oid)continue;assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0]?.oid,oid);await admin.query('DROP ROLE '+q(name));sourceRolesRemoved++;}
 const targets=(await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'idms_restore_acme_%' AND datname=ANY($1::text[])",[[...databases.keys()].filter(n=>n!==source)])).rows;if(completed){assert.equal(targets.length,0);for(const [name,pin]of databases)assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 OR oid=$2::oid',[name,pin.oid])).rowCount,0);for(const [name,oid]of roles)assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1 OR oid=$2::oid',[name,oid])).rowCount,0);}
 report.cleanup={sourceRemoved,sourceRolesRemoved,databasesRemoved:completed?databases.size:undefined,rolesRemoved:completed?roles.size:undefined,knownTargetDatabaseLeftovers:targets.length,noForceOrBackendTermination:true,encryptedArchivesAndKeyRetained:true};
 await privateNewFile(join(work,'resources.json'),JSON.stringify({nonce,databases:[...databases],roles:[...roles]},null,2));await privateNewFile(join(work,'verification.json'),JSON.stringify(report,null,2));
 }finally{await admin.end();}
 console.log('RESTORE_R5_QA_VERIFICATION '+join(work,'verification.json'));
}
