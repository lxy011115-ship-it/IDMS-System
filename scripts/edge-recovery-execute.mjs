import {readFile,lstat} from 'node:fs/promises';
import {existsSync,readFileSync,lstatSync,realpathSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {canonicalEqual} from '../server/canonical-state.ts';
import {recoverStoppedSpool,verifyStoppedSpoolRecovery} from '../services/edge/spool-maintenance.ts';
import {openExistingSqlite} from '../services/existing-sqlite.ts';
import {spoolVersion} from '../services/edge/spool-v2.ts';
import {legacyRecoveryAuthority} from './edge-recovery-platform.mjs';
import {deploymentEvidence,sameDeploymentStructure} from './existing-platform-evidence.mjs';
import {bindingFile,verifyPin,runtimeSourceEvidence,jsonFile} from './existing-platform-binding.mjs';
import {recoveredRuntimeBinding,validateRecoveryBinding,replaceRecoveryBinding} from './edge-recovery-binding.mjs';
import {verifyRecoveryQualification} from './edge-recovery-qualification.mjs';
import {recoveryNeed as need,recoveryPin,recoveryWrite,sourceSummary} from './edge-recovery-operation.mjs';
const present=async path=>{try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export function sameRecoveryDatabaseState(a,b){return sameDeploymentStructure(a,b)&&Object.keys(a.databases).every(name=>canonicalEqual(a.databases[name].businessRevisions,b.databases[name]?.businessRevisions));}
function checkpointWriter(context){return event=>{
 const {directory,plan}=context,stage=event.stage,attempt=event.attempt||0;need(['BACKUP_RESERVED','BACKUP_VERIFIED','RESTORE_RESERVED','RESTORE_VERIFIED','SQLITE_COMMITTED'].includes(stage),'RECOVERY_CHECKPOINT_STAGE_INVALID');
 const expected=stage==='SQLITE_COMMITTED'?plan.proposal.path:join(directory,'edge-'+plan.operationId+(attempt===1?'':'.attempt-'+attempt)+'.'+(stage.startsWith('BACKUP')?'backup':'restore-check')+'.sqlite');need(event.path===expected&&(stage==='SQLITE_COMMITTED'||[1,2,3].includes(attempt)),'RECOVERY_CHECKPOINT_PATH_INVALID');
 const value={format:'IDMS_EDGE_RECOVERY_CHECKPOINT_V1',operationId:plan.operationId,event:JSON.parse(JSON.stringify(event))},file=join(directory,'checkpoint-'+stage+'-'+attempt+'.private.json');
 if(existsSync(file)){const s=lstatSync(file);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=8192&&realpathSync(file)===file,'RECOVERY_CHECKPOINT_FILE_INVALID');need(canonicalEqual(JSON.parse(readFileSync(file,'utf8')),value),'RECOVERY_CHECKPOINT_CHANGED');return;}
 const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
};}
async function backupPins(context,receipt){const pins=[];for(const stage of ['BACKUP_VERIFIED','RESTORE_VERIFIED']){
 const candidates=[];for(let attempt=1;attempt<=3;attempt++){const file=join(context.directory,'checkpoint-'+stage+'-'+attempt+'.private.json');if(await present(file)){const record=await jsonFile(file,8192),e=record.event,kind=stage==='BACKUP_VERIFIED'?'backup':'restore-check',expected=join(context.directory,'edge-'+context.plan.operationId+(attempt===1?'':'.attempt-'+attempt)+'.'+kind+'.sqlite');need(record.operationId===context.plan.operationId&&e.stage===stage&&e.attempt===attempt&&e.path===expected,'RECOVERY_BACKUP_CHECKPOINT_INVALID');const pin=await recoveryPin(expected,256*1024**2);need(pin.sha256===e.digest,'RECOVERY_BACKUP_CHANGED');candidates.push(pin);}}
 need(candidates.length===1,'RECOVERY_BACKUP_PROOF_REQUIRED');pins.push(candidates[0]);
 }need(pins[0].sha256===receipt.backupDigest,'RECOVERY_BACKUP_RECEIPT_MISMATCH');return pins;}
/** Caller holds the deployment coordinator for this original operation. No
 * process starts here; the return value does not mean readiness or activation. */
export async function executeRecovery(context,p,{assertStopped,qualificationVerifier=verifyRecoveryQualification,authorityReader=legacyRecoveryAuthority,structureReader=deploymentEvidence,sourceReader=runtimeSourceEvidence,bindingPath=bindingFile,onPhase=()=>{}}={}){
 need(typeof assertStopped==='function','RECOVERY_EXECUTION_STOP_PROOF_REQUIRED');await assertStopped();const qualified=await qualificationVerifier(context),intentFile=join(context.directory,'execution.intent.private.json');
 if(!await present(intentFile)){const db=openExistingSqlite(p.spool,'edge',p.source,{readOnly:true});try{need(spoolVersion(db)===0,'RECOVERY_MIGRATION_WITHOUT_EXECUTION_INTENT');}finally{db.close();}}
 await recoveryWrite(intentFile,{format:'IDMS_EDGE_RECOVERY_EXECUTION_V1',operationId:context.plan.operationId,plan:context.planPin,qualification:qualified.pin,originalBinding:context.beforePin,source:context.source,release:qualified.release});
 const check=async()=>{await assertStopped();need(canonicalEqual(sourceSummary(await sourceReader()),context.source),'RECOVERY_EXECUTION_SOURCE_CHANGED');};await check();
 const before=await structureReader(p.binding),authorityBefore=await authorityReader(p);need(sameRecoveryDatabaseState(context.plan.before,before)&&authorityBefore.digest===context.plan.authority.digest,'RECOVERY_EXECUTION_AUTHORITY_CHANGED');
 const checkpoint=checkpointWriter(context);const result=await recoverStoppedSpool(p.spool,p.source,context.plan.proposal,{directory:context.directory,assertStopped:check,onCheckpoint:checkpoint});
 checkpoint({stage:'SQLITE_COMMITTED',path:p.spool});onPhase('SQLITE_COMMITTED');const receipt=verifyStoppedSpoolRecovery(p.spool,p.source,context.plan.proposal),backups=await backupPins(context,receipt);await check();
 const after=await structureReader(p.binding),authorityAfter=await authorityReader(p);need(sameRecoveryDatabaseState(before,after)&&authorityAfter.digest===context.plan.authority.digest,'RECOVERY_POST_MIGRATION_AUTHORITY_CHANGED');
 const completionFile=join(context.directory,'completion.private.json');let completion;
 if(await present(completionFile)){
  completion=await jsonFile(completionFile,262144);need(canonicalEqual(completion.plan,context.planPin)&&canonicalEqual(completion.qualification,qualified.pin)&&canonicalEqual(completion.release,qualified.release)&&sameRecoveryDatabaseState(context.plan.before,completion.before)&&sameRecoveryDatabaseState(after,completion.after),'RECOVERY_COMPLETION_CONTEXT_CHANGED');
 }else{
  completion={format:'IDMS_EDGE_RECOVERY_COMPLETE_V2',operationId:context.plan.operationId,originalBindingSha256:context.beforePin.sha256,source:context.source,spoolIdentity:{path:p.spool,device:context.plan.proposal.device,inode:context.plan.proposal.inode},receipt,backups,structureAndPrivilegesUnchanged:true,plan:context.planPin,qualification:qualified.pin,release:qualified.release,before,after};await recoveryWrite(completionFile,completion);
 }
 const completionPin=await recoveryPin(completionFile),candidate=recoveredRuntimeBinding(context.before,{operationId:context.plan.operationId,beforeBinding:context.beforePin,completion:completionPin,source:context.source,spool:completion.spoolIdentity,receipt});
 need(canonicalEqual(completion.receipt,receipt)&&canonicalEqual(completion.backups,backups),'RECOVERY_COMPLETION_CONSERVATION_CHANGED');await validateRecoveryBinding(candidate,{verifyPin,sourceEvidence:sourceReader});await check();onPhase('COMPLETION_WRITTEN');
 const installed=await replaceRecoveryBinding(bindingPath,context.beforePin.sha256,candidate,context.plan.operationId);onPhase('BINDING_INSTALLED');await validateRecoveryBinding(JSON.parse(await readFile(bindingPath,'utf8')),{verifyPin,sourceEvidence:sourceReader});
 return {status:'RECOVERY_APPLIED',operationId:context.plan.operationId,spoolVersion:2,bindingVersion:2,originalMessages:receipt.originalCount,futureSequence:receipt.afterSequence,replayed:result.replayed||installed.replayed,servicesSwitched:false,productionApproved:false};
}
