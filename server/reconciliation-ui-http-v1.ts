import type {IncomingMessage,ServerResponse} from 'node:http';
import {ReconciliationUiReadV1} from './reconciliation-ui-read-v1.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {PredictiveReconciliationAuthV1} from './predictive-reconciliation-auth-v1.ts';
import {CancelQueueCommitUnknownV1} from './predictive-cancel-job-store-v1.ts';
import {cancelJobCommandV1,cancelJobHashesV1} from './predictive-cancel-job-input-v1.ts';
import {cancelFailV1 as fail,cancelUuidV1 as uuid,cancelHashV1 as hash,cancelOrdinalV1 as ordinal} from './predictive-cancel-contract-v1.ts';
import {withRequestCapacity,readRequestBytes,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,sqlScheduler,requestSignal} from './capacity.ts';
import {DomainError} from './service.ts';
const exact=(v:any,fields:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...fields].sort().join(',');
export function createReconciliationUiHttpV1(o:{read:ReconciliationUiReadV1;provider:GovernanceJobAuthV4;sessionAuth:PredictiveReconciliationAuthV1}){
 const tenant=o.read.read.binding.tenantId;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const url=new URL(req.url||'/','http://localhost');if(!url.pathname.startsWith('/api/v4/reconciliation-ui/'))return false;
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(text);};
  try{await withRequestCapacity(req,res,()=>memoryTask(()=>sqlScheduler.run(tenant,async()=>{
   if(url.pathname.length>200)fail(400,'RECON_UI_ROUTE');const captured=await o.provider.capture(req),grant=o.sessionAuth.grant(captured.reference),live=await grant.current(),actor=live.context.actorId;if(live.context.tenantId!==tenant||req.headers['x-tenant-id']!==tenant||req.headers['x-idms-actor-id']!==actor)fail(403,'RECON_UI_IDENTITY_CHANGED');bindRequestTenant(tenant);
   const fresh=async()=>{const current=await grant.current();if(current.identityHash!==live.identityHash||current.sessionHash!==live.sessionHash||live.deadline<=Date.now())fail(403,'RECON_UI_IDENTITY_CHANGED');},body=async()=>{if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail(415,'RECON_UI_JSON_REQUIRED');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readRequestBytes(req,4096)));}catch(e){if(e instanceof DomainError)throw e;fail(400,'RECON_UI_JSON_INVALID');}};
   if(req.method==='GET'&&url.pathname==='/api/v4/reconciliation-ui/cases'){const value=await o.read.page(url.searchParams,'CASES',grant);await fresh();send(200,value);return;}
   if(req.method==='GET'&&url.pathname==='/api/v4/reconciliation-ui/mine'){const value=await o.read.page(url.searchParams,'MINE',grant);await fresh();send(200,value);return;}
   if(url.search)fail(400,'RECON_UI_QUERY');
   if(req.method==='GET'&&url.pathname==='/api/v4/reconciliation-ui/context'){const value=await o.read.context(grant);await fresh();send(200,value);return;}
   const native=url.pathname.match(/^\/api\/v4\/reconciliation-ui\/native\/([a-f0-9-]+)$/);if(req.method==='GET'&&native&&uuid(native[1])){const value=await o.read.lookup(native[1],grant);await fresh();send(200,value);return;}
   const detail=url.pathname.match(/^\/api\/v4\/reconciliation-ui\/cases\/([a-f0-9-]+)$/);if(req.method==='GET'&&detail&&uuid(detail[1])){const value=await o.read.detail(detail[1],grant);await fresh();send(200,value);return;}
   const action=url.pathname.match(/^\/api\/v4\/reconciliation-ui\/actions\/([a-f0-9-]+)\/([a-f0-9-]+)$/);if(req.method==='GET'&&action&&uuid(action[1])&&uuid(action[2])){const job=await o.read.queue.base.read(actor,action[1],action[2]);if(!job)return fail(404,'RECON_UI_JOB_NOT_FOUND');const value=await o.read.job(job,grant);await fresh();send(200,{job:value});return;}
   const auth=url.pathname.match(/^\/api\/v4\/reconciliation-ui\/authorizations\/([a-f0-9-]+)$/);if(req.method==='GET'&&auth&&uuid(auth[1])){const value=await o.read.queue.authorization(actor,auth[1]);if(!value)return fail(404,'RECON_UI_AUTHORIZATION_NOT_FOUND');const job=await o.read.job(value.job,grant);await fresh();send(200,{...value,job});return;}
   if(req.method==='POST'&&url.pathname==='/api/v4/reconciliation-ui/close-action'){
    const b=await body(),fields=['caseId','operationId','action','requestHash'];if(b?.action==='OPEN')fields.push('commandId','expectedNativeHash');if(!exact(b,fields)||![b.caseId,b.operationId].every(uuid)||!hash(b.requestHash)||!['OPEN','OBSERVE','REVIEW','CONFIRM','SETTLE'].includes(b.action))fail(400,'RECON_UI_ACTION_INPUT');
    if(b.action==='OPEN'){if(b.caseId!==b.operationId||!uuid(b.commandId)||!hash(b.expectedNativeHash))fail(400,'RECON_UI_ACTION_INPUT');const candidate=await o.read.lookup(b.commandId,grant),command=cancelJobCommandV1({action:'OPEN',caseId:b.caseId,request:{id:b.caseId,commandId:b.commandId,expectedNativeHash:b.expectedNativeHash}});if(candidate.nativeHash!==b.expectedNativeHash||cancelJobHashesV1(command).requestHash!==b.requestHash)fail(409,'RECON_UI_ACTION_CONFLICT');}
    else{const value=await o.read.detail(b.caseId,grant);if(b.action==='REVIEW'?value.original:!value.original)fail(403,'RECON_UI_ACTION_ACTOR');}
    const prior=await o.read.queue.base.read(actor,b.caseId,b.operationId);if(prior&&(prior.action!==b.action||prior.requestHash!==b.requestHash))fail(409,'RECON_UI_ACTION_CONFLICT');await fresh();let value;try{value=await o.read.queue.base.close(actor,b.caseId,b.operationId);}catch(e){if(!(e instanceof CancelQueueCommitUnknownV1))throw e;await fresh();value=await o.read.queue.base.close(actor,b.caseId,b.operationId);}if(value.job&&(value.job.action!==b.action||value.job.requestHash!==b.requestHash))fail(409,'RECON_UI_ACTION_CONFLICT');const job=value.job?await o.read.job(value.job,grant):null;await fresh();send(200,{...value,job});return;
   }
   if(req.method==='POST'&&['/api/v4/reconciliation-ui/authorize','/api/v4/reconciliation-ui/close-authorization'].includes(url.pathname)){
    const b=await body();if(!exact(b,['caseId','operationId','authorizationId','expectedGrantRevision'])||![b.caseId,b.operationId,b.authorizationId].every(uuid)||!ordinal(b.expectedGrantRevision))fail(400,'RECON_UI_AUTHORIZATION_INPUT');const job=await o.read.queue.base.read(actor,b.caseId,b.operationId);if(!job)return fail(404,'RECON_UI_JOB_NOT_FOUND');await o.read.job(job,grant);await fresh();
    if(url.pathname.endsWith('/close-authorization')){let value;try{value=await o.read.queue.closeAuthorization(actor,b.caseId,b.operationId,b.authorizationId,b.expectedGrantRevision);}catch(e){if(!(e instanceof CancelQueueCommitUnknownV1))throw e;await fresh();value=await o.read.queue.closeAuthorization(actor,b.caseId,b.operationId,b.authorizationId,b.expectedGrantRevision);}const visible=await o.read.job(value.job,grant);await fresh();send(200,{...value,job:visible});return;}
    const sealed=o.read.crypto.seal(captured.reference,job,'GRANT',String(BigInt(b.expectedGrantRevision)+1n));let result;try{result=await o.read.queue.base.authorize({...job,grantRevision:b.expectedGrantRevision},sealed,captured.referenceUntil,b.authorizationId,live.sessionHash);}catch(e){if(!(e instanceof CancelQueueCommitUnknownV1))throw e;await fresh();result=await o.read.queue.base.authorize({...job,grantRevision:b.expectedGrantRevision},sealed,captured.referenceUntil,b.authorizationId,live.sessionHash);}const visible=await o.read.job(result,grant);await fresh();send(200,{authorizationId:b.authorizationId,accepted:true,job:visible});return;
   }
   fail(404,'RECON_UI_ROUTE_NOT_FOUND');
  },requestSignal())));
  }catch(e){if(res.headersSent){res.destroy();return true;}const code=(e as Error).message,conflict=/^RECON_QUEUE_(?:ACTION_CONFLICT|AUTHORIZATION_CONFLICT|AUTHORIZATION_CLOSED|GRANT_CONFLICT|RELEASE_STARTED)$/.test(code);send(e instanceof DomainError?e.status:conflict?409:503,{error:e instanceof DomainError||conflict?code:e instanceof CancelQueueCommitUnknownV1?'RECON_UI_ACCEPTANCE_UNKNOWN':'RECON_UI_UNAVAILABLE'});}return true;
 };
}
