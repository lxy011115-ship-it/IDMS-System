import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {PredictiveCancelJobStoreV1,CancelQueueCommitUnknownV1,type CancelQueueJobV1} from './predictive-cancel-job-store-v1.ts';
import {PredictiveCancelJobCryptoV1} from './predictive-cancel-job-crypto-v1.ts';
import {PredictiveCancelJobReadV1} from './predictive-cancel-job-read-v1.ts';
import {PredictiveReconciliationAuthV1,type ReconciliationGrantV1} from './predictive-reconciliation-auth-v1.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {cancelJobCommandV1,cancelJobHashesV1,cancelJobOperationV1,verifyCancelJobCommandV1,type CancelJobCommandV1} from './predictive-cancel-job-input-v1.ts';
import {cancelUuidV1 as uuid,cancelFailV1 as fail} from './predictive-cancel-contract-v1.ts';
import {DomainError} from './service.ts';
import {withRequestCapacity,readRequestBytes,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,sqlScheduler,requestSignal} from './capacity.ts';
interface Options {queue:PredictiveCancelJobStoreV1;crypto:PredictiveCancelJobCryptoV1;read:PredictiveCancelJobReadV1;provider:GovernanceJobAuthV4;sessionAuth:PredictiveReconciliationAuthV1}
/** Standalone route adapter: QI + READER; no APP or workflow credentials. */
export class PredictiveCancelJobHttpV1 {
 #o:Options;
 constructor(options:Options){this.#o=options;}
 async #body(req:IncomingMessage){if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail(415,'RECON_JOB_JSON_REQUIRED');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readRequestBytes(req,8192)));}catch(e){if(e instanceof DomainError)throw e;fail(400,'RECON_JOB_JSON_INVALID');}}
 async #access(command:CancelJobCommandV1,grant:ReconciliationGrantV1,fresh=false){const live=await grant.current();if(command.action==='OPEN'){const candidate=await this.#o.read.candidate((command.request as any).commandId,grant);if(candidate.nativeHash!==(command.request as any).expectedNativeHash)fail(409,'RECON_JOB_NATIVE_CHANGED');return;}
  const c=await this.#o.read.read(command.caseId,grant);if(command.action==='REVIEW'?c.originalActorId===live.context.actorId:c.originalActorId!==live.context.actorId)fail(403,command.action==='REVIEW'?'RECON_JOB_INDEPENDENT_REVIEW_REQUIRED':'RECON_JOB_ORIGINAL_ACTOR_REQUIRED');if(fresh&&c.revision!==(command.request as any).expectedRevision)fail(409,'RECON_JOB_VERSION_CHANGED');
 }
 async #present(job:CancelQueueJobV1,grant:ReconciliationGrantV1){const live=await grant.current();if(job.actorId!==live.context.actorId||job.tenantId!==live.context.tenantId)fail(404,'RECON_JOB_NOT_FOUND');const command=verifyCancelJobCommandV1(job,this.#o.crypto.open(job.sealedCommand,job,'COMMAND'));await this.#access(command,grant);return {id:job.id,caseId:job.caseId,operationId:job.operationId,action:job.action,status:job.status,grantRevision:job.grantRevision,releaseStarted:job.releaseStarted,recovering:job.status==='RUNNING'&&!job.leaseLive,attempts:job.attempts,errorCode:job.errorCode,businessCommitted:job.status==='COMMITTED',result:job.status==='COMMITTED'?job.result:null,createdAt:job.createdAt,updatedAt:job.updatedAt};}
 async handle(req:IncomingMessage,res:ServerResponse){const url=new URL(req.url||'/','http://localhost');if(!url.pathname.startsWith('/api/v4/reconciliation/'))return false;const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(text);};
  try{await withRequestCapacity(req,res,async()=>memoryTask(async()=>sqlScheduler.run(this.#o.read.binding.tenantId,async()=>{
   if(url.search||url.pathname.length>210)fail(400,'RECON_JOB_ROUTE');const captured=await this.#o.provider.capture(req),grant=this.#o.sessionAuth.grant(captured.reference),live=await grant.current(),actor=live.context.actorId;if(live.context.tenantId!==this.#o.read.binding.tenantId||req.headers['x-tenant-id']!==live.context.tenantId)fail(403,'RECON_JOB_TENANT');bindRequestTenant(live.context.tenantId);const fresh=async()=>{const now=await grant.current();if(now.identityHash!==live.identityHash||now.sessionHash!==live.sessionHash||live.deadline<=Date.now())fail(403,'RECON_JOB_AUTH_CHANGED');};
   const candidate=url.pathname.match(/^\/api\/v4\/reconciliation\/candidates\/([a-f0-9-]+)$/);if(candidate&&uuid(candidate[1])&&req.method==='GET'){const value=await this.#o.read.candidate(candidate[1],grant);await fresh();send(200,value);return;}
   const caseMatch=url.pathname.match(/^\/api\/v4\/reconciliation\/cases\/([a-f0-9-]+)$/);if(caseMatch&&uuid(caseMatch[1])&&req.method==='GET'){const value=await this.#o.read.read(caseMatch[1],grant);await fresh();send(200,value);return;}
   if(url.pathname==='/api/v4/reconciliation/actions'&&req.method==='POST'){
    const command=cancelJobCommandV1(await this.#body(req)),operationId=cancelJobOperationV1(command),hashes=cancelJobHashesV1(command),old=await this.#o.queue.read(actor,command.caseId,operationId);
    if(old){if(old.requestHash!==hashes.requestHash)fail(409,'RECON_JOB_ACTION_CONFLICT');const job=await this.#present(old,grant);await fresh();send(202,{accepted:true,job});return;}
    await this.#access(command,grant,true);const unmanaged=await this.#o.read.withSnapshot(grant,async s=>(await s.state('receipt','predictive_cancel_action:'+command.caseId+':'+operationId)).present);if(unmanaged)fail(409,'RECON_JOB_UNMANAGED_ACTION');await fresh();const meta={id:randomUUID(),actorId:actor,caseId:command.caseId,operationId,action:command.action,...hashes};let job;
    try{job=await this.#o.queue.enqueue(meta,this.#o.crypto.seal(command,meta,'COMMAND'),this.#o.crypto.seal(captured.reference,meta,'GRANT'),captured.referenceUntil);}catch(e){if(!(e instanceof CancelQueueCommitUnknownV1))throw e;job=await this.#o.queue.read(actor,command.caseId,operationId);if(!job||job.requestHash!==hashes.requestHash)throw e;}
    const result=await this.#present(job,grant);await fresh();send(202,{accepted:true,job:result});return;
   }
   const action=url.pathname.match(/^\/api\/v4\/reconciliation\/cases\/([a-f0-9-]+)\/actions\/([a-f0-9-]+)(?:\/(close|authorize))?$/);if(!action||!uuid(action[1])||!uuid(action[2])||!(req.method==='GET'&&!action[3]||req.method==='POST'&&action[3]))return fail(404,'RECON_JOB_ROUTE_NOT_FOUND');
   let job=await this.#o.queue.read(actor,action[1],action[2]);
   if(action[3]==='close'){
    const command=cancelJobCommandV1(await this.#body(req));if(command.caseId!==action[1]||cancelJobOperationV1(command)!==action[2])fail(400,'RECON_JOB_ACTION_ID');await this.#access(command,grant);if(job&&job.requestHash!==cancelJobHashesV1(command).requestHash)fail(409,'RECON_JOB_ACTION_CONFLICT');await fresh();let result;try{result=await this.#o.queue.close(actor,action[1],action[2]);}catch(e){if(e instanceof CancelQueueCommitUnknownV1)fail(503,'RECON_JOB_CLOSE_UNKNOWN');throw e;}await fresh();send(200,{...result,job:result.job?await this.#present(result.job,grant):null});return;
   }
   if(!job)return fail(404,'RECON_JOB_NOT_FOUND');await this.#present(job,grant);
   if(action[3]==='authorize'){const body=await this.#body(req);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='authorizationId,expectedGrantRevision'||!uuid(body.authorizationId)||typeof body.expectedGrantRevision!=='string'||!/^[1-9][0-9]{0,18}$/.test(body.expectedGrantRevision)||BigInt(body.expectedGrantRevision)>=9223372036854775807n)fail(400,'RECON_JOB_AUTHORIZE_INPUT');await fresh();const revision=String(BigInt(body.expectedGrantRevision)+1n),sealed=this.#o.crypto.seal(captured.reference,job,'GRANT',revision);try{job=await this.#o.queue.authorize({...job,grantRevision:body.expectedGrantRevision},sealed,captured.referenceUntil,body.authorizationId,live.sessionHash);}catch(e){if(!(e instanceof CancelQueueCommitUnknownV1))throw e;await fresh();job=await this.#o.queue.authorize({...job,grantRevision:body.expectedGrantRevision},sealed,captured.referenceUntil,body.authorizationId,live.sessionHash);}}
   const result=await this.#present(job,grant);await fresh();send(200,{job:result});
  },requestSignal())));
  }catch(e){if(res.headersSent){res.destroy();return true;}const code=(e as Error).message,conflict=/^RECON_QUEUE_(?:ACTION_CONFLICT|ACCEPTANCE_CLOSED|GRANT_CONFLICT|AUTHORIZATION_CONFLICT|RELEASE_STARTED)$/.test(code);send(e instanceof DomainError?e.status:conflict?409:503,{error:e instanceof DomainError||conflict?code:e instanceof CancelQueueCommitUnknownV1?'RECON_JOB_ACCEPTANCE_UNKNOWN':'RECON_JOB_UNAVAILABLE'});}return true;
 }
}
