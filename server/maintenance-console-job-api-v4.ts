import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {AccessContext} from './access.ts';
import {MaintenanceJobStoreV4,MaintenanceQueueCommitUnknownV4,type MaintenanceQueueJobV4} from './maintenance-job-store-v4.ts';
import {MaintenanceJobCryptoV4} from './maintenance-job-crypto-v4.ts';
import {MaintenanceFlowStoreV4} from './maintenance-flow-store-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {MaintenanceConsoleReadV4} from './maintenance-console-read-v4.ts';
import {maintenanceCommandAccessV4,type MaintenanceCommandV4} from './maintenance-map-v4.ts';
import {openMaintenanceCommandV4} from './maintenance-command-worker-v4.ts';
import {verifyMaintenanceCompletionV4} from './maintenance-job-proof-v4.ts';
import {canonicalDigest} from './canonical-state.ts';
import {withRequestCapacity,readRequestBytes,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal} from './capacity.ts';
import {DomainError} from './service.ts';
function fail(status:number,code:string):never{throw new DomainError(status,code);}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const terminal=(j:MaintenanceQueueJobV4)=>['COMMITTED','CANCELLED','FAILED'].includes(j.status);
export interface MaintenanceJobApiOptionsV4 {queue:MaintenanceJobStoreV4;crypto:MaintenanceJobCryptoV4;auth:GovernanceJobAuthV4;read:MaintenanceConsoleReadV4;readAccount:ClientConfig;readBinding:StateMapBinding}
/** This HTTP process owns QI and READER, never the business APP connection. */
export class MaintenanceConsoleJobApiV4 {
 #o:MaintenanceJobApiOptionsV4;
 constructor(o:MaintenanceJobApiOptionsV4){this.#o=o;}
 async #access(j:MaintenanceQueueJobV4,ctx:AccessContext,cancel=false){if(j.actorId!==ctx.actorId||j.tenantId!==ctx.tenantId)fail(404,'MAINTENANCE_JOB_NOT_FOUND');const command=openMaintenanceCommandV4(j,this.#o.crypto);if(!cancel)maintenanceCommandAccessV4(command,ctx);await this.#o.read.detail(command.id,ctx);return command;}
 async #present(j:MaintenanceQueueJobV4,ctx:AccessContext,cancel=false){const command=await this.#access(j,ctx,cancel),proof=await verifyMaintenanceCompletionV4(this.#o.readAccount,this.#o.readBinding,j);if(proof&&proof.result.id!==command.id)fail(503,'MAINTENANCE_COMPLETION_ORDER');return {id:j.id,commandId:j.commandId,action:j.action,status:j.status,recovering:j.status==='RUNNING'&&!j.leaseLive,cancelRequested:j.cancelRequested,attempts:j.attempts,errorCode:j.errorCode,businessCommitted:j.status==='COMMITTED',result:proof&&!cancel?proof.result:null,failure:j.status==='FAILED'&&!cancel?j.result:null,createdAt:j.createdAt,updatedAt:j.updatedAt};}
 async #body(req:IncomingMessage,max=128*1024){if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail(415,'MAINTENANCE_JSON_REQUIRED');const bytes=await readRequestBytes(req,max);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail(400,'MAINTENANCE_JSON_INVALID');}}
 async #empty(req:IncomingMessage){const v=await this.#body(req,4096);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length)fail(400,'MAINTENANCE_EMPTY_BODY');}
 async handle(req:IncomingMessage,res:ServerResponse){const url=new URL(req.url||'/','http://localhost');if(!/^\/api\/v4\/maintenance\/(jobs|commands|flows)(?:\/|$)/.test(url.pathname))return false;
  let attempted=false,closed=false,accepted:{commandId:string;jobId:string}|null=null;
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>2*1024*1024)fail(503,'MAINTENANCE_RESPONSE_BUDGET');reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(text);};
  try{await withRequestCapacity(req,res,async()=>{
   if(url.search||url.pathname.length>180)fail(400,'MAINTENANCE_ROUTE');const auth=await this.#o.auth.capture(req),ctx=auth.context;if(req.headers['x-tenant-id']!==ctx.tenantId||ctx.tenantId!==this.#o.readBinding.tenantId)fail(403,'MAINTENANCE_TENANT');if(req.headers['x-idms-actor-id']&&req.headers['x-idms-actor-id']!==ctx.actorId)fail(403,'MAINTENANCE_ACTOR_CHANGED');bindRequestTenant(ctx.tenantId);
   await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(32*1024*1024);try{
    const lookup=url.pathname.match(/^\/api\/v4\/maintenance\/commands\/([a-f0-9-]+)(\/cancel)?$/);
    if(lookup){if(!uuid(lookup[1])||!(req.method==='GET'&&!lookup[2]||req.method==='POST'&&lookup[2]))fail(400,'MAINTENANCE_COMMAND_ID');
     if(req.method==='POST'){await this.#empty(req);await this.#o.read.context(ctx);let value;try{value=await this.#o.queue.closeCommand(ctx.actorId,lookup[1]);}catch(e){if(!(e instanceof MaintenanceQueueCommitUnknownV4)||!await this.#o.queue.commandClosed(ctx.actorId,lookup[1]))throw e;value={commandId:lookup[1],acceptanceClosed:true,job:await this.#o.queue.find(ctx.actorId,lookup[1])};}let j=value.job;if(j&&!terminal(j)){await this.#access(j,ctx,true);const revision=String(BigInt(j.grantRevision)+1n);j=await this.#o.queue.authorize(j,this.#o.crypto.seal(auth.reference,j,'GRANT',revision),auth.referenceUntil,true);}send(202,{commandId:lookup[1],acceptanceClosed:true,job:j?await this.#present(j,ctx,true):null});return;}
     const j=await this.#o.queue.find(ctx.actorId,lookup[1]);if(j){send(200,{job:await this.#present(j,ctx,j.cancelRequested)});return;}await this.#o.read.context(ctx);if(await this.#o.queue.commandClosed(ctx.actorId,lookup[1])){send(200,{commandId:lookup[1],acceptanceClosed:true,job:null});return;}fail(404,'MAINTENANCE_JOB_NOT_FOUND');
    }
    if(url.pathname==='/api/v4/maintenance/jobs'&&req.method==='POST'){
     const b=await this.#body(req);if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='command,commandId'||!uuid(b.commandId))fail(400,'MAINTENANCE_COMMAND_ID');const command=b.command as MaintenanceCommandV4;maintenanceCommandAccessV4(command,ctx);const requestHash=canonicalDigest(command),existing=await this.#o.queue.find(ctx.actorId,b.commandId);
     if(existing){accepted={commandId:existing.commandId,jobId:existing.id};await this.#access(existing,ctx);if(existing.requestHash!==requestHash)fail(409,'MAINTENANCE_COMMAND_CONFLICT');send(202,{accepted:true,job:await this.#present(existing,ctx)});return;}
     if(await this.#o.queue.commandClosed(ctx.actorId,b.commandId)){await this.#o.read.context(ctx);closed=true;fail(409,'MAINTENANCE_COMMAND_ACCEPTANCE_CLOSED');}await this.#o.read.detail(command.id,ctx);
     const meta={id:randomUUID(),actorId:ctx.actorId,commandId:b.commandId,requestHash};let j:MaintenanceQueueJobV4;
     try{attempted=true;j=await this.#o.queue.enqueue(ctx.actorId,meta.id,meta.commandId,command.action,requestHash,this.#o.crypto.seal(command,meta,'COMMAND'),this.#o.crypto.seal(auth.reference,meta,'GRANT'),auth.referenceUntil);}catch(e){if((e as Error).message==='MAINTENANCE_COMMAND_ACCEPTANCE_CLOSED'&&await this.#o.queue.commandClosed(ctx.actorId,meta.commandId)){closed=true;fail(409,'MAINTENANCE_COMMAND_ACCEPTANCE_CLOSED');}if(!(e instanceof MaintenanceQueueCommitUnknownV4))throw e;const found=await this.#o.queue.find(ctx.actorId,meta.commandId);if(!found||found.requestHash!==requestHash)throw e;j=found;}
     accepted={commandId:j.commandId,jobId:j.id};send(202,{accepted:true,job:await this.#present(j,ctx)});return;
    }
    const flow=url.pathname.match(/^\/api\/v4\/maintenance\/flows\/([a-f0-9-]+)(\/authorize)?$/);
    if(flow){if(!uuid(flow[1])||!(req.method==='GET'&&!flow[2]||req.method==='POST'&&flow[2]))fail(400,'MAINTENANCE_FLOW_ROUTE');const flows=new MaintenanceFlowStoreV4(this.#o.queue),g=await flows.read(flow[1],ctx.actorId);if(!g)fail(404,'MAINTENANCE_FLOW_NOT_FOUND');const command=await this.#access(g.job,ctx),{item}=await this.#o.read.detail(command.id,ctx);if(item.workflow?.commandId!==g.commandId||!['PENDING','HUMAN_REVIEW'].includes(item.workflow.status))fail(409,'MAINTENANCE_FLOW_CHANGED');
     if(req.method==='POST'){await this.#empty(req);const revision=String(BigInt(g.revision)+1n);await flows.authorize(g,this.#o.crypto.seal(auth.reference,g.job,'GRANT',revision),auth.referenceUntil);send(202,{commandId:g.commandId,authorized:true,revision});return;}send(200,{commandId:g.commandId,waitingAuth:g.waitingAuth,revision:g.revision,ready:g.ready});return;
    }
    const match=url.pathname.match(/^\/api\/v4\/maintenance\/jobs\/([a-f0-9-]+)(?:\/(authorize|cancel))?$/);if(!match||!uuid(match[1])||!(req.method==='GET'&&!match[2]||req.method==='POST'&&match[2]))fail(404,'MAINTENANCE_ROUTE_NOT_FOUND');let j=await this.#o.queue.read(ctx.actorId,match[1]);if(!j)fail(404,'MAINTENANCE_JOB_NOT_FOUND');const cancel=match[2]==='cancel'||req.method==='GET'&&j.cancelRequested;await this.#access(j,ctx,cancel);
    if(req.method==='POST'){await this.#empty(req);if(!terminal(j)){const revision=String(BigInt(j.grantRevision)+1n);j=await this.#o.queue.authorize(j,this.#o.crypto.seal(auth.reference,j,'GRANT',revision),auth.referenceUntil,cancel);}}send(req.method==='POST'?202:200,{job:await this.#present(j,ctx,cancel)});
   }finally{release();}}),requestSignal());
  });}catch(e){if(res.headersSent){res.destroy();return true;}send(e instanceof DomainError?e.status:503,{error:e instanceof DomainError?e.message:e instanceof MaintenanceQueueCommitUnknownV4?'MAINTENANCE_COMMIT_UNKNOWN':'MAINTENANCE_UNAVAILABLE',...(url.pathname==='/api/v4/maintenance/jobs'&&req.method==='POST'?{acceptance:closed?{attempt:'CLOSED'}:accepted?{attempt:'ACCEPTED',...(accepted as {commandId:string;jobId:string})}:{attempt:attempted?'UNKNOWN':'NOT_ENQUEUED'}}:{})});}return true;
 }
}
