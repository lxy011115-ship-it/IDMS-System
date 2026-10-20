import pg from 'pg';
import {dirname} from 'node:path';
import {canonical} from '../server/imports.ts';
import {validateRuntimeConfig} from '../server/postgres-security.ts';
import {fieldRecoveryDatabaseBinding} from '../integrations/field-recovery.ts';
import {FieldRecoveryFiles} from './field-recovery-files.mjs';
import {FieldReviewFiles} from './field-recovery-review-files.mjs';
import {FieldActivationFiles} from './field-activation-files.mjs';
import {sourceMigrationIdentity,sourceSecurityFrame} from './field-source-freeze-security.mjs';
import {authenticateFieldBackup,hashFieldBackupFile,fieldBackupKeyBinding} from './field-backup-archive.mjs';
import {sourceFreezeSha as sha} from './field-source-freeze-policy.mjs';
import {applyFieldFactSession} from './field-fact-session.mjs';
import {readFieldDatabaseContext} from './field-capture-context.mjs';
import {closeSourceConnection} from './field-source-freeze.mjs';
import {readReviewPhase} from './field-recovery-review-record.mjs';
import {readActivationPhase,activationFail as fail} from './field-activation-record.mjs';
const same=(a,b)=>canonical(a)===canonical(b);
export const openCommittedActivationContext=options=>openActivationContext(options,false);
export const openActivationResolutionContext=options=>openActivationContext(options,true);
async function openActivationContext({authority,rawRuntime,tenantId,guard,controlFile,operationId,attemptId,targetRuntime:rawTarget,targetMigration,targetBackup,backupFile,keyFile},resolving){
 const targetRuntime=validateRuntimeConfig(structuredClone(rawTarget)),source=validateRuntimeConfig(structuredClone(rawRuntime)),a=targetRuntime.tenants[tenantId],files=new FieldRecoveryFiles(guard,controlFile);let opened,root,reader;
 try{
  await files.validatePath();await guard.assertHeld();const snapshot=await files[resolving?'readActivationResolutionSnapshot':'readActivatedReceiptSnapshot'](operationId,attemptId),{main,freeze,frozen,archive,state,flow,publication}=snapshot;
  if(!a||!source.tenants[tenantId]||targetRuntime.host!==authority.host||targetRuntime.port!==authority.port||fieldRecoveryDatabaseBinding({host:source.host,port:source.port,database:source.tenants[tenantId].database,user:source.tenants[tenantId].user})!==main.before.identity.databaseBindingSha256)fail('FIELD_ACTIVATION_RECEIPT_CONFIG_INVALID');
  const migrator=sourceMigrationIdentity(targetMigration,targetRuntime,tenantId),b=targetBackup?.tenants?.[tenantId],binding={host:targetRuntime.host,port:targetRuntime.port,database:a.database,user:a.user,ownerRole:a.ownerRole,backupRole:a.backupRole};
  if(!same(binding,freeze.targetBinding)||!same(binding,state.intent.targetBinding)||migrator!==state.intent.migratorRole||targetBackup?.format!==1||targetBackup.purpose!=='BUSINESS_BACKUP'||targetBackup.host!==targetRuntime.host||targetBackup.port!==targetRuntime.port||!b||Object.keys(b).sort().join(',')!=='database,password,user'||b.database!==a.database||b.user!==a.backupRole||sha({runtime:targetRuntime,migration:targetMigration,backup:targetBackup})!==state.intent.targetConfigSha256)fail('FIELD_ACTIVATION_RECEIPT_CONFIG_CHANGED');
  const sourceNames=new Set([...Object.values(source.tenants).flatMap(r=>[r.user,r.ownerRole,r.backupRole]),...Object.values(freeze.roles).map(r=>r.name)]);if([a.user,a.ownerRole,a.backupRole,migrator].some(n=>sourceNames.has(n)))fail('FIELD_ACTIVATION_RECEIPT_SOURCE_ROLE_REUSE');
  const key=await fieldBackupKeyBinding(keyFile),cipher=await hashFieldBackupFile(backupFile);if(key.keyId!==archive.intent.keyId||key.keySha256!==archive.intent.keySha256||cipher.sha256!==archive.ready.archiveSha256||cipher.bytes!==archive.ready.encryptedBytes)fail('FIELD_ACTIVATION_RECEIPT_ARCHIVE_CHANGED');
  opened=await authenticateFieldBackup({backupFile,keyFile,tenantId,workDirectory:dirname(files.controlFile)});const manifest=opened.manifest;
  if(manifest.format!=='idms-field-full-backup-v3'||manifest.backupId!==archive.intent.backupId||manifest.operationId!==operationId||sha(manifest)!==archive.ready.manifestSha256||!same(manifest.dump,archive.ready.dump)||manifest.facts.factsSha256!==archive.intent.factsSha256||sha(manifest.captureContext)!==archive.intent.captureContextSha256||!same(manifest.sourceProof.recoveryIntent,main)||!same(manifest.sourceProof.freezeIntent,freeze)||!same(manifest.sourceProof.freezeResult,frozen)||a.telemetry!==manifest.facts.relations.some(r=>r.schema==='public'&&r.table==='telemetry_points'))fail('FIELD_ACTIVATION_RECEIPT_ARCHIVE_BINDING_CHANGED');
  const connect=async(account,suffix)=>{const p=new pg.Client({host:authority.host,port:authority.port,...account,ssl:false,application_name:'idms-activation-receipt-'+suffix+'-'+attemptId,connectionTimeoutMillis:5000,query_timeout:30000,options:'-c statement_timeout=25000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=60000'});p.on('error',()=>{});try{await p.connect();await applyFieldFactSession(p,manifest.captureContext.session);return p;}catch(e){await closeSourceConnection(p);throw e;}};
  root=await connect({database:a.database,user:'idms_bootstrap',password:authority.bootstrapPassword},'root');reader=await connect(b,'backup');
  if(sha('postgres:'+(await root.query('SELECT system_identifier::text AS system FROM pg_control_system()')).rows[0].system)!==guard.authorityId||!same(await readFieldDatabaseContext(root,a.database),manifest.captureContext.database))fail('FIELD_ACTIVATION_RECEIPT_DATABASE_CHANGED');
  const activation=await readActivationPhase(root,a.database),resolution=activation?'COMMITTED':'ROLLED_BACK';if(!activation&&(!resolving||!same(await readReviewPhase(root,a.database),publication.intent.approvalPhase)))fail('FIELD_ACTIVATION_RESOLUTION_PHASE_UNKNOWN');
  const security=await sourceSecurityFrame(root,a,migrator,activation?'RUNTIME':'FROZEN');if(!same(security.database,state.provision.database)||!same(security.roles,state.roles.roles))fail('FIELD_ACTIVATION_RECEIPT_ROLE_OID_CHANGED');
  const begin=async()=>{await guard.assertHeld();await root.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await root.query('SELECT tenant_id FROM public.business_state WHERE tenant_id=$1 FOR UPDATE',[tenantId]);const snapshot=(await root.query('SELECT pg_export_snapshot() AS value')).rows[0].value;if(!/^[a-fA-F0-9-]{1,64}$/.test(snapshot))fail('FIELD_ACTIVATION_RECEIPT_SNAPSHOT_INVALID');await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await reader.query("SET TRANSACTION SNAPSHOT '"+snapshot+"'");};
  const rollback=async()=>{for(const p of [reader,root])if(['T','E'].includes(p.getTransactionStatus?.()))await p.query('ROLLBACK');};
  return {tenantId,guard,files,main,freeze,archive,state,flow,resolution,intent:state.intent,manifest,opened,account:a,migrator,root,reader,publication,journal:new FieldReviewFiles(guard,files),activationJournal:new FieldActivationFiles(guard,publication),begin,rollback,close:async()=>{await rollback().catch(()=>{});await closeSourceConnection(reader);await closeSourceConnection(root);await opened.dispose();await publication.close();await files.close();}};
 }catch(e){await closeSourceConnection(reader);await closeSourceConnection(root);await opened?.dispose();await files.close();throw e;}
}
