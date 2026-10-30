import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {PredictiveJobStoreV4,type PredictiveQueueBindingV4,type PredictiveQueueClaimV4} from './predictive-job-store-v4.ts';
import {PredictiveAdoptionStoreV4,PredictiveLegacyReadV4,preparePredictiveAdoptionV4} from './predictive-legacy-adoption-v4.ts';
import type {PredictiveJobCryptoV4,PredictiveAuthReferenceV4} from './predictive-job-crypto-v4.ts';
import type {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {startPredictiveHeartbeatV4} from './predictive-job-heartbeat-v4.ts';
import {openPredictiveCommandV4} from './predictive-command-worker-v4.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {DomainError} from './service.ts';
interface Options {account:ClientConfig;binding:StateMapBinding;queueAccount:ClientConfig;queueBinding:PredictiveQueueBindingV4;crypto:PredictiveJobCryptoV4;auth:Pick<GovernanceJobAuthV4,'resolve'>;read:PredictiveLegacyReadV4;onError?:(e:unknown)=>Promise<void>}
/** The existing worker gets the same lease only after the native host is bound. */
export class PredictiveAdoptingJobStoreV4 extends PredictiveJobStoreV4 {
 #o:Options;readonly adoption:PredictiveAdoptionStoreV4;
 constructor(o:Options){super(o.queueAccount,o.queueBinding);this.#o=o;this.adoption=new PredictiveAdoptionStoreV4(this);}
 override async claim(owner?:Parameters<PredictiveJobStoreV4['claim']>[0]):Promise<PredictiveQueueClaimV4|null>{
  const lease=await super.claim(owner);if(!lease)return null;let heartbeat:ReturnType<typeof startPredictiveHeartbeatV4>|undefined;
  try{
   const request=await this.adoption.claim(lease);if(!request||lease.retryPending)return lease;
   heartbeat=startPredictiveHeartbeatV4(this.#o.queueAccount,this.binding,lease);openPredictiveCommandV4(lease,this.#o.crypto);
   const reference=this.#o.crypto.open(lease.sealedGrant,lease,'GRANT',lease.grantRevision) as PredictiveAuthReferenceV4;
   const current=async()=>{heartbeat!.assertLive();const live=await this.#o.auth.resolve(reference);if(live.context.actorId!==lease.actorId||live.context.tenantId!==lease.tenantId)throw new DomainError(403,'PREDICTIVE_ADOPTION_ACTOR');await this.#o.read.candidate(lease.commandId,live.context);await this.checkLease(lease,live.deadline);return live;};
   await preparePredictiveAdoptionV4({account:this.#o.account,binding:this.#o.binding,store:this.adoption,lease,request,current});
   const job=await this.read(lease.actorId,lease.id);need(job&&job.grantRevision===lease.grantRevision,'PREDICTIVE_ADOPTION_LEASE_CHANGED');return job.status==='RUNNING'?lease:null;
  }catch(e){
   await this.#o.onError?.(e);const job=await this.read(lease.actorId,lease.id);if(!job||job.grantRevision!==lease.grantRevision||['COMMITTED','CANCELLED','FAILED','HUMAN_REVIEW'].includes(job.status))return null;
   if(/PREDICTIVE_QUEUE_(?:LEASE_LOST|CANCEL_PENDING)/.test((e as Error).message))return null;
   const waiting=e instanceof DomainError&&[401,403].includes(e.status)||/PREDICTIVE_ADOPTION_(?:STALE|SUPERSEDED|HOST_CONFLICT|AUTH_CHANGED|CANCEL_PENDING)|PREDICTIVE_CREATION_RECOVERY_REQUIRED/.test((e as Error).message);
   await this.defer(lease,waiting,waiting?'PREDICTIVE_ADOPTION_REAUTH_REQUIRED':'PREDICTIVE_ADOPTION_RETRY');return null;
  }finally{await heartbeat?.stop();}
 }
}
