import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {canonical} from '../server/imports.ts';
import {validateRuntimeConfig} from '../server/postgres-security.ts';
import {sourceMigrationIdentity} from './field-source-freeze-security.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {fieldRestoreIntent} from './field-restore-record.mjs';
import {authenticateFieldBackup,hashFieldBackupFile,fieldBackupKeyBinding} from './field-backup-archive.mjs';
import {provisionFieldRestoreTarget} from './field-restore-provision.mjs';
import {closeSourceConnection} from './field-source-freeze.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});},same=(a,b)=>canonical(a)===canonical(b);
export async function openFieldRestoreContext({authority,rawRuntime,tenantId,guard,files,targetRuntime:rawTarget,targetMigration,targetBackup,backupFile,keyFile}){
 const targetRuntime=validateRuntimeConfig(structuredClone(rawTarget)),a=targetRuntime.tenants[tenantId],source=rawRuntime.tenants[tenantId],main=await files.assertRestoring(),freeze=await files.readSourceFreezeIntent(),frozen=await files.readSourceFreezeResult(),archive=await files.readArchiveState();
 if(!a||!source||!freeze||!frozen||!archive.intent||!archive.ready||!archive.result||targetRuntime.host!==authority.host||targetRuntime.port!==authority.port)fail('FIELD_RESTORE_CONTEXT_REQUIRED');
 const migrator=sourceMigrationIdentity(targetMigration,targetRuntime,tenantId),m=targetMigration.tenants[tenantId],b=targetBackup?.tenants?.[tenantId],binding={host:targetRuntime.host,port:targetRuntime.port,database:a.database,user:a.user,ownerRole:a.ownerRole,backupRole:a.backupRole};
 if(!same(binding,freeze.targetBinding)||targetBackup?.format!==1||targetBackup.purpose!=='BUSINESS_BACKUP'||targetBackup.host!==targetRuntime.host||targetBackup.port!==targetRuntime.port||!b||Object.keys(b).sort().join(',')!=='database,password,user'||b.database!==a.database||b.user!==a.backupRole)fail('FIELD_RESTORE_TARGET_CONFIG_INVALID');
 const roleNames=[a.user,a.ownerRole,a.backupRole,migrator],sourceNames=new Set([...Object.values(rawRuntime.tenants).flatMap(r=>[r.user,r.ownerRole,r.backupRole]),...Object.values(freeze.roles).map(r=>r.name)]);
 if(new Set(roleNames).size!==4||roleNames.some(n=>sourceNames.has(n)))fail('FIELD_RESTORE_SOURCE_ROLE_REUSE');
 const secrets=[a.password,m.password,b.password];if(secrets.some(s=>typeof s!=='string'||Buffer.byteLength(s)<32||Buffer.byteLength(s)>1024||s.includes('\0')||s===authority.bootstrapPassword||Object.values(rawRuntime.tenants).some(r=>r.password===s))||new Set(secrets).size!==3)fail('FIELD_RESTORE_CREDENTIAL_INVALID');
 const check=async()=>{await guard.assertHeld();await files.assertRestoring();};await check();
 const key=await fieldBackupKeyBinding(keyFile);if(key.keyId!==archive.intent.keyId||key.keySha256!==archive.intent.keySha256)fail('FIELD_RESTORE_ARCHIVE_KEY_CHANGED');
 const cipher=await hashFieldBackupFile(backupFile);if(cipher.sha256!==archive.ready.archiveSha256||cipher.bytes!==archive.ready.encryptedBytes)fail('FIELD_RESTORE_ARCHIVE_CHANGED');
 let handedOff=false;const opened=await authenticateFieldBackup({backupFile,keyFile,tenantId,workDirectory:dirname(files.controlFile)});
 try{
  const manifest=opened.manifest;
  if(manifest.format!=='idms-field-full-backup-v3')fail('FIELD_RESTORE_LEGACY_CAPTURE_CONTEXT_REQUIRED');
  if(manifest.backupId!==archive.intent.backupId||manifest.operationId!==main.operationId||sourceFreezeSha(manifest)!==archive.ready.manifestSha256||!same(manifest.dump,archive.ready.dump)||manifest.facts.factsSha256!==archive.intent.factsSha256||sourceFreezeSha(manifest.captureContext)!==archive.intent.captureContextSha256||!same(manifest.sourceProof.recoveryIntent,main)||!same(manifest.sourceProof.freezeIntent,freeze)||!same(manifest.sourceProof.freezeResult,frozen)||a.telemetry!==manifest.facts.relations.some(r=>r.schema==='public'&&r.table==='telemetry_points'))fail('FIELD_RESTORE_ARCHIVE_BINDING_INVALID');
  await check();let state=await files.readRestoreState();
  const configSha256=sourceFreezeSha({runtime:targetRuntime,migration:targetMigration,backup:targetBackup});
  if(state.intent&&(state.intent.targetConfigSha256!==configSha256||state.intent.archiveSha256!==cipher.sha256||state.intent.captureContextSha256!==sourceFreezeSha(manifest.captureContext)))fail('FIELD_RESTORE_CONFIG_CHANGED');
  if(!state.intent){
   const inspect=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres',application_name:'idms-restore-preflight-'+main.operationId,connectionTimeoutMillis:5000});inspect.on('error',()=>{});
   try{await inspect.connect();if(sourceFreezeSha('postgres:'+(await inspect.query('SELECT system_identifier::text AS system FROM pg_control_system()')).rows[0].system)!==guard.authorityId)fail('FIELD_RESTORE_AUTHORITY_CHANGED');if((await inspect.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[])',[a.database,roleNames])).rowCount)fail('FIELD_RESTORE_TARGET_ALREADY_EXISTS');await check();}finally{await closeSourceConnection(inspect);}
   await files.prepareRestoreIntent(fieldRestoreIntent({format:'idms-field-target-restore-intent-v1',operationId:main.operationId,backupId:manifest.backupId,archiveIntentSha256:sourceFreezeSha(archive.intent),archiveResultSha256:sourceFreezeSha(archive.result),archiveSha256:cipher.sha256,manifestSha256:archive.ready.manifestSha256,sourceFactsSha256:manifest.facts.factsSha256,captureContextSha256:sourceFreezeSha(manifest.captureContext),targetBinding:binding,migratorRole:migrator,targetConfigSha256:configSha256,provisionNonce:randomUUID(),createdAt:new Date().toISOString()}));state=await files.readRestoreState();
  }
  handedOff=true;return {opened,manifest,main,freeze,archive,intent:state.intent,state,targetRuntime,targetMigration,targetBackup,account:a,sourceAccount:{database:manifest.facts.sourceDatabase,user:manifest.facts.sourceRoles.app,ownerRole:manifest.facts.sourceRoles.owner,backupRole:manifest.facts.sourceRoles.backup,telemetry:a.telemetry},migrationAccount:m,backupAccount:b,migrator,check};
 }finally{if(!handedOff)await opened.dispose();}
}

export async function prepareFieldRestoreTarget(options){
 const c=await openFieldRestoreContext(options);
 try{
  const {authority,tenantId,guard,files}=options;
  const provision=await provisionFieldRestoreTarget({authority,rawIntent:c.intent,targetRuntime:c.targetRuntime,targetMigration:c.targetMigration,targetBackup:c.targetBackup,captureContext:c.manifest.captureContext,guard,files});await c.check();
  return {format:'idms-field-target-restore-prepared-v1',tenantId,operationId:c.main.operationId,backupId:c.manifest.backupId,restoreIntentSha256:sourceFreezeSha(c.intent),database:provision.database,roles:provision.roles,phase:provision.phase,alreadyRecorded:provision.alreadyRecorded,targetAllOrdinaryRolesNoLogin:provision.targetAllOrdinaryRolesNoLogin,targetEmptyVerified:provision.targetEmptyVerified,fullArchiveAuthenticationVerified:true,targetDataRestored:false,state:'RESTORING',sourceDatabaseConnectionNotRequired:true,independentActivationApprovalRequired:true,credentialsLogged:false,productionAcceptance:false};
 }finally{await c.opened.dispose();}
}
