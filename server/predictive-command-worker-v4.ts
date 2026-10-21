import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import {DomainError} from './service.ts';
import {requireAccess} from './access.ts';
import {canonicalDigest} from './canonical-state.ts';
import {PredictiveMapV4,predictiveReviewRequestV4} from './predictive-map-v4.ts';
import {predictiveAnalysisRequestV4} from './predictive-input-v4.ts';
import {PredictiveJobStoreV4,type PredictiveQueueClaimV4} from './predictive-job-store-v4.ts';
import {PredictiveJobCryptoV4,type PredictiveAuthReferenceV4} from './predictive-job-crypto-v4.ts';
import type {PredictiveJobV4} from './predictive-state-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {PredictiveRuleTransportV4,PredictiveTransportErrorV4} from './predictive-transport-v4.ts';
import {MaintenanceWorkflowTransportV4,MaintenanceTransportErrorV4} from './maintenance-workflow-transport-v4.ts';
import {startPredictiveHeartbeatV4} from './predictive-job-heartbeat-v4.ts';
import type {PublicGovernedSource} from './source-governance.ts';

export function openPredictiveCommandV4(job:{id:string;actorId:string;commandId:string;requestHash:string;action:string;sealedCommand:unknown},crypto:PredictiveJobCryptoV4){
 const raw=crypto.open(job.sealedCommand,job,'COMMAND') as {kind?:string};
 const command=raw?.kind==='ANALYZE'?predictiveAnalysisRequestV4(raw):predictiveReviewRequestV4(raw);
 need(command.kind===job.action&&canonicalDigest(command)===job.requestHash,'PREDICTIVE_COMMAND_BINDING');return command;
}
export interface PredictiveCommandWorkerOptionsV4 {queue:PredictiveJobStoreV4;crypto:PredictiveJobCryptoV4;auth:Pick<GovernanceJobAuthV4,'resolve'>;account:ClientConfig;binding:StateMapBinding;predictor:PredictiveRuleTransportV4;workflow:MaintenanceWorkflowTransportV4;sources:readonly PublicGovernedSource[];onError?:(e:unknown)=>Promise<void>}
/** Only the specific SQL claim is ever dispatched. The SDK's legacy queue head is not used. */
export class PredictiveCommandWorkerV4 {
 #o:PredictiveCommandWorkerOptionsV4;#busy=false;
 constructor(o:PredictiveCommandWorkerOptionsV4){this.#o=o;}
 async runOne(){
  if(this.#busy)throw Error('PREDICTIVE_WORKER_BUSY');this.#busy=true;
  let lease:PredictiveQueueClaimV4|null=null,heartbeat:ReturnType<typeof startPredictiveHeartbeatV4>|undefined,map:PredictiveMapV4|undefined,sdk:PredictiveJobV4|undefined,authorize:(()=>Promise<import('./governance-job-auth-v4.ts').ResolvedGovernanceAuthV4>)|undefined;
  try{
   lease=await this.#o.queue.claim();if(!lease)return null;const claim=lease;
   heartbeat=startPredictiveHeartbeatV4(this.#o.account,this.#o.queue.binding,claim);
   const command=openPredictiveCommandV4(claim,this.#o.crypto),ref=this.#o.crypto.open(claim.retryPending?claim.sealedRetryGrant:claim.sealedGrant,claim,claim.retryPending?'RETRY':'GRANT',claim.retryPending?claim.retryId!:claim.grantRevision) as PredictiveAuthReferenceV4;
   authorize=async()=>{heartbeat!.assertLive();const live=await this.#o.auth.resolve(ref);need(live.context.actorId===(claim.retryPending?claim.retryActor:claim.actorId)&&live.context.tenantId===claim.tenantId&&(!claim.retryPending||claim.retryActor!==claim.actorId),'PREDICTIVE_AUTH_IDENTITY');requireAccess(live.context,claim.retryPending?'predictive:approve':claim.action==='ANALYZE'?'analyze':'predictive:approve');if(claim.retryPending)await this.#o.queue.lockRetry(claim,live.deadline);else await this.#o.queue.checkLease(claim,live.deadline);return live;};
   let live=await authorize();
   map=new PredictiveMapV4(this.#o.account,this.#o.binding,{predictorBinding:this.#o.predictor.binding,workflowBinding:this.#o.workflow.binding,sources:this.#o.sources,hooks:{commit:async(head,id,ops)=>{
    const current=await authorize!(),s=await DomainMapSnapshot.open(this.#o.account,this.#o.binding);let marker;
    try{need(s.head.rootHash===head.rootHash&&s.head.revision===head.revision,'STATE_MAP_CAS_CONFLICT');marker=await s.operation('predictive_host',claim.businessKey,{format:'IDMS_PREDICTIVE_HOST_V4_1',tenantId:claim.tenantId,jobId:claim.id,actorId:claim.actorId,commandId:claim.commandId,requestHash:claim.requestHash,grantRevision:claim.grantRevision});}finally{await s.close();}
    return this.#o.queue.prepare(claim,this.#o.binding,head,id,[...ops,marker],current.deadline,claim.cancelRequested?'CANCEL':claim.retryPending?'RETRY':'PREPARE');
   }}});
   if(claim.retryPending){
    const s=await DomainMapSnapshot.open(this.#o.account,this.#o.binding);let retryJob:PredictiveJobV4,marker:any;
    try{retryJob=await s.get<PredictiveJobV4>('predictive_job',claim.businessKey);marker=await s.get('predictive_host',claim.businessKey);}finally{await s.close();}
    need(marker.jobId===claim.id&&marker.tenantId===claim.tenantId&&marker.actorId===claim.actorId&&marker.commandId===claim.commandId&&marker.requestHash===claim.requestHash&&retryJob.key===claim.businessKey,'PREDICTIVE_HOST_BINDING');
    await map.retryForReauthorization(retryJob,live.context,claim.retryId!);const done=await this.#o.queue.read(claim.actorId,claim.id);need(done?.status==='WAITING_AUTH'&&!done.retryPending,'PREDICTIVE_RETRY_ATOMIC');return done;
   }
   let prior:Awaited<ReturnType<PredictiveMapV4['inspect']>>|undefined;
   try{prior=await map.inspect(claim.commandId,live.context);}catch(e){if(!(e instanceof DomainError&&e.status===404&&e.message==='PREDICTIVE_JOB_NOT_FOUND'))throw e;}
   if(prior){
    const s=await DomainMapSnapshot.open(this.#o.account,this.#o.binding);let marker:any;
    try{marker=await s.get('predictive_host',claim.businessKey);}finally{await s.close();}
    need(marker.format==='IDMS_PREDICTIVE_HOST_V4_1'&&marker.tenantId===claim.tenantId&&marker.jobId===claim.id&&marker.actorId===claim.actorId&&marker.commandId===claim.commandId&&marker.requestHash===claim.requestHash&&/^[1-9][0-9]*$/.test(marker.grantRevision)&&BigInt(marker.grantRevision)<=BigInt(claim.grantRevision),'PREDICTIVE_HOST_BINDING');
    sdk=prior.job;
    if(claim.cancelRequested){await map.cancel(claim.commandId,live.context);const done=await this.#o.queue.read(claim.actorId,claim.id);need(done?.status==='CANCELLED','PREDICTIVE_CANCEL_ATOMIC');return done;}
    if(sdk.status==='COMMITTED')return await this.#o.queue.finish(claim,(await authorize()).deadline);
    if(sdk.status==='HUMAN_REVIEW'||sdk.status==='WAITING_AUTH'&&marker.grantRevision===claim.grantRevision)return await this.#o.queue.settle(claim);
    if(marker.grantRevision!==claim.grantRevision){await map.regrant(claim.commandId,live.context);prior=await map.inspect(claim.commandId,live.context);sdk=prior.job;}
   }else{if(claim.cancelRequested)return await this.#o.queue.cancel(claim,live.deadline);sdk=await map.submit(command,claim.commandId,live.context);prior=await map.inspect(claim.commandId,live.context);}
   need(sdk.key===claim.businessKey&&sdk.requestHash===claim.requestHash&&sdk.action===claim.action,'PREDICTIVE_SPECIFIC_CLAIM');
   const resolver=async(job:PredictiveJobV4)=>{need(job.key===claim.businessKey&&job.actorId===claim.actorId,'PREDICTIVE_SPECIFIC_CLAIM');return authorize!();};
   await map.authorize(sdk,resolver);const plan=prior.plan;let proof=null;
   if(plan.kind==='ANALYZE'&&!plan.input.inputError)proof=await this.#o.predictor.dispatch(plan.input);
   else if(plan.kind==='REVIEW'&&plan.order&&plan.envelope){live=await authorize();await this.#o.queue.startExternal(claim,live.deadline);proof=await this.#o.workflow.dispatch(plan.envelope,plan.order);}
   await map.authorize(sdk,resolver);await map.complete(sdk,proof,resolver);
   const done=await this.#o.queue.read(claim.actorId,claim.id);need(done?.status==='COMMITTED','PREDICTIVE_ATOMIC_COMPLETION');return done;
  }catch(error){
   await this.#o.onError?.(error);if(!lease)throw error;const current=await this.#o.queue.read(lease.actorId,lease.id);
   if(current&&(['COMMITTED','FAILED','CANCELLED'].includes(current.status)||current.grantRevision!==lease.grantRevision||current.retryId!==lease.retryId))return current;
   if(lease.retryPending)return this.#o.queue.deferRetry(lease);
   const auth=error instanceof DomainError&&[401,403].includes(error.status),transport=error instanceof PredictiveTransportErrorV4||error instanceof MaintenanceTransportErrorV4;
   if(auth){await this.#o.queue.defer(lease,true,'PREDICTIVE_AUTH_REQUIRED');return this.#o.queue.read(lease.actorId,lease.id);}
   if(/PREDICTIVE_QUEUE_(LEASE_LOST|CANCEL_PENDING)/.test((error as Error).message))return current;
   if(lease.cancelRequested){await this.#o.queue.defer(lease,false,'PREDICTIVE_CANCEL_RETRY');return this.#o.queue.read(lease.actorId,lease.id);}
   const terminal=transport&&error.terminal||error instanceof DomainError&&[400,404,409,413].includes(error.status)&&!['MAINTENANCE_FENCED','PREDICTIVE_FENCED'].includes(error.message);
   if(map&&sdk){
    try{await authorize!();await map.failure(sdk,transport?(error as Error).message:terminal?'PREDICTIVE_INPUT_OR_STATE_CHANGED':'PREDICTIVE_LOCAL_RETRY',terminal?'TERMINAL':transport?'NETWORK':'LOCAL');return await this.#o.queue.settle(lease);}
    catch(failure){if(failure instanceof DomainError&&[401,403].includes(failure.status)){await this.#o.queue.defer(lease,true,'PREDICTIVE_AUTH_REQUIRED');return this.#o.queue.read(lease.actorId,lease.id);}throw failure;}
   }
   if(terminal&&error instanceof DomainError&&authorize)return this.#o.queue.rejectUnprepared(lease,(await authorize()).deadline,{status:error.status,message:/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'PREDICTIVE_INPUT_OR_STATE_CHANGED'});
   await this.#o.queue.defer(lease,false,'PREDICTIVE_LOCAL_RETRY');return this.#o.queue.read(lease.actorId,lease.id);
  }finally{await heartbeat?.stop();this.#busy=false;}
 }
}
