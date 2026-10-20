// Compatible job HTTP revision: file provenance for mappings, safe cancellation observation and command recovery.
import {randomUUID} from 'node:crypto';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal} from './capacity.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {GovernanceCommandV4} from './governance-plan-v4.ts';
import {GovernanceJobStoreV4,GovernanceQueueCommitUnknownV4,type GovernanceJobV4} from './governance-console-store-v4.ts';
import {GovernanceJobCryptoV4} from './governance-job-crypto-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {authorizeGovernanceConsoleJobV4 as authorizeGovernanceJobV4} from './governance-console-access-v4.ts';
import {normalizeGovernanceConsoleInputV4} from './governance-console-input-v4.ts';
import {verifyGovernanceJobCommandV4,verifyGovernanceJobCompletionV4} from './governance-job-proof-v4.ts';
import {withRequestCapacity,readRequestBytes,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {canonicalDigest} from './canonical-state.ts';
import {DomainError} from './service.ts';
import type {AccessContext} from './access.ts';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
function fail(status:number,message:string):never{throw new DomainError(status,message);}
export interface GovernanceConsoleJobApiOptionsV4 {queue:GovernanceJobStoreV4;crypto:GovernanceJobCryptoV4;auth:GovernanceJobAuthV4;readAccount:ClientConfig;readBinding:StateMapBinding}
/** Standalone HTTP boundary. The ingress process needs QI + READER credentials only. */
export class GovernanceConsoleJobApiV4 {
 #o:GovernanceConsoleJobApiOptionsV4;
 constructor(options:GovernanceConsoleJobApiOptionsV4){this.#o=options;}
 #command(job:GovernanceJobV4){return verifyGovernanceJobCommandV4(job,this.#o.crypto.open(job.sealedCommand,job,'COMMAND') as GovernanceCommandV4);}
 async #access(job:GovernanceJobV4,ctx:AccessContext,cancel=false){if(job.actorId!==ctx.actorId||job.tenantId!==ctx.tenantId)fail(404,'GOVERNANCE_JOB_NOT_FOUND');const command=this.#command(job);await authorizeGovernanceJobV4(this.#o.readAccount,this.#o.readBinding,command,ctx,job.result,{cancel});return command;}
 async #present(job:GovernanceJobV4,ctx:AccessContext,cancel=false){await this.#access(job,ctx,cancel);const proof=await verifyGovernanceJobCompletionV4(this.#o.readAccount,this.#o.readBinding,job);return {id:job.id,commandId:job.commandId,action:job.action,status:job.status,recovering:job.status==='RUNNING'&&!job.leaseLive,cancelRequested:job.cancelRequested,attempts:job.attempts,errorCode:job.errorCode,createdAt:job.createdAt,updatedAt:job.updatedAt,businessCommitted:job.status==='COMMITTED',result:job.status==='COMMITTED'&&!cancel?proof?.result:null,failure:job.status==='FAILED'&&!cancel?proof?.error:null,completion:job.status==='CANCELLED'?'CANCELLED':job.status==='FAILED'?'FAILED':job.status==='COMMITTED'?'COMMITTED':null};}
 async #body(req:IncomingMessage,max=16*1024*1024){if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail(415,'GOVERNANCE_JSON_REQUIRED');const b=await readRequestBytes(req,max);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{fail(400,'GOVERNANCE_JSON_INVALID');}}
 async handle(req:IncomingMessage,res:ServerResponse){
  const url=new URL(req.url||'/','http://localhost');if(!url.pathname.startsWith('/api/v4/governance/jobs')&&!url.pathname.startsWith('/api/v4/governance/commands/'))return false;
  let attemptedEnqueue=false,commandAcceptanceClosed=false,acceptedIdentity:{commandId:string;jobId:string}|null=null;
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(text);};
  try{await withRequestCapacity(req,res,async()=>{
   if(url.search||url.pathname.length>160)fail(400,'GOVERNANCE_ROUTE_INVALID');const auth=await this.#o.auth.capture(req),ctx=auth.context;if(ctx.tenantId!==this.#o.readBinding.tenantId||req.headers['x-tenant-id']!==ctx.tenantId)fail(403,'GOVERNANCE_TENANT_MISMATCH');if(req.headers['x-idms-actor-id']&&req.headers['x-idms-actor-id']!==ctx.actorId)fail(403,'GOVERNANCE_ACTOR_CHANGED');bindRequestTenant(ctx.tenantId);
   await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(256*1024*1024);try{
   const lookup=url.pathname.match(/^\/api\/v4\/governance\/commands\/([a-f0-9-]+)(\/cancel)?$/);if(lookup){if(!uuid(lookup[1])||!(req.method==='GET'&&!lookup[2]||req.method==='POST'&&lookup[2]))fail(400,'GOVERNANCE_COMMAND_ID');
    if(req.method==='POST'){const body=await this.#body(req,4096);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)fail(400,'GOVERNANCE_EMPTY_BODY_REQUIRED');await authorizeGovernanceJobV4(this.#o.readAccount,this.#o.readBinding,{action:'IMPORT_CREATE',input:{}},ctx,null,{cancel:true});let closed;try{closed=await this.#o.queue.closeCommand(ctx.actorId,lookup[1]);}catch(e){if(!(e instanceof GovernanceQueueCommitUnknownV4)||!await this.#o.queue.commandClosed(ctx.actorId,lookup[1]))throw e;closed={commandId:lookup[1],acceptanceClosed:true,job:await this.#o.queue.find(ctx.actorId,lookup[1])};}let job=closed.job;if(job&&!['COMMITTED','FAILED','CANCELLED'].includes(job.status)){const revision=String(BigInt(job.grantRevision)+1n);job=await this.#o.queue.authorize(job,this.#o.crypto.seal(auth.reference,job,'GRANT',revision),auth.referenceUntil,true);}send(202,{commandId:lookup[1],acceptanceClosed:true,job:job?await this.#present(job,ctx,true):null});return;}
    const existing=await this.#o.queue.find(ctx.actorId,lookup[1]);if(!existing){await authorizeGovernanceJobV4(this.#o.readAccount,this.#o.readBinding,{action:'IMPORT_CREATE',input:{}},ctx,null,{cancel:true});if(await this.#o.queue.commandClosed(ctx.actorId,lookup[1])){send(200,{commandId:lookup[1],acceptanceClosed:true,job:null});return;}fail(404,'GOVERNANCE_JOB_NOT_FOUND');}send(200,{job:await this.#present(existing,ctx,existing.cancelRequested)});return;}
   if(url.pathname==='/api/v4/governance/jobs'&&req.method==='POST'){
    const body=await this.#body(req);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='command,commandId'||!uuid(body.commandId))fail(400,'GOVERNANCE_COMMAND_ID');const {command,legacyRequestHash}=await normalizeGovernanceConsoleInputV4(body.command),requestHash=canonicalDigest(command),existing=await this.#o.queue.find(ctx.actorId,body.commandId);
    if(!existing&&await this.#o.queue.commandClosed(ctx.actorId,body.commandId)){await authorizeGovernanceJobV4(this.#o.readAccount,this.#o.readBinding,{action:'IMPORT_CREATE',input:{}},ctx,null,{cancel:true});commandAcceptanceClosed=true;fail(409,'CONSOLE_COMMAND_ACCEPTANCE_CLOSED');}
    if(existing){acceptedIdentity={commandId:existing.commandId,jobId:existing.id};await this.#access(existing,ctx);if(existing.requestHash!==requestHash&&existing.requestHash!==legacyRequestHash)fail(409,'GOVERNANCE_COMMAND_CONFLICT');send(202,{accepted:true,job:await this.#present(existing,ctx)});return;}
    await authorizeGovernanceJobV4(this.#o.readAccount,this.#o.readBinding,command,ctx);const meta={id:randomUUID(),actorId:ctx.actorId,commandId:body.commandId,requestHash};let job:GovernanceJobV4;
    try{attemptedEnqueue=true;job=await this.#o.queue.enqueue(ctx.actorId,meta.id,meta.commandId,command.action,requestHash,this.#o.crypto.seal(command,meta,'COMMAND'),this.#o.crypto.seal(auth.reference,meta,'GRANT'),auth.referenceUntil);}catch(e){if((e as Error).message==='CONSOLE_COMMAND_ACCEPTANCE_CLOSED'&&await this.#o.queue.commandClosed(ctx.actorId,meta.commandId)){commandAcceptanceClosed=true;fail(409,'CONSOLE_COMMAND_ACCEPTANCE_CLOSED');}if(!(e instanceof GovernanceQueueCommitUnknownV4))throw e;const known=await this.#o.queue.find(ctx.actorId,meta.commandId);if(!known||known.requestHash!==requestHash)throw e;job=known;}
    acceptedIdentity={commandId:job.commandId,jobId:job.id};
    // A successful durable enqueue is sufficient for acceptance; full business work is asynchronous.
    await this.#access(job,ctx);send(202,{accepted:true,job:await this.#present(job,ctx)});return;
   }
   const match=url.pathname.match(/^\/api\/v4\/governance\/jobs\/([a-f0-9-]+)(?:\/(authorize|cancel))?$/);if(!match||!uuid(match[1])||!(req.method==='GET'&&!match[2]||req.method==='POST'&&match[2]))fail(404,'GOVERNANCE_ROUTE_NOT_FOUND');let job=await this.#o.queue.read(ctx.actorId,match[1]);if(!job)fail(404,'GOVERNANCE_JOB_NOT_FOUND');const cancel=match[2]==='cancel'||req.method==='GET'&&job.cancelRequested;await this.#access(job,ctx,cancel);
   if(req.method==='POST'){
    const body=await this.#body(req,4096);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)fail(400,'GOVERNANCE_EMPTY_BODY_REQUIRED');const revision=String(BigInt(job.grantRevision)+1n),sealed=this.#o.crypto.seal(auth.reference,job,'GRANT',revision);job=await this.#o.queue.authorize(job,sealed,auth.referenceUntil,cancel);
   }
   send(req.method==='POST'?202:200,{job:await this.#present(job,ctx,cancel)});
   }finally{release();}}),requestSignal());
  });}catch(e){if(res.headersSent){res.destroy();return true;}const status=e instanceof DomainError?e.status:e instanceof GovernanceQueueCommitUnknownV4?503:503;const message=e instanceof DomainError?e.message:e instanceof GovernanceQueueCommitUnknownV4?'GOVERNANCE_QUEUE_COMMIT_UNKNOWN':'GOVERNANCE_UNAVAILABLE';send(status,{error:message,...(url.pathname==='/api/v4/governance/jobs'&&req.method==='POST'?{acceptance:commandAcceptanceClosed?{attempt:'CLOSED'}:acceptedIdentity?{attempt:'ACCEPTED',...(acceptedIdentity as {commandId:string;jobId:string})}:{attempt:attemptedEnqueue?'UNKNOWN':'NOT_ENQUEUED'}}:{})});}return true;
 }
}
