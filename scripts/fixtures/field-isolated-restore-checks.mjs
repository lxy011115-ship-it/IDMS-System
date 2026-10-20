import {beforePrepareNegatives,afterPrepareNegatives} from './field-prepare-negative-checks.mjs';
import {writePrivate} from '../keycloak-local.mjs';
import {emptyFieldRestorePhase,nextFieldRestorePhase,fieldRestorePhaseSql,readFieldRestorePhase,classifyFieldRestorePhase} from '../field-restore-phase.mjs';
import {sourceFreezeSha} from '../field-source-freeze-policy.mjs';
import {restoreCommitDropProxy} from './field-restore-commit-proxy.mjs';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {privateDirectory} from '../backup-support.mjs';
import {readFieldDatabaseContext,fieldDatabaseCreateOptions} from '../field-capture-context.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import pg from 'pg';
import {quoteIdentifier as q} from '../../server/postgres-schema.ts';
import {connectionFor} from '../../server/postgres-security.ts';
import {grantPolicy} from '../database-migrations.mjs';
import {grantRestoredFieldPolicy,readUnreboundRestoredFacts,assertRawRestoredFacts,rebindRestoredMigrationRoles} from '../field-restore-security.mjs';
import {applySourceFrozenPrivileges,sourceSecurityFrame,readFrozenSourceFacts} from '../field-source-freeze-security.mjs';
import {closeSourceConnection} from '../field-source-freeze.mjs';
import {authenticateFieldBackup} from '../field-backup-archive.mjs';
import {captureFieldFactSession,applyFieldFactSession} from '../field-fact-session.mjs';
import {canonical} from '../../server/imports.ts';
const exec=promisify(execFile);

// Actual data/metadata experiment used by the production restore implementation.
// This helper alone is not a recoverable operator command.
export async function exerciseRawIsolatedRestore({authority,runtime,directory,keyFile,backupFile,cli}){
 if(!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory))||!/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/.test(runtime.tenants.acme.database))throw Error('Owned isolated restore QA required');
 const target=JSON.parse(await readFile(resolve(directory,'target.json'))),a=target.tenants.acme,migrator=a.database+'_migrator',backup={user:a.backupRole,database:a.database,password:randomBytes(32).toString('base64url')},migration={user:migrator,database:a.database,password:randomBytes(32).toString('base64url')},admin=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres'}),createdRoles=[];
 let createdDb=false,db,reader,opened,sourceRenamed=false;const connections=[];let phaseBeforeDataRollbackVerified=false,realCommitReplyDropRecovered=false,prepareNegatives=null;
 const connect=async options=>{const c=new pg.Client(options);c.on('error',()=>{});connections.push(c);await c.connect();return c;};
 try{
  opened=await authenticateFieldBackup({backupFile,keyFile,tenantId:'acme',workDirectory:directory});const manifest=opened.manifest;assert.equal(manifest.format,'idms-field-full-backup-v3');await admin.connect();
  const settings=manifest.captureContext.session,databaseContext=manifest.captureContext.database;
  const targetMigration={format:1,purpose:'BUSINESS_MIGRATION',host:target.host,port:target.port,tenants:{acme:{...migration,ownerRole:a.ownerRole}}},targetBackup={format:1,purpose:'BUSINESS_BACKUP',host:target.host,port:target.port,tenants:{acme:backup}},migrationFile=resolve(directory,'target-migration.json'),backupFileConfig=resolve(directory,'target-backup.json');
  await writePrivate(migrationFile,JSON.stringify(targetMigration));await writePrivate(backupFileConfig,JSON.stringify(targetBackup));
  const sourceName=runtime.tenants.acme.database;assert.match(sourceName,/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/);await admin.query(`ALTER DATABASE ${q(sourceName)} RENAME TO ${q(sourceName+'_offline')}`);sourceRenamed=true;
  const prepareArgs={'--operation-id':manifest.operationId,'--target-runtime-config':resolve(directory,'target.json'),'--target-migration-config':migrationFile,'--target-backup-config':backupFileConfig,'--backup-file':backupFile,'--key-file':keyFile};
  if(!process.env.IDMS_FIELD_PREPARE_QA_FAULT&&!process.env.IDMS_FIELD_RESTORE_QA_FAULT&&!process.env.IDMS_FIELD_ARCHIVE_EXPORT_QA_MODE&&process.env.IDMS_FIELD_REVIEW_QA!=='1')prepareNegatives=await beforePrepareNegatives({admin,directory,target:a,args:prepareArgs,cli});
  let provision;try{provision=await cli('prepare-target',prepareArgs);if(prepareNegatives)prepareNegatives={...prepareNegatives,...await afterPrepareNegatives({admin,directory,target:a,args:prepareArgs,cli})};}finally{const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[a.database])).rowCount;if(exists)createdDb=true;for(const name of [a.ownerRole,a.user,a.backupRole,migrator])if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount)createdRoles.push(name);}
  assert.equal(provision.targetAllOrdinaryRolesNoLogin,true);assert.equal(provision.targetEmptyVerified,true);assert.equal(provision.sourceDatabaseConnectionNotRequired,true);assert.equal(provision.targetDataRestored,false);
  const repeated=await cli('prepare-target',prepareArgs);assert.equal(repeated.alreadyRecorded,true);assert.equal(repeated.restoreIntentSha256,provision.restoreIntentSha256);assert.equal(canonical(repeated.database),canonical(provision.database));assert.equal(canonical(repeated.roles),canonical(provision.roles));
  if(process.env.IDMS_FIELD_RESTORE_COMMAND_QA==='1'){const {exerciseRestoreTargetCommand}=await import('./field-restore-command-checks.mjs');return await exerciseRestoreTargetCommand({authority,target:a,migration,sourceName,manifest,args:prepareArgs,cli});}
  db=await connect({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:a.database});assert.equal(canonical(await readFieldDatabaseContext(db,a.database)),canonical(databaseContext));
  const executable=resolve(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin/pg_restore.exe'),toc=await exec(executable,['--list',opened.dumpFile],{windowsHide:true,maxBuffer:1048576});
  const publicCreatedByDump=/\bSCHEMA - public\s/.test(toc.stdout);
  const targetOid=(await db.query('SELECT oid::text FROM pg_database WHERE datname=current_database()')).rows[0].oid;
  let phase=await readFieldRestorePhase(db,a.database);assert.equal(phase.restoreIntentSha256,provision.restoreIntentSha256);assert.equal(phase.stage,'EMPTY');assert.equal(phase.databaseOid,targetOid);await privateDirectory(directory);
  // Only this owned experiment enables the stage writer. The production
  // prepare-target action itself leaves all four ordinary roles NOLOGIN.
  await db.query(`GRANT ${q(a.ownerRole)} TO ${q(migrator)} WITH INHERIT FALSE,SET TRUE,ADMIN FALSE;ALTER ROLE ${q(migrator)} LOGIN;GRANT CONNECT ON DATABASE ${q(a.database)} TO ${q(migrator)}`);


  const env={...process.env,PGHOST:authority.host,PGPORT:String(authority.port),PGUSER:migrator,PGPASSWORD:migration.password,PGDATABASE:a.database,PGCONNECT_TIMEOUT:'5'};
  for(const section of ['pre-data','data','post-data']){
   const stem=resolve(directory,'section-'+section+'-'+randomUUID()),sql=stem+'.sql',prefix=stem+'.prefix.sql',marker=stem+'.marker.sql',fault=stem+'.fault.sql';
   await exec(executable,['--no-owner','--no-acl','--no-password','--role='+a.ownerRole,'--section='+section,'--file='+sql,opened.dumpFile],{windowsHide:true,maxBuffer:1048576});
   const next=nextFieldRestorePhase(phase,section,sourceFreezeSha(await readFile(sql)));await writeFile(prefix,'SET LOCAL ROLE '+q(a.ownerRole)+';\n'+(section==='pre-data'&&publicCreatedByDump?'DROP SCHEMA public;\n':''),{flag:'wx',mode:0o600});await writeFile(marker,fieldRestorePhaseSql(next,a.ownerRole),{flag:'wx',mode:0o600});
   const psql=resolve(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin/psql.exe'),args=['--no-psqlrc','--no-password','--quiet','--single-transaction','--set=ON_ERROR_STOP=1','--file='+prefix,'--file='+sql];
   if(section==='data'){
    await writeFile(fault,'SELECT owned_qa_restore_forced_rollback;\n',{flag:'wx',mode:0o600});await assert.rejects(exec(psql,[...args,'--file='+fault,'--file='+marker],{windowsHide:true,env,maxBuffer:1048576}));
    assert.equal(classifyFieldRestorePhase(await readFieldRestorePhase(db,a.database),phase,next),'PENDING');assert.equal((await db.query('SELECT count(*)::int AS n FROM public.business_state')).rows[0].n,0);phaseBeforeDataRollbackVerified=true;
    const applicationName='idms-field-restore-qa-'+randomUUID(),proxy=await restoreCommitDropProxy({host:authority.host,port:authority.port,user:migrator,database:a.database,applicationName});
    try{await assert.rejects(exec(psql,[...args,'--file='+marker],{windowsHide:true,env:{...env,PGHOST:'127.0.0.1',PGPORT:String(proxy.port),PGAPPNAME:applicationName,PGSSLMODE:'disable',PGGSSENCMODE:'disable'},maxBuffer:1048576}));assert.equal(proxy.dropped,true);assert.equal(proxy.startupMatched,true);}finally{await proxy.dispose();}
    assert.equal(classifyFieldRestorePhase(await readFieldRestorePhase(db,a.database),phase,next),'COMMITTED');realCommitReplyDropRecovered=true;
   }else await exec(psql,[...args,'--file='+marker],{windowsHide:true,env,maxBuffer:1048576});
   assert.equal(classifyFieldRestorePhase(await readFieldRestorePhase(db,a.database),phase,next),'COMMITTED');phase=next;
  }

  await db.query('BEGIN');try{await db.query(`ALTER SCHEMA public OWNER TO ${q(a.ownerRole)};SET LOCAL ROLE ${q(a.ownerRole)}`);await grantPolicy(db,a);await grantRestoredFieldPolicy(db,a);await db.query('RESET ROLE');await db.query(`ALTER ROLE ${q(a.backupRole)} LOGIN`);await applySourceFrozenPrivileges(db,a,migrator);await sourceSecurityFrame(db,a,migrator,'FROZEN');await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
  reader=await connect(connectionFor(target,backup));await applyFieldFactSession(db,settings);await applyFieldFactSession(reader,settings);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const snapshot=(await db.query('SELECT pg_export_snapshot() AS value')).rows[0].value;assert.match(snapshot,/^[A-Fa-f0-9-]{1,64}$/);await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+snapshot+"'");
  const sourceAccount={database:manifest.facts.sourceDatabase,...manifest.facts.sourceRoles,user:manifest.facts.sourceRoles.app,ownerRole:manifest.facts.sourceRoles.owner,backupRole:manifest.facts.sourceRoles.backup,telemetry:a.telemetry};
  const before=(await db.query('SELECT * FROM public.idms_schema_migrations ORDER BY version')).rows;
  const originalMigrationTrigger=(await db.query("SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid='idms_field.migrations'::regclass AND tgname='immutable_field_data'")).rows[0].enabled;
  const raw=await readUnreboundRestoredFacts(db,a,migrator,sourceAccount,'acme',{sequenceClient:reader});assertRawRestoredFacts(raw,manifest.facts,a);assert.equal(canonical((await db.query('SELECT * FROM public.idms_schema_migrations ORDER BY version')).rows),canonical(before));await reader.query('ROLLBACK');await db.query('ROLLBACK');
  const wrongSettings={...settings,TimeZone:settings.TimeZone==='Asia/Shanghai'?'UTC':'Asia/Shanghai'};await applyFieldFactSession(db,wrongSettings);await applyFieldFactSession(reader,wrongSettings);
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const wrongSnapshot=(await db.query('SELECT pg_export_snapshot() AS value')).rows[0].value;assert.match(wrongSnapshot,/^[A-Fa-f0-9-]{1,64}$/);await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+wrongSnapshot+"'");
  const wrongFacts=await readUnreboundRestoredFacts(db,a,migrator,sourceAccount,'acme',{sequenceClient:reader});assert.throws(()=>assertRawRestoredFacts(wrongFacts,manifest.facts,a),e=>e.code==='FIELD_RESTORE_RAW_FACTS_MISMATCH');await reader.query('ROLLBACK');await db.query('ROLLBACK');await applyFieldFactSession(db,settings);await applyFieldFactSession(reader,settings);
  await db.query('BEGIN');try{await db.query(`SET LOCAL ROLE ${q(a.ownerRole)}`);await rebindRestoredMigrationRoles(db,sourceAccount,a,'acme');await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
  await db.query('RESET ROLE;BEGIN ISOLATION LEVEL REPEATABLE READ');const afterSnapshot=(await db.query('SELECT pg_export_snapshot() AS value')).rows[0].value;assert.match(afterSnapshot,/^[A-Fa-f0-9-]{1,64}$/);await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+afterSnapshot+"'");
  const rebound=await readFrozenSourceFacts(db,a,migrator,'acme',{sequenceClient:reader});for(const r of raw.relations)if(!(r.schema==='public'&&r.table==='idms_schema_migrations'||r.schema==='idms_field'&&r.table==='migrations'))assert.equal(canonical(rebound.relations.find(t=>t.schema===r.schema&&t.table===r.table)),canonical(r));assert.equal(canonical(rebound.root),canonical(raw.root));assert.equal(canonical(rebound.sequences),canonical(raw.sequences));await reader.query('ROLLBACK');await db.query('ROLLBACK');
  assert.equal((await db.query("SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid='idms_field.migrations'::regclass AND tgname='immutable_field_data'")).rows[0].enabled,originalMigrationTrigger);
  for(const account of [a,migration]){const refused=new pg.Client(connectionFor(target,account));refused.on('error',()=>{});try{await assert.rejects(refused.connect(),e=>e.code==='28000');}finally{await closeSourceConnection(refused);}}
  return {prepareNegatives,actualAuthenticatedPrepareTargetCli:true,sourceDatabaseUnavailableByOwnedRenameDuringProvisionAndRestore:true,idempotentPreparePreservesRoleAndDatabaseOids:true,actualPreDataDataPostDataRestoredByMinimumMigrationIdentity:true,psqlSingleTransactionSectionAndDatabasePhaseMarker:true,phaseBeforeDataRollbackVerified,realCommitReplyDropRecovered,sequencesNotClaimedTransactionalAfterAbortedDataPhase:true,actualNonemptyPoints:raw.relations.find(t=>t.schema==='idms_field'&&t.table==='points').rows,actualNonemptyReceipts:raw.relations.find(t=>t.schema==='idms_field'&&t.table==='receipts').rows,all35RelationsRootAuditImportsDefinitionsAndSequencesMatchBeforeRebind:true,metadataValidationProjectionRolledBack:true,onlyTwoMigrationTablesChangedAfterControlledRebind:true,migrationTriggerModeBeforeRebind:originalMigrationTrigger,migrationTriggerModePreserved:true,actualAppAndMigratorLoginRefused:true,actualReadonlyBackupLoginWorks:true,authenticatedV3DatabaseLocaleAndSessionApplied:true,actualNonUtcFactsNeedOriginalSessionAndWrongSessionRefused:true,explicitSourceFactSessionSettingsApplied:true,publicCreatedByDump,protocolFixtureOnly:true,recoverableRestoreOperatorCommandImplemented:false,restoreApprovalOrActivationPerformed:false};
 }finally{await opened?.dispose();for(const c of connections)await closeSourceConnection(c);if(createdDb)await admin.query(`DROP DATABASE ${q(a.database)}`);for(const name of createdRoles.reverse())await admin.query(`DROP ROLE ${q(name)}`);if(sourceRenamed)await admin.query(`ALTER DATABASE ${q(runtime.tenants.acme.database+'_offline')} RENAME TO ${q(runtime.tenants.acme.database)}`);await closeSourceConnection(admin);}
}
