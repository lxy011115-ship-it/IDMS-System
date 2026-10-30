import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {PublicGovernedSource} from './source-governance.ts';
import type {GovernanceCommandV4} from './governance-plan-v5.ts';
import {GovernanceConsoleCommandServiceV5} from './governance-console-command-v5.ts';
import {GovernanceJobStoreV4,GovernanceQueueCommitUnknownV4,type GovernanceClaimV4} from './governance-console-store-v4.ts';
import {GovernanceJobCryptoV4,type GovernanceAuthReferenceV4} from './governance-job-crypto-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {authorizeGovernanceConsoleJobV4 as authorizeGovernanceJobV4} from './governance-console-access-v4.ts';
import {verifyGovernanceJobCommandV4,verifyGovernanceJobCompletionV4} from './governance-job-proof-v4.ts';
import {startGovernanceHeartbeatV4} from './governance-job-heartbeat-v4.ts';
import {DomainError} from './service.ts';
export interface GovernanceConsoleWorkerOptionsV5 {queue:GovernanceJobStoreV4;queueAccount:ClientConfig;crypto:GovernanceJobCryptoV4;auth:GovernanceJobAuthV4;account:ClientConfig;binding:StateMapBinding;sources:readonly PublicGovernedSource[];onError?:(error:unknown)=>Promise<void>;onPhase?:(phase:string,value:unknown)=>Promise<void>}
export class GovernanceConsoleWorkerV5 {
 #o:GovernanceConsoleWorkerOptionsV5;#running=false;
 constructor(options:GovernanceConsoleWorkerOptionsV5){this.#o=options;}
 async runOne(){if(this.#running)throw Error('GOVERNANCE_WORKER_BUSY');this.#running=true;let claim:GovernanceClaimV4|null=null,heartbeat:ReturnType<typeof startGovernanceHeartbeatV4>|undefined;
  try{claim=await this.#o.queue.claim();if(!claim)return null;const lease=claim;heartbeat=startGovernanceHeartbeatV4(this.#o.queueAccount,this.#o.queue.binding,lease);const command=verifyGovernanceJobCommandV4(lease,this.#o.crypto.open(lease.sealedCommand,lease,'COMMAND') as GovernanceCommandV4),ref=this.#o.crypto.open(lease.sealedGrant,lease,'GRANT',lease.grantRevision) as GovernanceAuthReferenceV4;
   const authorize=async()=>{heartbeat!.assertLive();const live=await this.#o.auth.resolve(ref);if(live.context.tenantId!==lease.tenantId||live.context.actorId!==lease.actorId)throw new DomainError(403,'GOVERNANCE_AUTH_IDENTITY');await authorizeGovernanceJobV4(this.#o.account,this.#o.binding,command,live.context,undefined,{cancel:lease.cancelRequested});await this.#o.queue.checkLease(lease,live.deadline);return live;};
   let live=await authorize();if(lease.cancelRequested)return await this.#o.queue.cancel(lease,live.deadline);
   const completed=await verifyGovernanceJobCompletionV4(this.#o.account,this.#o.binding,lease);if(completed)return await this.#o.queue.finish(lease,live.deadline);
   const service=new GovernanceConsoleCommandServiceV5(this.#o.account,this.#o.binding,this.#o.sources,{commit:async(head,id,ops)=>{live=await authorize();return this.#o.queue.prepare(lease,this.#o.binding,head,id,ops,live.deadline);},onPhase:async(phase,value)=>{if(phase!=='PUBLISHED')live=await authorize();await this.#o.onPhase?.(phase,value);},publish:async(branch,id)=>{live=await authorize();const result=await this.#o.queue.publish(lease,branch,id,live.deadline);return result.publication;}});
   await service.execute(lease.commandId,command,live.context);const job=await this.#o.queue.read(lease.actorId,lease.id);if(!job||job.status!=='COMMITTED')throw Error('GOVERNANCE_JOB_COMPLETION_MISSING');return job;
  }catch(error){await this.#o.onError?.(error);if(!claim)throw error;const job=await this.#o.queue.read(claim.actorId,claim.id);if(job&&['COMMITTED','FAILED','CANCELLED'].includes(job.status)){await verifyGovernanceJobCompletionV4(this.#o.account,this.#o.binding,job);return job;}
   try{const ref=this.#o.crypto.open(claim.sealedGrant,claim,'GRANT',claim.grantRevision) as GovernanceAuthReferenceV4,live=await this.#o.auth.resolve(ref),command=verifyGovernanceJobCommandV4(claim,this.#o.crypto.open(claim.sealedCommand,claim,'COMMAND') as GovernanceCommandV4);await authorizeGovernanceJobV4(this.#o.account,this.#o.binding,command,live.context,undefined,{cancel:claim.cancelRequested});const completion=await verifyGovernanceJobCompletionV4(this.#o.account,this.#o.binding,claim);if(completion)return await this.#o.queue.finish(claim,live.deadline);
   }catch(recheck){if(recheck instanceof DomainError&&[401,403].includes(recheck.status)){await this.#o.queue.defer(claim,true,'GOVERNANCE_AUTH_REQUIRED');return await this.#o.queue.read(claim.actorId,claim.id);}}
   const waiting=error instanceof DomainError&&[401,403].includes(error.status);await this.#o.queue.defer(claim,waiting,waiting?'GOVERNANCE_AUTH_REQUIRED':error instanceof GovernanceQueueCommitUnknownV4?'GOVERNANCE_QUEUE_COMMIT_UNKNOWN':'GOVERNANCE_RETRY');return await this.#o.queue.read(claim.actorId,claim.id);
  }finally{await heartbeat?.stop();this.#running=false;}
 }
}
