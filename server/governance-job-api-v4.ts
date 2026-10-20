import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {GovernanceCommandV4} from './governance-plan-v4.ts';
import {GovernanceJobStoreV4,GovernanceQueueCommitUnknownV4,type GovernanceJobV4} from './governance-job-store-v4.ts';
import {GovernanceJobCryptoV4} from './governance-job-crypto-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {authorizeGovernanceJobV4} from './governance-job-access-v4.ts';
import {normalizeGovernanceJobInputV4} from './governance-job-input-v4.ts';
import {verifyGovernanceJobCommandV4,verifyGovernanceJobCompletionV4} from './governance-job-proof-v4.ts';
import {withRequestCapacity,readRequestBytes,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {canonicalDigest} from './canonical-state.ts';
import {DomainError} from './service.ts';
import type {AccessContext} from './access.ts';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function fail(status:number,message:string):never{throw new DomainError(status,message);}
export interface GovernanceJobApiOptionsV4 {queue:GovernanceJobStoreV4;crypto:GovernanceJobCryptoV4;auth:GovernanceJobAuthV4;readAccount:ClientConfig;readBinding:StateMapBinding}
/** Standalone HTTP boundary. The ingress process needs QI + READER credentials only. */
export class GovernanceJobApiV4 {
 #o:GovernanceJobApiOptionsV4;
 constructor(options:GovernanceJobApiOptionsV4){this.#o=options;}
 #command(job:GovernanceJobV4){return verifyGovernanceJobCommandV4(job,this.#o.crypto.open(job.sealedCommand,job,'COMMAND') as GovernanceCommandV4);}
 async #access(job:GovernanceJobV4,ctx:AccessContext,cancel=false){if(job.actorId!==ctx.actorId||job.tenantId!==ctx.tenantId)fail(404,'GOVERNANCE_JOB_NOT_FOUND');const command=this.#command(job);await authorizeGovernanceJobV4(this.#o.readAccount,this.#o.readBinding,command,ctx,job.result,{cancel});return command;}
 async #present(job:GovernanceJobV4,ctx:AccessContext,cancel=false){await this.#access(job,ctx,cancel);const proof=await verifyGovernanceJobCompletionV4(this.#o.readAccount,this.#o.readBinding,job);return {id:job.id,commandId:job.commandId,action:job.action,status:job.status,recovering:job.status==='RUNNING'&&!job.leaseLive,cancelRequested:job.cancelRequested,attempts:job.attempts,errorCode:job.errorCode,createdAt:job.createdAt,updatedAt:job.updatedAt,businessCommitted:job.status==='COMMITTED',result:job.status==='COMMITTED'?proof?.result:null,completion:job.status==='CANCELLED'?'CANCELLED':job.status==='FAILED'?'FAILED':job.status==='COMMITTED'?'COMMITTED':null};}
 async #body(req:IncomingMessage,max=16*1024*1024){if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail(415,'GOVERNANCE_JSON_REQUIRED');const b=await readRequestBytes(req,max);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{fail(400,'GOVERNANCE_JSON_INVALID');}}
 async handle(req:IncomingMessage,res:ServerResponse){
  const url=new URL(req.url||'/','http://localhost');if(!url.pathname.startsWith('/api/v4/governance/jobs'))return false;
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(text);};
  try{await withRequestCapacity(req,res,async()=>{
   if(url.search||url.pathname.length>160)fail(400,'GOVERNANCE_ROUTE_INVALID');const auth=await this.#o.auth.capture(req),ctx=auth.context;if(ctx.tenantId!==this.#o.readBinding.tenantId||req.headers['x-tenant-id']!==ctx.tenantId)fail(403,'GOVERNANCE_TENANT_MISMATCH');bindRequestTenant(ctx.tenantId);
   if(url.pathname==='/api/v4/governance/jobs'&&req.method==='POST'){
    const body=await this.#body(req);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='command,commandId'||!uuid(body.commandId))fail(400,'GOVERNANCE_COMMAND_ID');const command=await normalizeGovernanceJobInputV4(body.command),requestHash=canonicalDigest(command),existing=await this.#o.queue.find(ctx.actorId,body.commandId);
    if(existing){await this.#access(existing,ctx);if(existing.requestHash!==requestHash)fail(409,'GOVERNANCE_COMMAND_CONFLICT');send(202,{accepted:true,job:await this.#present(existing,ctx)});return;}
    await authorizeGovernanceJobV4(this.#o.readAccount,this.#o.readBinding,command,ctx);const meta={id:randomUUID(),actorId:ctx.actorId,commandId:body.commandId,requestHash};let job:GovernanceJobV4;
    try{job=await this.#o.queue.enqueue(ctx.actorId,meta.id,meta.commandId,command.action,requestHash,this.#o.crypto.seal(command,meta,'COMMAND'),this.#o.crypto.seal(auth.reference,meta,'GRANT'),auth.referenceUntil);}catch(e){if(!(e instanceof GovernanceQueueCommitUnknownV4))throw e;const known=await this.#o.queue.find(ctx.actorId,meta.commandId);if(!known||known.requestHash!==requestHash)throw e;job=known;}
    // A successful durable enqueue is sufficient for acceptance; full business work is asynchronous.
    await this.#access(job,ctx);send(202,{accepted:true,job:await this.#present(job,ctx)});return;
   }
   const match=url.pathname.match(/^\/api\/v4\/governance\/jobs\/([a-f0-9-]+)(?:\/(authorize|cancel))?$/);if(!match||!uuid(match[1])||!(req.method==='GET'&&!match[2]||req.method==='POST'&&match[2]))fail(404,'GOVERNANCE_ROUTE_NOT_FOUND');let job=await this.#o.queue.read(ctx.actorId,match[1]);if(!job)fail(404,'GOVERNANCE_JOB_NOT_FOUND');const cancel=match[2]==='cancel';await this.#access(job,ctx,cancel);
   if(req.method==='POST'){
    const body=await this.#body(req,4096);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)fail(400,'GOVERNANCE_EMPTY_BODY_REQUIRED');const revision=String(BigInt(job.grantRevision)+1n),sealed=this.#o.crypto.seal(auth.reference,job,'GRANT',revision);job=await this.#o.queue.authorize(job,sealed,auth.referenceUntil,cancel);
   }
   send(req.method==='POST'?202:200,{job:await this.#present(job,ctx,cancel)});
  });}catch(e){if(res.headersSent){res.destroy();return true;}const status=e instanceof DomainError?e.status:e instanceof GovernanceQueueCommitUnknownV4?503:503;const message=e instanceof DomainError?e.message:e instanceof GovernanceQueueCommitUnknownV4?'GOVERNANCE_QUEUE_COMMIT_UNKNOWN':'GOVERNANCE_UNAVAILABLE';send(status,{error:message});}return true;
 }
}
