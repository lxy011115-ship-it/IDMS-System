import {randomUUID} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createPredictiveConsoleUiHttpV4} from './predictive-console-ui-http-v4.ts';
import {PredictiveAdoptionStoreV4,PredictiveLegacyReadV4,predictiveAdoptionUuidV4} from './predictive-legacy-adoption-v4.ts';
import {PredictiveQueueCommitUnknownV4} from './predictive-job-store-v4.ts';
import {DomainError} from './service.ts';
import {predictiveReadIdentityV4} from './predictive-read-contract-v4.ts';
import {withRequestCapacity,readRequestBytes,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal} from './capacity.ts';
function fail(status:number,code:string):never{throw new DomainError(status,code);}
export async function createPredictiveAdoptionHttpV4(o:Parameters<typeof createPredictiveConsoleUiHttpV4>[0]&{legacy:PredictiveLegacyReadV4;adoption:PredictiveAdoptionStoreV4}){
 const fallback=await createPredictiveConsoleUiHttpV4(o);
 return async(req:IncomingMessage,res:ServerResponse)=>{
  if(!req.url?.split('?')[0].startsWith('/api/v4/predictive/legacy/'))return fallback(req,res);
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>2*1024*1024)fail(503,'PREDICTIVE_RESPONSE_BUDGET');reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);};
  try{
   res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
   if(req.url.length>256)fail(400,'PREDICTIVE_ADOPTION_ROUTE');const url=new URL(req.url,'http://localhost'),match=url.pathname.match(/^\/api\/v4\/predictive\/legacy\/(commands|adoptions)\/([a-f0-9-]+)(\/adopt)?$/);if(!match||!predictiveAdoptionUuidV4(match[2])||url.search||!(req.method==='GET'&&!match[3]||req.method==='POST'&&match[1]==='commands'&&match[3]))fail(404,'PREDICTIVE_ADOPTION_ROUTE');
   await withRequestCapacity(req,res,async()=>{const captured=await o.provider.capture(req),ctx=captured.context;if(ctx.tenantId!==o.tenantId||req.headers['x-tenant-id']!==ctx.tenantId||req.headers['x-idms-actor-id']!==ctx.actorId)fail(403,'PREDICTIVE_ADOPTION_ACTOR');bindRequestTenant(ctx.tenantId);
    await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(32*1024*1024);try{
     const present=async(control:NonNullable<Awaited<ReturnType<PredictiveAdoptionStoreV4['read']>>>)=>{if(control.superseded)fail(409,'PREDICTIVE_ADOPTION_SUPERSEDED');const {job}=control,proof=await o.legacy.proof(job,ctx);return {controlId:control.controlId,commandId:job.commandId,jobId:job.id,status:job.status,grantRevision:job.grantRevision,externalStarted:job.externalStarted,cancelRequested:job.cancelRequested,errorCode:job.errorCode,businessCommitted:job.status==='COMMITTED',...proof};};
     const fresh=async()=>{if(predictiveReadIdentityV4(await o.auth.context(req))!==predictiveReadIdentityV4(ctx))fail(409,'PREDICTIVE_IDENTITY_CHANGED');};
     if(match[1]==='adoptions'){const control=await o.adoption.read(ctx.actorId,match[2]);if(!control)fail(404,'PREDICTIVE_ADOPTION_NOT_FOUND');const result=await present(control);await fresh();send(200,result);return;}
     if(req.method==='GET'){const c=await o.legacy.candidate(match[2],ctx);await fresh();send(200,{commandId:c.job.commandId,actorId:c.job.actorId,action:c.job.action,deviceCode:c.deviceCode,nativeHash:c.pins.nativeHash,nativeStatus:c.job.status,requiresIndependentRetry:c.job.status==='HUMAN_REVIEW',externalCreationMayHaveStarted:c.pins.externalPossible,alreadyBound:c.host.present});return;}
     if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail(415,'PREDICTIVE_JSON_REQUIRED');let b:any;try{b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readRequestBytes(req,4096)));}catch{fail(400,'PREDICTIVE_JSON_INVALID');}
     if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='adoptionId,expectedNativeHash,recoverClosedAcceptance'||!predictiveAdoptionUuidV4(b.adoptionId)||typeof b.expectedNativeHash!=='string'||!/^[a-f0-9]{64}$/.test(b.expectedNativeHash)||typeof b.recoverClosedAcceptance!=='boolean')fail(400,'PREDICTIVE_ADOPTION_INPUT');
     const replay=await o.adoption.read(ctx.actorId,b.adoptionId);if(replay){if(replay.commandId!==match[2]||replay.nativeHash!==b.expectedNativeHash||replay.recoverClosedAcceptance!==b.recoverClosedAcceptance)fail(409,'PREDICTIVE_ADOPTION_CONFLICT');const result=await present(replay);await fresh();send(202,result);return;}
     const candidate=await o.legacy.candidate(match[2],ctx);if(candidate.pins.nativeHash!==b.expectedNativeHash)fail(409,'PREDICTIVE_ADOPTION_STALE');if(candidate.host.present)fail(409,'PREDICTIVE_ADOPTION_ALREADY_BOUND');
     const existing=await o.queue.find(ctx.actorId,match[2]),meta={id:existing?.id||randomUUID(),actorId:ctx.actorId,commandId:match[2],action:candidate.job.action,requestHash:candidate.job.requestHash},revision=existing?String(BigInt(existing.grantRevision)+1n):'1';await fresh();
     try{await o.adoption.enqueue(meta,o.crypto.seal(candidate.command,meta,'COMMAND'),o.crypto.seal(captured.reference,meta,'GRANT',revision),captured.referenceUntil,b.adoptionId,existing?.grantRevision||'0',candidate.pins,b.recoverClosedAcceptance);}catch(e){if(!(e instanceof PredictiveQueueCommitUnknownV4))throw e;const recovered=await o.adoption.read(ctx.actorId,b.adoptionId);if(!recovered||recovered.commandId!==match[2]||recovered.nativeHash!==b.expectedNativeHash||recovered.recoverClosedAcceptance!==b.recoverClosedAcceptance)throw e;}
     const control=await o.adoption.read(ctx.actorId,b.adoptionId);if(!control)fail(503,'PREDICTIVE_ADOPTION_ACCEPTANCE_UNKNOWN');send(202,await present(control));
    }finally{release();}}),requestSignal());
   });
  }catch(e){if(res.headersSent){res.destroy();return;}const code=(e as Error).message,known=/^PREDICTIVE_(?:ADOPTION_(?:CONFLICT|GRANT_CONFLICT|STALE|SUPERSEDED|ALREADY_BOUND)|COMMAND_ACCEPTANCE_CLOSED|CREATION_RECOVERY_REQUIRED)$/.test(code);send(e instanceof DomainError?e.status:known?409:503,{error:e instanceof DomainError||known?code:e instanceof PredictiveQueueCommitUnknownV4?'PREDICTIVE_ADOPTION_ACCEPTANCE_UNKNOWN':'PREDICTIVE_ADOPTION_UNAVAILABLE'});}
 };
}
