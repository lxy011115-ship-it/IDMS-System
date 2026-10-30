import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {PredictiveCancelJobStoreV1,CancelQueueCommitUnknownV1,type CancelQueueLeaseV1} from './predictive-cancel-job-store-v1.ts';
import {PredictiveCancelJobCryptoV1} from './predictive-cancel-job-crypto-v1.ts';
import {verifyCancelJobCommandV1} from './predictive-cancel-job-input-v1.ts';
import {PredictiveReconciliationAuthV1,type ReconciliationGrantV1} from './predictive-reconciliation-auth-v1.ts';
import {PredictiveCancelJobReadV1} from './predictive-cancel-job-read-v1.ts';
import {PredictiveCancelReconciliationV1} from './predictive-cancel-reconciliation-v1.ts';
import {WorkflowCancelReservationTransportV1,type WorkflowReservationConfigV1} from './workflow-cancel-reservation-transport-v1.ts';
import {startCancelJobHeartbeatV1} from './predictive-cancel-job-heartbeat-v1.ts';
import {recoverCancelReleaseV1} from './predictive-cancel-release-recovery-v1.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {DomainError} from './service.ts';
import {canonicalEqual} from './canonical-state.ts';
import type {GovernanceAuthReferenceV4} from './governance-job-crypto-v4.ts';
interface Options {account:ClientConfig;binding:StateMapBinding;queueAccount:ClientConfig;queue:PredictiveCancelJobStoreV1;crypto:PredictiveCancelJobCryptoV1;sessionAuth:PredictiveReconciliationAuthV1;read:PredictiveCancelJobReadV1;transport:WorkflowReservationConfigV1;onError?:(error:unknown)=>void}
export class PredictiveCancelJobWorkerV1 {
 #o:Options;#running=false;
 constructor(options:Options){this.#o=options;need(options.binding.databaseOid===options.queue.binding.databaseOid&&options.binding.tenantId===options.queue.binding.tenantId&&options.binding.catalogHash===options.queue.binding.stateCatalogHash,'RECON_WORKER_BINDING');}
 async runOne(){if(this.#running)throw Error('RECON_WORKER_BUSY');this.#running=true;let lease:CancelQueueLeaseV1|null=null,heartbeat:ReturnType<typeof startCancelJobHeartbeatV1>|undefined;
  try{
   const o=this.#o;lease=await o.queue.claim();if(!lease)return null;const job=lease;heartbeat=startCancelJobHeartbeatV1(o.queueAccount,o.queue.binding,job);const assertLive=()=>heartbeat!.assertLive(),command=verifyCancelJobCommandV1(job,o.crypto.open(job.sealedCommand,job,'COMMAND'));
   if(job.releaseStarted){const intent=await o.queue.releaseIntent(job);need(intent,'RECON_RELEASE_INTENT');await recoverCancelReleaseV1({account:o.account,binding:o.binding,queue:o.queue,lease:job,intent,transport:new WorkflowCancelReservationTransportV1(o.transport),assertLive});return {id:job.id,status:'COMMITTED',recoveredRelease:true};}
   const reference=o.crypto.open(job.sealedGrant,job,'GRANT',job.grantRevision) as GovernanceAuthReferenceV4,grant=o.sessionAuth.grant(reference);let reviewGrant:ReconciliationGrantV1|undefined;
   const current=async()=>{assertLive();const a=await grant.current();need(a.context.actorId===job.actorId&&a.context.tenantId===job.tenantId,'RECON_WORKER_ACTOR');const reviewer=reviewGrant?await reviewGrant.current():undefined;await o.queue.check(job,Math.min(a.deadline,reviewer?.deadline??Infinity));return {a,reviewer,deadline:Math.min(a.deadline,reviewer?.deadline??Infinity)};};
   if(['CONFIRM','SETTLE'].includes(job.action)){const c=await o.read.read(job.caseId,grant);need(c.review,'RECON_WORKER_REVIEW_REQUIRED');const authority=await o.queue.authority(job,c.review!.operationId);need(authority&&authority.actorId===c.review!.actorId&&authority.sessionHash===c.review!.sessionHash,'RECON_WORKER_REVIEW_AUTHORITY');const reviewJob=await o.queue.read(authority.actorId,job.caseId,authority.operationId);need(reviewJob&&reviewJob.id===authority.jobId&&reviewJob.action==='REVIEW','RECON_WORKER_REVIEW_JOB');reviewGrant=o.sessionAuth.grant(o.crypto.open(authority.sealedGrant,reviewJob!,'GRANT',authority.grantRevision) as GovernanceAuthReferenceV4);}
   const beforeRelease=async()=>{const live=await current();need(live.reviewer&&reviewGrant,'RECON_WORKER_REVIEW_REQUIRED');const c=await o.read.read(job.caseId,grant),authorization={actorId:job.actorId,reviewerId:live.reviewer!.context.actorId,sessionHash:live.a.sessionHash,reviewSessionHash:live.reviewer!.sessionHash};need(c.review?.identityHash===live.reviewer!.identityHash&&c.review?.sessionHash===live.reviewer!.sessionHash,'RECON_WORKER_REVIEW_AUTH_CHANGED');try{await o.queue.startRelease(job,live.deadline,(command.request as any).expectedRevision,authorization);}catch(e){if(!(e instanceof CancelQueueCommitUnknownV1))throw e;const intent=await o.queue.releaseIntent(job);if(!intent||!canonicalEqual(intent.auth_witness,authorization)||intent.case_snapshot.revision!==(command.request as any).expectedRevision)throw e;}};
   class GuardedTransport extends WorkflowCancelReservationTransportV1 {
    override async reserve(...args:Parameters<WorkflowCancelReservationTransportV1['reserve']>){await current();return super.reserve(...args);}
    override async release(...args:Parameters<WorkflowCancelReservationTransportV1['release']>){await beforeRelease();return super.release(...args);}
   }
   const transport=new GuardedTransport(o.transport),sdk=new PredictiveCancelReconciliationV1(o.account,o.binding,{predictorBinding:o.read.config.predictorBinding,sources:o.read.config.sources,transport,hooks:{commit:async(head,id,ops)=>{const live=await current();return o.queue.publish(job,head,id,ops,live.deadline,live.a.sessionHash);}}});
   await current();let result;
   if(job.action==='OPEN')result=await sdk.open(command.request,grant);
   else if(job.action==='OBSERVE')result=await sdk.observe(job.caseId,command.request,grant);
   else if(job.action==='REVIEW')result=await sdk.review(job.caseId,command.request,grant);
   else if(job.action==='CONFIRM')result=await sdk.confirm(job.caseId,command.request,grant,reviewGrant!);
   else result=await sdk.settle(job.caseId,command.request,grant,reviewGrant!);
   const completed=await o.queue.read(job.actorId,job.caseId,job.operationId);need(completed?.status==='COMMITTED'&&canonicalEqual(completed.result,result),'RECON_WORKER_UNMANAGED_ACTION');return {id:job.id,status:'COMMITTED'};
  }catch(error){this.#o.onError?.(error);if(!lease)throw error;const o=this.#o,job=await o.queue.read(lease.actorId,lease.caseId,lease.operationId);if(job?.status==='COMMITTED')return {id:lease.id,status:'COMMITTED'};if(/RECON_QUEUE_LEASE_LOST/.test((error as Error).message))return {id:lease.id,status:'STALE'};const intent=await o.queue.releaseIntent(lease),auth=error instanceof DomainError&&[401,403].includes(error.status),terminal=error instanceof DomainError&&[400,404,409,413].includes(error.status)&&!/FENCED|UNAVAILABLE/.test(error.message),mode=intent?'RETRY':auth?'WAITING_AUTH':terminal?'FAILED':'RETRY';await o.queue.defer(lease,mode,intent?'RECON_RELEASE_RECOVERY_PENDING':auth?'RECON_CURRENT_AUTH_REQUIRED':terminal?'RECON_REQUEST_OR_EVIDENCE_CHANGED':'RECON_EXECUTION_RETRY');return {id:lease.id,status:mode};
  }finally{await heartbeat?.stop();this.#running=false;}
 }
}
