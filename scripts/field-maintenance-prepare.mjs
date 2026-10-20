import pg from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical} from '../server/imports.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {restoreFieldTarget} from './field-restore-coordinator.mjs';
import {openFieldRestoreContext} from './field-restore-prepare.mjs';
import {readFrozenSourceFacts} from './field-source-freeze-security.mjs';
import {readFieldRestorePhase} from './field-restore-phase.mjs';
import {checkRestoreTarget} from './field-restore-target.mjs';
import {beginRestoreSnapshot,rollbackRestoreSnapshot} from './field-restore-verify.mjs';
import {applyFieldFactSession} from './field-fact-session.mjs';
import {readFieldMaintenanceCatalog} from './field-maintenance-catalog.mjs';
import {maintenanceClient,fieldPublicAuth} from './field-maintenance-reader.mjs';
import {fieldMaintenanceAuth,fieldMaintenanceCapability,fieldMaintenanceReaderConfig,fieldMaintenanceFence,maintenanceFailure,readMaintenanceJson} from './field-maintenance-record.mjs';
import {backupDirectory} from './field-backup-io.mjs';
import {privateDirectory} from './backup-support.mjs';
import {closeSourceConnection} from './field-source-freeze.mjs';
import {recoveryHostId} from './field-recovery-lock.mjs';
import {maintenanceReviewJournal} from './field-maintenance-review-journal.mjs';
const exec=promisify(execFile),fail=code=>{throw maintenanceFailure(code);};
export async function newPrivateJson(path,value){
 const bytes=Buffer.from(canonical(value)),f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
 if(process.platform==='win32')await exec('icacls.exe',[path,'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(F)'],{windowsHide:true,maxBuffer:8192});
 if(sourceFreezeSha(await readMaintenanceJson(path))!==sourceFreezeSha(value))fail('FIELD_MAINTENANCE_PUBLICATION_FAILED');return sourceFreezeSha(value);
}
export async function prepareFieldMaintenance(options){
 const {authority,tenantId,files,guard,authConfig,outputDirectory}=options,auth=fieldMaintenanceAuth(authConfig,true),flowBefore=await files.readRestoreFlow();
 if(!flowBefore.result||!flowBefore.verification||flowBefore.plans.length!==3)fail('FIELD_MAINTENANCE_RESTORE_RESULT_REQUIRED');
 const parent=await backupDirectory(outputDirectory),inside=relative(files.controlFile+'.operations',parent);if(!isAbsolute(inside)&&!inside.startsWith('..'))fail('FIELD_MAINTENANCE_OUTPUT_INVALID');
 if((await maintenanceReviewJournal(files.controlFile,files.currentIntent.operationId)).entries){const {prepareReviewedFieldMaintenance}=await import('./field-maintenance-review-prepare.mjs');return prepareReviewedFieldMaintenance(options,auth,parent);}
 const restored=await restoreFieldTarget(options);if(!restored.alreadyRecorded)fail('FIELD_MAINTENANCE_RESTORE_RESULT_REQUIRED');
 const c=await openFieldRestoreContext(options);let root,reader;
 try{
  const state=await files.readRestoreState(),flow=await files.readRestoreFlow(),sessionId=randomUUID();
  root=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:c.account.database,application_name:'idms-maint-prepare-'+c.intent.operationId,connectionTimeoutMillis:5000,query_timeout:20000});root.on('error',()=>{});
  reader=maintenanceClient({host:c.targetRuntime.host,port:c.targetRuntime.port,...c.backupAccount},sessionId,'prepare');await root.connect();await reader.connect();await applyFieldFactSession(root,c.manifest.captureContext.session);await applyFieldFactSession(reader,c.manifest.captureContext.session);
  await beginRestoreSnapshot(root,reader);if(await checkRestoreTarget(root,c,state)!=='SEALED')fail('FIELD_MAINTENANCE_TARGET_NOT_SEALED');
  const phase=await readFieldRestorePhase(root,c.account.database),facts=await readFrozenSourceFacts(root,c.account,c.migrator,tenantId,{sequenceClient:reader});
  if(phase.stage!=='VERIFIED'||sourceFreezeSha(phase)!==flow.result.phaseSha256||phase.contentSha256!==facts.factsSha256||facts.factsSha256!==flow.result.finalFactsSha256)fail('FIELD_MAINTENANCE_TARGET_CHANGED');
  const catalog=await readFieldMaintenanceCatalog(reader,c.account,Object.values(state.roles.roles).map(r=>r.oid));await c.check();await guard.assertHeld();await rollbackRestoreSnapshot(root,reader);
  const account={host:c.targetRuntime.host,port:c.targetRuntime.port,database:c.account.database,user:c.account.user,ownerRole:c.account.ownerRole,backupRole:c.account.backupRole,migrator:c.migrator,telemetry:!!c.account.telemetry},main=files.currentIntent,createdAt=new Date().toISOString();
  const capability=fieldMaintenanceCapability({format:'idms-field-maintenance-capability-v1',tenantId,sessionId,operationId:c.intent.operationId,backupId:c.manifest.backupId,ownerHostId:recoveryHostId(),createdAt,expiresAt:new Date(Date.parse(createdAt)+1800000).toISOString(),controlFile:files.controlFile,controlSha256:sourceFreezeSha(main.after),operationIntentSha256:files.intentDigest,restoreIntentSha256:sourceFreezeSha(state.intent),rolesSha256:sourceFreezeSha(state.roles),provisionSha256:sourceFreezeSha(state.provision),resultSha256:sourceFreezeSha(flow.result),verificationSha256:sourceFreezeSha(flow.verification),factsSha256:facts.factsSha256,catalogSha256:catalog.sha256,phaseSha256:sourceFreezeSha(phase),captureContext:c.manifest.captureContext,account,auth:fieldPublicAuth(auth)});
  await fieldMaintenanceFence(capability);const directory=resolve(parent,'field-maintenance-'+sessionId);await mkdir(directory,{mode:0o700});await privateDirectory(directory);
  const capabilityFile=resolve(directory,'capability.json'),configFile=resolve(directory,'reader.json'),capabilitySha256=await newPrivateJson(capabilityFile,capability),configuration=fieldMaintenanceReaderConfig({format:1,purpose:'FIELD_RECOVERY_MAINTENANCE_READER',capabilityFile:'capability.json',capabilitySha256,reader:{host:c.targetRuntime.host,port:c.targetRuntime.port,database:c.account.database,user:c.backupAccount.user,password:c.backupAccount.password},auth,authJournalKey:randomBytes(32).toString('base64url')});
  const journal=await open(resolve(directory,'auth-events.jsonl'),'wx',0o600);try{await journal.sync();}finally{await journal.close();}
  const configSha256=await newPrivateJson(configFile,configuration);await fieldMaintenanceFence(capability);await c.check();
  return {format:'idms-field-maintenance-prepared-v1',tenantId,operationId:c.intent.operationId,sessionId,capabilityFile,capabilitySha256,configFile,configSha256,expiresAt:capability.expiresAt,targetDatabase:c.account.database,readOnlyCredentialPurpose:configuration.purpose,fieldEnabled:false,businessWritesEnabled:false,independentApproval:'PENDING',state:'RESTORING',credentialsLogged:false,productionAcceptance:false};
 }finally{for(const p of [reader,root]){if(['T','E'].includes(p?.getTransactionStatus?.()))await p.query('ROLLBACK').catch(()=>{});await closeSourceConnection(p);}await c.opened.dispose();}
}
