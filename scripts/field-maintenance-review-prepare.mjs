import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {privateDirectory} from './backup-support.mjs';
import {openReviewContext} from './field-recovery-review-context.mjs';
import {readCurrentRecoveryReview} from './field-recovery-review.mjs';
import {readFieldMaintenanceCatalog} from './field-maintenance-catalog.mjs';
import {fieldPublicAuth} from './field-maintenance-reader.mjs';
import {fieldMaintenanceCapability,fieldMaintenanceReaderConfig,fieldMaintenanceFence,maintenanceFailure} from './field-maintenance-record.mjs';
import {maintenanceReviewJournal} from './field-maintenance-review-journal.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {recoveryHostId} from './field-recovery-lock.mjs';
import {newPrivateJson} from './field-maintenance-prepare.mjs';
export async function prepareReviewedFieldMaintenance(options,auth,parent){
 const c=await openReviewContext(options);
 try{
  const before=await maintenanceReviewJournal(c.files.controlFile,c.intent.operationId),image=await readCurrentRecoveryReview(c),catalog=await readFieldMaintenanceCatalog(c.reader,c.account,Object.values(c.state.roles.roles).map(r=>r.oid));
  const after=await maintenanceReviewJournal(c.files.controlFile,c.intent.operationId);if(before.sha256!==after.sha256)throw maintenanceFailure('FIELD_MAINTENANCE_REVIEW_JOURNAL_CHANGED');await c.check();await c.guard.assertHeld();await c.rollback();
  const sessionId=randomUUID(),createdAt=new Date().toISOString(),account={host:c.targetRuntime.host,port:c.targetRuntime.port,database:c.account.database,user:c.account.user,ownerRole:c.account.ownerRole,backupRole:c.account.backupRole,migrator:c.migrator,telemetry:!!c.account.telemetry};
  const capability=fieldMaintenanceCapability({format:'idms-field-maintenance-capability-v2',tenantId:c.tenantId,sessionId,operationId:c.intent.operationId,backupId:c.manifest.backupId,ownerHostId:recoveryHostId(),createdAt,expiresAt:new Date(Date.parse(createdAt)+1800000).toISOString(),controlFile:c.files.controlFile,controlSha256:sourceFreezeSha(c.main.after),operationIntentSha256:c.files.intentDigest,restoreIntentSha256:sourceFreezeSha(c.state.intent),rolesSha256:sourceFreezeSha(c.state.roles),provisionSha256:sourceFreezeSha(c.state.provision),resultSha256:sourceFreezeSha(c.flow.result),verificationSha256:sourceFreezeSha(c.flow.verification),factsSha256:image.facts.factsSha256,catalogSha256:catalog.sha256,phaseSha256:sourceFreezeSha(image.phase),captureContext:c.manifest.captureContext,account,auth:fieldPublicAuth(auth),review:{phase:image.phase,journalSha256:after.sha256}});
  await fieldMaintenanceFence(capability);const directory=resolve(parent,'field-maintenance-'+sessionId);await mkdir(directory,{mode:0o700});await privateDirectory(directory);
  const capabilityFile=resolve(directory,'capability.json'),configFile=resolve(directory,'reader.json'),capabilitySha256=await newPrivateJson(capabilityFile,capability),configuration=fieldMaintenanceReaderConfig({format:1,purpose:'FIELD_RECOVERY_MAINTENANCE_READER',capabilityFile:'capability.json',capabilitySha256,reader:{host:account.host,port:account.port,database:account.database,user:c.backupAccount.user,password:c.backupAccount.password},auth,authJournalKey:randomBytes(32).toString('base64url')});
  const journal=await open(resolve(directory,'auth-events.jsonl'),'wx',0o600);try{await journal.sync();}finally{await journal.close();}
  const configSha256=await newPrivateJson(configFile,configuration);await fieldMaintenanceFence(capability);await c.check();
  return {format:'idms-field-maintenance-prepared-v2',tenantId:c.tenantId,operationId:c.intent.operationId,sessionId,capabilityFile,capabilitySha256,configFile,configSha256,expiresAt:capability.expiresAt,targetDatabase:account.database,readOnlyCredentialPurpose:configuration.purpose,reviewStage:image.phase.stage,independentApproval:image.phase.stage==='APPROVED'?'RECORDED':'PENDING',fieldEnabled:false,businessWritesEnabled:false,state:'RESTORING',credentialsLogged:false,productionAcceptance:false};
 }finally{await c.close();}
}
