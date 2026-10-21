import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {AccessContext} from './access.ts';
import {requireAccess,scopeAllows,permissionsFor} from './access.ts';
import type {createAuth} from './auth.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {PredictiveJobStoreV4,PredictiveQueueCommitUnknownV4,type PredictiveQueueJobV4} from './predictive-job-store-v4.ts';
import {PredictiveJobCryptoV4} from './predictive-job-crypto-v4.ts';
import {openPredictiveCommandV4} from './predictive-command-worker-v4.ts';
import {predictiveAnalysisRequestV4} from './predictive-input-v4.ts';
import {predictiveReviewRequestV4} from './predictive-map-v4.ts';
import {predictiveFormatV4} from './predictive-state-v4.ts';
import {DomainReadSnapshotV4} from './domain-read-snapshot-v4.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {readAssetKey,readCatalogFormat} from './domain-read-catalog-v4.ts';
import {verifyLocalDomainAudit,auditPositionKey} from './telemetry-map-v4.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {DomainError} from './service.ts';
import {withRequestCapacity,readRequestBytes,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal} from './capacity.ts';
function fail(status:number,code:string):never{throw new DomainError(status,code);}
function need(v:unknown,code='PREDICTIVE_READ_INTEGRITY'):asserts v{if(!v)fail(503,code);}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
type Command=ReturnType<typeof predictiveAnalysisRequestV4>|ReturnType<typeof predictiveReviewRequestV4>;
export class PredictiveConsoleReadV4 {
 #account:ClientConfig;#binding:StateMapBinding;
 constructor(account:ClientConfig,binding:StateMapBinding){this.#account={...account};this.#binding={...binding};}
 async #entity(s:DomainReadSnapshotV4,collection:string,id:string){const key=domainEntityKey(collection,{id}),p=await s.state('v4_entity',key);if(!p.present)return null;const row=JSON.parse(await decodeLegacyText('v4_entity',key,(ns,k)=>s.get(ns,k)));need(row.id===id&&(collection==='business/tenants'?row.id===s.tenantId:row.tenantId===s.tenantId));return row;}
 async #open(ctx:AccessContext){domainReadAccessV4(ctx);if(ctx.tenantId!==this.#binding.tenantId)fail(404,'PREDICTIVE_NOT_FOUND');const s=await DomainReadSnapshotV4.open(this.#account,this.#binding);try{
  const control=await s.get<any>('domain_head','control'),catalog=await s.get<any>('domain_head','read_catalog'),marker=await s.get<any>('domain_head','predictive'),tenant=await this.#entity(s,'business/tenants',ctx.tenantId);
  need(control.tenantId===ctx.tenantId&&['ACTIVE','PAUSED','UPDATING'].includes(control.status)&&catalog.format===readCatalogFormat&&catalog.tenantId===ctx.tenantId&&catalog.governanceAnchorDigest===control.governanceAnchorDigest&&marker.format===predictiveFormatV4&&marker.tenantId===ctx.tenantId);
  if(tenant?.status!=='ACTIVE')fail(403,'PREDICTIVE_TENANT_INACTIVE');return {s,control,catalog,tenant};
 }catch(e){await s.close();throw e;}}
 async context(ctx:AccessContext){const {s,control,tenant}=await this.#open(ctx);try{return {tenant:{id:tenant.id,name:tenant.name},phase:control.status,permissions:permissionsFor(ctx.roles||[])};}finally{await s.close();}}
 async access(command:Command,ctx:AccessContext,mode:'COMMAND'|'RETRY'='COMMAND'){requireAccess(ctx,mode==='RETRY'?'predictive:approve':command.kind==='ANALYZE'?'analyze':'predictive:approve');const {s,control,catalog}=await this.#open(ctx);try{
  if(control.status!=='ACTIVE')fail(409,'PREDICTIVE_FENCED');let device:string;
  if(command.kind==='ANALYZE')device=command.deviceCode;
  else{const alert=await this.#entity(s,'business/predictiveAlerts',command.alertId);if(!alert)fail(404,'PREDICTIVE_ALERT_NOT_FOUND');device=alert.deviceCode;const episode=await s.state('predictive_episode',command.alertId);if(!episode.present)fail(409,'PREDICTIVE_LEGACY_EPISODE_RECONCILIATION_REQUIRED');need((episode.value as any).tenantId===ctx.tenantId);if(mode!=='RETRY'&&(episode.value as any).requestedBy===ctx.actorId)fail(403,'PREDICTIVE_INDEPENDENT_REVIEW_REQUIRED');}
  const key=readAssetKey(catalog.generation,device),p=await s.state('blob',key);if(!p.present)fail(404,'PREDICTIVE_ASSET_REQUIRED');const asset=JSON.parse(await decodeLegacyText('blob',key,(ns,k)=>s.get(ns,k)));need(asset.tenantId===ctx.tenantId&&asset.deviceCode===device&&asset.scope.device_code===device);if(!scopeAllows(ctx,asset.scope))fail(403,'PREDICTIVE_DEVICE_SCOPE');return {deviceCode:device};
 }finally{await s.close();}}
 async cancellation(job:PredictiveQueueJobV4){if(job.status!=='CANCELLED')return null;const s=await DomainReadSnapshotV4.open(this.#account,this.#binding);try{
  const p=await s.state('predictive_job',job.businessKey);if(!p.present){need(job.cancelRequested&&!job.externalStarted,'PREDICTIVE_CANCEL_BOUNDARY');return {sdkPrepared:false};}const sdk=p.value as any,r=await s.get<any>('receipt','predictive_cancel:'+job.businessKey);need(job.cancelRequested&&!job.externalStarted&&sdk.status==='CANCELLED'&&sdk.tenantId===job.tenantId&&sdk.actorId===job.actorId&&sdk.commandId===job.commandId&&r.format===predictiveFormatV4&&r.tenantId===job.tenantId&&r.key===job.businessKey&&r.commandId===job.commandId&&r.requestHash===job.requestHash&&r.planDigest===sdk.planDigest,'PREDICTIVE_CANCEL_RECEIPT');const a=verifyLocalDomainAudit(await s.get<any>('audit',r.auditEventId),job.tenantId),o=await s.get<any>('audit_order',auditPositionKey(r.auditPosition));need(a.hash===r.auditHash&&a.eventId===o.eventId&&o.tenantId===job.tenantId&&o.position===r.auditPosition&&a.actorId===job.actorId&&a.action==='PREDICTIVE_COMMAND_CANCELLED'&&a.metadata.commandId===job.commandId&&a.metadata.jobKey===job.businessKey,'PREDICTIVE_CANCEL_AUDIT');return {sdkPrepared:true,auditEventId:a.eventId};
 }finally{await s.close();}}
 async retryProof(job:PredictiveQueueJobV4){if(!job.retryId||job.retryPending)return false;const s=await DomainReadSnapshotV4.open(this.#account,this.#binding);try{const p=await s.state('receipt','predictive_retry:'+job.businessKey+':'+job.retryId);if(!p.present)return false;const r=p.value as any,sdk=await s.get<any>('predictive_job',job.businessKey);need(r.format===predictiveFormatV4&&r.tenantId===job.tenantId&&r.key===job.businessKey&&r.commandId===job.commandId&&r.requestHash===job.requestHash&&r.planDigest===sdk.planDigest&&r.controlId===job.retryId&&r.originalActor===job.actorId&&r.reviewerId===job.retryActor,'PREDICTIVE_RETRY_PROOF');const a=verifyLocalDomainAudit(await s.get<any>('audit',r.auditEventId),job.tenantId),o=await s.get<any>('audit_order',auditPositionKey(r.auditPosition));need(a.hash===r.auditHash&&a.eventId===o.eventId&&o.tenantId===job.tenantId&&o.position===r.auditPosition&&a.actorId===job.retryActor&&a.action==='PREDICTIVE_RETRY_REVIEWED'&&a.metadata.commandId===job.commandId&&a.metadata.jobKey===job.businessKey&&a.metadata.controlId===job.retryId&&a.metadata.originalActor===job.actorId,'PREDICTIVE_RETRY_AUDIT');return true;}finally{await s.close();}}
 async completion(job:PredictiveQueueJobV4){if(job.status!=='COMMITTED')return null;const s=await DomainReadSnapshotV4.open(this.#account,this.#binding);try{
  const sdk=await s.get<any>('predictive_job',job.businessKey),r=await s.get<any>('receipt','predictive:'+job.businessKey);
  need(sdk.format===predictiveFormatV4&&sdk.tenantId===job.tenantId&&sdk.key===job.businessKey&&sdk.actorId===job.actorId&&sdk.commandId===job.commandId&&sdk.status==='COMMITTED'&&sdk.requestHash===job.requestHash&&r.format===predictiveFormatV4&&r.tenantId===job.tenantId&&r.key===job.businessKey&&r.requestHash===job.requestHash&&r.planDigest===sdk.planDigest&&canonicalEqual(r.result,sdk.result)&&canonicalEqual(r.result,job.result),'PREDICTIVE_COMPLETION_RECEIPT');
  const a=verifyLocalDomainAudit(await s.get<any>('audit',r.auditEventId),job.tenantId),p=await s.get<any>('audit_order',auditPositionKey(r.auditPosition));
  need(a.hash===r.auditHash&&p.tenantId===job.tenantId&&p.position===r.auditPosition&&p.eventId===a.eventId&&a.metadata.commandId===job.commandId&&a.metadata.jobKey===job.businessKey&&(a.actorId===job.actorId||a.metadata.requestedBy===job.actorId),'PREDICTIVE_COMPLETION_AUDIT');return r.result;
 }finally{await s.close();}}
}
export function createPredictiveConsoleHttpV4(o:{auth:ReturnType<typeof createAuth>;provider:GovernanceJobAuthV4;queue:PredictiveJobStoreV4;crypto:PredictiveJobCryptoV4;read:PredictiveConsoleReadV4;tenantId:string}){
 const present=async(j:PredictiveQueueJobV4,ctx:AccessContext)=>{if(j.actorId!==ctx.actorId||j.tenantId!==ctx.tenantId)fail(404,'PREDICTIVE_JOB_NOT_FOUND');const command=openPredictiveCommandV4(j,o.crypto),target=await o.read.access(command,ctx);return {id:j.id,commandId:j.commandId,requestHash:j.requestHash,action:j.action,...target,status:j.status,attempts:j.attempts,errorCode:j.errorCode,recovering:j.status==='RUNNING'&&!j.leaseLive,externalStarted:j.externalStarted,cancelRequested:j.cancelRequested,businessCommitted:j.status==='COMMITTED',result:await o.read.completion(j),cancellation:await o.read.cancellation(j),retry:{id:j.retryId,actorId:j.retryActor,pending:j.retryPending,reviewed:await o.read.retryProof(j)},failure:j.status==='FAILED'?j.result:null,createdAt:j.createdAt,updatedAt:j.updatedAt};};
 return async(req:IncomingMessage,res:ServerResponse)=>{
  let attempted=false,closed=false,accepted:{commandId:string;jobId:string}|undefined;
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>2*1024*1024)fail(503,'PREDICTIVE_RESPONSE_BUDGET');reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);};
  const body=async()=>{if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail(415,'PREDICTIVE_JSON_REQUIRED');const bytes=await readRequestBytes(req,128*1024);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail(400,'PREDICTIVE_JSON_INVALID');}};
  try{
   res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
   if((req.url?.length||0)>8192)fail(400,'PREDICTIVE_ROUTE');const url=new URL(req.url||'/','http://localhost');if(await o.auth.handle(req,res,url))return;
   if(url.search||url.pathname.length>180||!url.pathname.startsWith('/api/v4/predictive/'))fail(404,'PREDICTIVE_NOT_FOUND');
   await withRequestCapacity(req,res,async()=>{const auth=await o.provider.capture(req),ctx=auth.context;if(ctx.tenantId!==o.tenantId||req.headers['x-tenant-id']!==ctx.tenantId)fail(403,'PREDICTIVE_TENANT');if(req.headers['x-idms-actor-id']&&req.headers['x-idms-actor-id']!==ctx.actorId)fail(403,'PREDICTIVE_ACTOR_CHANGED');bindRequestTenant(ctx.tenantId);
    await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(32*1024*1024);try{
     if(url.pathname==='/api/v4/predictive/context'&&req.method==='GET'){send(200,await o.read.context(ctx));return;}
     const retryRoute=url.pathname.match(/^\/api\/v4\/predictive\/(retry-candidates|jobs)\/([a-f0-9-]+)(\/retry)?$/);
     if(retryRoute&&(req.method==='GET'&&retryRoute[1]==='retry-candidates'&&!retryRoute[3]||req.method==='POST'&&retryRoute[1]==='jobs'&&retryRoute[3])){
      if(!uuid(retryRoute[2]))fail(400,'PREDICTIVE_JOB_ID');requireAccess(ctx,'predictive:approve');let job=await o.queue.reviewCandidate(retryRoute[2]);if(!job)fail(404,'PREDICTIVE_RETRY_NOT_FOUND');if(job.actorId===ctx.actorId)fail(403,'PREDICTIVE_INDEPENDENT_RETRY_REQUIRED');await o.read.access(openPredictiveCommandV4(job,o.crypto),ctx,'RETRY');
      if(req.method==='POST'){const b=await body();if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='controlId,expectedGrantRevision'||!uuid(b.controlId)||typeof b.expectedGrantRevision!=='string'||!/^[1-9][0-9]*$/.test(b.expectedGrantRevision))fail(400,'PREDICTIVE_RETRY_INPUT');try{job=await o.queue.requestRetry({...job,grantRevision:b.expectedGrantRevision},b.controlId,ctx.actorId,o.crypto.seal(auth.reference,job,'RETRY',b.controlId),auth.referenceUntil);}catch(e){if(!(e instanceof PredictiveQueueCommitUnknownV4))throw e;const recovered=await o.queue.reviewCandidate(job.id);if(!recovered||recovered.retryId!==b.controlId||recovered.retryActor!==ctx.actorId)throw e;job=recovered;}}
      send(req.method==='POST'?202:200,{jobId:job.id,commandId:job.commandId,originalActorId:job.actorId,grantRevision:job.grantRevision,status:job.status,retry:{id:job.retryId,actorId:job.retryActor,pending:job.retryPending,reviewed:await o.read.retryProof(job)}});return;
     }
     const closeRoute=url.pathname.match(/^\/api\/v4\/predictive\/commands\/([a-f0-9-]+)\/cancel$/);
     if(closeRoute&&req.method==='POST'){
      if(!uuid(closeRoute[1]))fail(400,'PREDICTIVE_COMMAND_ID');const b=await body();if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length)fail(400,'PREDICTIVE_EMPTY_BODY');const prior=await o.queue.find(ctx.actorId,closeRoute[1]);if(prior)await o.read.access(openPredictiveCommandV4(prior,o.crypto),ctx);else await o.read.context(ctx);let result;
      try{result=await o.queue.closeCommand(ctx.actorId,closeRoute[1]);}catch(e){if(!(e instanceof PredictiveQueueCommitUnknownV4)||!await o.queue.commandClosed(ctx.actorId,closeRoute[1]))throw e;const job=await o.queue.find(ctx.actorId,closeRoute[1]);result={commandId:closeRoute[1],acceptanceClosed:true as const,recoveryRequired:!!job?.externalStarted&&!['COMMITTED','FAILED','CANCELLED'].includes(job.status),job};}
      let job=result.job;if(job&&!result.recoveryRequired&&!['COMMITTED','FAILED','CANCELLED'].includes(job.status)){if(job.status==='HUMAN_REVIEW')fail(409,'PREDICTIVE_RETRY_REQUIRED');if(job.retryPending)fail(409,'PREDICTIVE_RETRY_CONTROL_PENDING');const revision=String(BigInt(job.grantRevision)+1n);job=await o.queue.authorize(job,o.crypto.seal(auth.reference,job,'GRANT',revision),auth.referenceUntil,true);}send(202,{commandId:closeRoute[1],acceptanceClosed:true,recoveryRequired:result.recoveryRequired,job:job?await present(job,ctx):null});return;
     }
     if(url.pathname==='/api/v4/predictive/jobs'&&req.method==='POST'){
      const b=await body();if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='command,commandId'||!uuid(b.commandId))fail(400,'PREDICTIVE_COMMAND_ID');const command=b.command?.kind==='ANALYZE'?predictiveAnalysisRequestV4(b.command):predictiveReviewRequestV4(b.command),requestHash=canonicalDigest(command);await o.read.access(command,ctx);
      if(await o.queue.commandClosed(ctx.actorId,b.commandId)){closed=true;fail(409,'PREDICTIVE_COMMAND_ACCEPTANCE_CLOSED');}
      let job=await o.queue.find(ctx.actorId,b.commandId);if(job){if(job.requestHash!==requestHash)fail(409,'PREDICTIVE_COMMAND_CONFLICT');}else{
       const meta={id:randomUUID(),actorId:ctx.actorId,commandId:b.commandId,requestHash};try{attempted=true;job=await o.queue.enqueue(ctx.actorId,meta.id,meta.commandId,command.kind,requestHash,o.crypto.seal(command,meta,'COMMAND'),o.crypto.seal(auth.reference,meta,'GRANT'),auth.referenceUntil);}catch(e){if((e as Error).message==='PREDICTIVE_COMMAND_ACCEPTANCE_CLOSED'&&await o.queue.commandClosed(ctx.actorId,b.commandId)){closed=true;fail(409,'PREDICTIVE_COMMAND_ACCEPTANCE_CLOSED');}if(!(e instanceof PredictiveQueueCommitUnknownV4))throw e;job=await o.queue.find(ctx.actorId,b.commandId);if(!job||job.requestHash!==requestHash)throw e;}
      }accepted={commandId:job.commandId,jobId:job.id};send(202,{accepted:true,job:await present(job,ctx)});return;
     }
     const lookup=url.pathname.match(/^\/api\/v4\/predictive\/commands\/([a-f0-9-]+)$/);if(lookup&&req.method==='GET'){if(!uuid(lookup[1]))fail(400,'PREDICTIVE_COMMAND_ID');const job=await o.queue.find(ctx.actorId,lookup[1]);if(!job){await o.read.context(ctx);if(await o.queue.commandClosed(ctx.actorId,lookup[1])){send(200,{commandId:lookup[1],acceptanceClosed:true,job:null});return;}fail(404,'PREDICTIVE_JOB_NOT_FOUND');}send(200,{job:await present(job,ctx)});return;}
     const route=url.pathname.match(/^\/api\/v4\/predictive\/jobs\/([a-f0-9-]+)(\/authorize)?$/);if(!route||!uuid(route[1])||!(req.method==='GET'&&!route[2]||req.method==='POST'&&route[2]))fail(404,'PREDICTIVE_ROUTE');let job=await o.queue.read(ctx.actorId,route[1]);if(!job)fail(404,'PREDICTIVE_JOB_NOT_FOUND');await o.read.access(openPredictiveCommandV4(job,o.crypto),ctx);
     if(req.method==='POST'){const b=await body();if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length)fail(400,'PREDICTIVE_EMPTY_BODY');if(!['COMMITTED','FAILED','CANCELLED'].includes(job.status)){if(job.status==='HUMAN_REVIEW')fail(409,'PREDICTIVE_RETRY_REQUIRED');if(job.retryPending)fail(409,'PREDICTIVE_RETRY_CONTROL_PENDING');const revision=String(BigInt(job.grantRevision)+1n);job=await o.queue.authorize(job,o.crypto.seal(auth.reference,job,'GRANT',revision),auth.referenceUntil);}}send(req.method==='POST'?202:200,{job:await present(job,ctx)});
    }finally{release();}}),requestSignal());
   });
  }catch(e){if(res.headersSent){res.destroy();return;}const known=/^PREDICTIVE_(?:RETRY_CONFLICT|RETRY_SUPERSEDED|RETRY_REQUIRED|RETRY_CONTROL_PENDING|QUEUE_GRANT_CONFLICT|CREATION_RECOVERY_REQUIRED)$/.test((e as Error).message);send(e instanceof DomainError?e.status:known?409:503,{error:e instanceof DomainError?e.message:known?(e as Error).message:e instanceof PredictiveQueueCommitUnknownV4?'PREDICTIVE_COMMIT_UNKNOWN':'PREDICTIVE_UNAVAILABLE',...(req.method==='POST'&&req.url==='/api/v4/predictive/jobs'?{acceptance:accepted?{attempt:'ACCEPTED',...accepted}:{attempt:closed?'CLOSED':attempted?'UNKNOWN':'NOT_ENQUEUED'}}:{})});}
 };
}
