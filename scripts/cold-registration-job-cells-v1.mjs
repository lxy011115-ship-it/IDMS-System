import {GovernanceJobCryptoV4} from '../server/governance-job-crypto-v4.ts';
import {MaintenanceJobCryptoV4} from '../server/maintenance-job-crypto-v4.ts';
import {PredictiveJobCryptoV4} from '../server/predictive-job-crypto-v4.ts';
import {PredictiveCancelJobCryptoV1} from '../server/predictive-cancel-job-crypto-v1.ts';
import {verifyCancelJobCommandV1} from '../server/predictive-cancel-job-input-v1.ts';
import {canonicalDigest} from '../server/canonical-state.ts';
import {validateKeyRing,validId} from '../server/auth-state.ts';

const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v)&&BigInt(v)<=4294967295n;
const text=v=>typeof v==='string'&&Buffer.byteLength(v)>0&&Buffer.byteLength(v)<=512&&!/[\u0000-\u001f\u007f]/.test(v),ordinal=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const implementations={GOVERNANCE:GovernanceJobCryptoV4,MAINTENANCE:MaintenanceJobCryptoV4,PREDICTIVE:PredictiveJobCryptoV4,RECONCILIATION:PredictiveCancelJobCryptoV1};
const common=['id','tenantId','actorId','action','requestHash','sealedCommand','sealedGrant','grantRevision','grantUntil'];
const failure=()=>Object.assign(Error('COLD_REGISTRATION_JOB_CELLS_UNVERIFIABLE'),{code:'COLD_REGISTRATION_JOB_CELLS_UNVERIFIABLE'});
function config(kind,binding,ring){
 need(Object.hasOwn(implementations,kind),'COLD_REGISTRATION_JOB_KIND');
 need(exact(binding,['tenantId','databaseOid','roleOid','catalogHash','deployment',...(kind==='RECONCILIATION'?['stateCatalogHash']:[])])&&text(binding.tenantId)&&oid(binding.databaseOid)&&oid(binding.roleOid)&&hex(binding.catalogHash)&&hex(binding.deployment)&&(kind!=='RECONCILIATION'||hex(binding.stateCatalogHash)),'COLD_REGISTRATION_JOB_BINDING');
 return new implementations[kind](validateKeyRing(ring),binding);
}
function metadata(kind,binding,row){
 const fields=[...common,...(kind==='RECONCILIATION'?['caseId','operationId','domainHash']:['commandId','businessKey']),...(kind==='PREDICTIVE'?['retryId','retryActor','sealedRetryGrant','retryUntil']:[])];
 need(exact(row,fields)&&uuid(row.id)&&row.tenantId===binding.tenantId&&text(row.actorId)&&text(row.action)&&hex(row.requestHash)&&ordinal(row.grantRevision)&&date(row.grantUntil),'COLD_REGISTRATION_JOB_ROW');
 if(kind==='RECONCILIATION')need(uuid(row.caseId)&&uuid(row.operationId)&&hex(row.domainHash)&&['OPEN','OBSERVE','REVIEW','CONFIRM','SETTLE'].includes(row.action),'COLD_REGISTRATION_JOB_ROW');
 else need(uuid(row.commandId)&&row.businessKey===canonicalDigest([binding.tenantId,row.actorId,'USER',row.commandId]),'COLD_REGISTRATION_JOB_ROW');
 return row;
}
function reference(value){need(exact(value,['kind','value'])&&['SESSION','BEARER'].includes(value.kind)&&typeof value.value==='string'&&value.value.length>0&&value.value.length<=32768&&!/[\u0000-\u0020\u007f]/.test(value.value)&&(value.kind!=='SESSION'||validId(value.value)),'COLD_REGISTRATION_JOB_REFERENCE');return value;}

/** Cryptographic inspection only: no SQL, identity lookup, authorization refresh or admission. */
export function inspectColdRegistrationJobCellsV1(raw){
 try{
  need(exact(raw,['kind','binding','ring','row']),'COLD_REGISTRATION_JOB_REQUEST');const {kind,binding,ring,row}=raw,crypto=config(kind,binding,ring);metadata(kind,binding,row);
  const command=crypto.open(row.sealedCommand,row,'COMMAND');need(command&&Object.getPrototypeOf(command)===Object.prototype,'COLD_REGISTRATION_JOB_COMMAND');
  if(kind==='RECONCILIATION')verifyCancelJobCommandV1(row,command);else need(canonicalDigest(command)===row.requestHash&&(kind==='PREDICTIVE'?command.kind:command.action)===row.action,'COLD_REGISTRATION_JOB_COMMAND');
  const originalGrant=reference(crypto.open(row.sealedGrant,row,'GRANT',row.grantRevision));if(kind==='RECONCILIATION')need(originalGrant.kind==='SESSION','COLD_REGISTRATION_JOB_REFERENCE');let cells=2,retryCells=0;const keys=new Set([row.sealedCommand.keyId,row.sealedGrant.keyId]);
  if(kind==='PREDICTIVE'){
   if(row.retryId===null)need(row.retryActor===null&&row.sealedRetryGrant===null&&row.retryUntil===null,'COLD_REGISTRATION_JOB_RETRY');
   else{need(uuid(row.retryId)&&text(row.retryActor)&&row.retryActor!==row.actorId,'COLD_REGISTRATION_JOB_RETRY');if(row.sealedRetryGrant===null)need(row.retryUntil===null,'COLD_REGISTRATION_JOB_RETRY');else{need(date(row.retryUntil),'COLD_REGISTRATION_JOB_RETRY');reference(crypto.open(row.sealedRetryGrant,row,'RETRY',row.retryId));keys.add(row.sealedRetryGrant.keyId);cells++;retryCells++;}}
  }
  return{format:'COLD_REGISTRATION_JOB_CELLS_V1',kind,encryptedCells:cells,retryCells,keyIdsUsed:[...keys].sort(),expiredOriginalGrantPreserved:Date.parse(row.grantUntil)<=Date.now(),expiredRetryGrantPreserved:retryCells>0&&Date.parse(row.retryUntil)<=Date.now(),commandIdentityAndRequestHashVerified:true,allSuppliedCellsDecrypted:true,sqlSourceCoverageVerified:false,currentAuthorizationVerified:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 }catch{throw failure();}
}

/** A historical flow/review grant binds to the exact original job and its own revision. */
export function inspectColdRegistrationAuxiliaryJobGrantV1(raw){
 try{
  need(exact(raw,['kind','binding','ring','job','grant']),'COLD_REGISTRATION_JOB_REQUEST');const {kind,binding,ring,job,grant}=raw,crypto=config(kind,binding,ring);metadata(kind,binding,job);
  need(['MAINTENANCE','RECONCILIATION'].includes(kind)&&exact(grant,['tenantId','jobId','actorId','revision','until','sealed',...(kind==='MAINTENANCE'?['commandId']:['caseId','operationId','sessionHash'])])&&grant.tenantId===binding.tenantId&&grant.jobId===job.id&&grant.actorId===job.actorId&&ordinal(grant.revision)&&date(grant.until),'COLD_REGISTRATION_JOB_AUXILIARY');
  if(kind==='MAINTENANCE')need(uuid(grant.commandId)&&['claim','start','submit','approval'].includes(job.action),'COLD_REGISTRATION_JOB_AUXILIARY');
  else need(job.action==='REVIEW'&&grant.caseId===job.caseId&&grant.operationId===job.operationId&&hex(grant.sessionHash),'COLD_REGISTRATION_JOB_AUXILIARY');
  const opened=crypto.open(grant.sealed,job,'GRANT',grant.revision);reference(opened);if(kind==='RECONCILIATION')need(opened.kind==='SESSION'&&canonicalDigest(['PREDICTIVE_CANCEL_SESSION_V1',opened.value])===grant.sessionHash,'COLD_REGISTRATION_JOB_AUXILIARY_SESSION');
  return{format:'COLD_REGISTRATION_AUXILIARY_JOB_GRANT_V1',kind,encryptedCells:1,keyId:grant.sealed.keyId,expiredGrantPreserved:Date.parse(grant.until)<=Date.now(),exactOriginalJobAndRevisionVerified:true,sqlSourceCoverageVerified:false,currentAuthorizationVerified:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 }catch{throw failure();}
}
