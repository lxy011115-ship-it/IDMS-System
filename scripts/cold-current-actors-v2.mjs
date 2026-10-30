import {performance} from 'node:perf_hooks';
import {setMaxListeners} from 'node:events';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {CurrentRecoveryActor} from './field-recovery-current-actor.mjs';
import {recoveryExternalConfig} from './field-recovery-external-config.mjs';
import {assertColdOwnedReviewSessionBindingV1} from './cold-owned-review-session-v2.mjs';
import {privateNewFile} from './backup-support.mjs';
import {reviewSourceHashV1 as hash,reviewSourceNeedV1 as need} from './workflow-review-source-facts-v1.mjs';
const records=new WeakMap(),exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),token=v=>typeof v==='string'&&v.length>0&&v.length<=32768&&!/[\u0000-\u0020\u007f]/.test(v);
const sorted=v=>[...v].sort(),same=(a,b)=>canonical(a)===canonical(b);

/** Pure request validation is not authentication and never creates an actor capability. */
export function coldCurrentActorRequestV1(participants,{source,credentials}){
 const tenants=source.fullFacts.databases.filter(d=>d.map).map(d=>d.map.tenantId);
 need(Array.isArray(participants)&&participants.length>0&&participants.length<=32&&new Set(tenants).size===tenants.length&&same(sorted(participants.map(p=>p?.configuration?.tenantId)),sorted(tenants)),'COLD_ACTORS_TENANT_INVENTORY');
 let count=0;const result=[];
 for(const p of participants){
  need(exact(p,['configuration','authorAccessToken','contributorAccessTokens','reviewerAccessToken'])&&Array.isArray(p.contributorAccessTokens)&&p.contributorAccessTokens.length<=16&&[p.authorAccessToken,p.reviewerAccessToken,...p.contributorAccessTokens].every(token),'COLD_ACTORS_REQUEST');
  count+=2+p.contributorAccessTokens.length;need(count<=64,'COLD_ACTORS_LIMIT');
  const c=recoveryExternalConfig(p.configuration),r=credentials.readers.find(v=>v.tenantId===c.tenantId),original=source.readerContract.readers.find(v=>v.facts.tenantId===c.tenantId)?.facts;
  need(c.auth.issuer===source.sourceAuthority.issuer&&r&&original&&r.authorityId===original.authorityId&&r.bpmnSha256===original.bpmnSha256&&c.workflow.authorityId===r.authorityId&&c.workflow.definitionSha256===r.bpmnSha256&&c.workflow.recoveryReadToken===r.token,'COLD_ACTORS_EXTERNAL_BINDING');
  result.push({configuration:c,authorAccessToken:p.authorAccessToken,contributorAccessTokens:[...p.contributorAccessTokens],reviewerAccessToken:p.reviewerAccessToken});
 }
 return result.sort((a,b)=>a.configuration.tenantId.localeCompare(b.configuration.tenantId));
}

export function assertColdActorIndependenceV1({author,contributors,reviewer}){
 need(author?.purpose==='AUTHOR'&&Array.isArray(contributors)&&contributors.every(v=>v?.purpose==='AUTHOR'&&v.tenantId===author.tenantId)&&reviewer?.purpose==='REVIEWER'&&reviewer.tenantId===author.tenantId,'COLD_ACTORS_IDENTITY_BINDING');
 const ids=[author.actorId,...contributors.map(v=>v.actorId)];need(ids.every(v=>typeof v==='string'&&v.length>0)&&new Set(ids).size===ids.length,'COLD_ACTORS_CONTRIBUTOR_DUPLICATE');
 need(typeof reviewer.actorId==='string'&&reviewer.actorId.length>0&&!ids.includes(reviewer.actorId),'COLD_ACTORS_INDEPENDENT_REVIEWER');
 return true;
}
async function boundedMap(items,operation){
 const results=new Array(items.length),errors=[];let index=0;
 await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{for(;;){const at=index++;if(at>=items.length)return;try{results[at]=await operation(items[at],at);}catch(e){errors.push(e);}}}));
 if(errors.length)throw errors[0];return results;
}
function binding(context){return hash({trust:context.trust,recoveryId:context.recoveryId,sourceHash:hash(context.source),targetDirectory:context.targetDirectory,credentialSha256:context.credentialSha256,workDirectory:context.workDirectory});}
function held(handle,session,context){const r=records.get(handle);need(r&&!r.closed,'COLD_ACTORS_HANDLE_NOT_MINTED');assertColdOwnedReviewSessionBindingV1(session,{trust:context.trust,recoveryId:context.recoveryId});need(r.session===session&&r.binding===binding(context),'COLD_ACTORS_CONTEXT_CHANGED');return r;}
function signal(r){const s=AbortSignal.any([r.abort.signal,AbortSignal.timeout(30000)]);setMaxListeners(0,s);return s;}
async function current(r,s){
 return boundedMap(r.tenants,async t=>{
  const values=await boundedMap([t.author,...t.contributors,t.reviewer],x=>x.identity.current({purpose:x.purpose,signal:s}));
  const row={tenantId:t.tenantId,externalConfigSha256:t.externalConfigSha256,author:values[0],contributors:values.slice(1,-1),reviewer:values.at(-1)};assertColdActorIndependenceV1(row);return row;
 });
}

/** The original preparer supplies context and credentials; raw caller records cannot replace verification. */
export async function createColdCurrentActorsV1({session,context,credentials,participants,workDirectory}){
 assertColdOwnedReviewSessionBindingV1(session,{trust:context.trust,recoveryId:context.recoveryId});
 need(hash(context.source)===context.trust.sourceHash&&hash(credentials)===context.credentialSha256&&workDirectory===context.workDirectory&&typeof workDirectory==='string'&&isAbsolute(workDirectory),'COLD_ACTORS_ORIGINAL_CREDENTIALS');
 const request=coldCurrentActorRequestV1(participants,{source:context.source,credentials}),r={session,binding:binding(context),tenants:[],actors:[],abort:new AbortController(),closed:false,window:null,workDirectory};
 try{
  const s=signal(r);
  for(const p of request){
   const actor=purpose=>{const a={identity:new CurrentRecoveryActor(p.configuration),purpose};r.actors.push(a);return a;};
   r.tenants.push({tenantId:p.configuration.tenantId,externalConfigSha256:hash(p.configuration),author:actor('AUTHOR'),contributors:p.contributorAccessTokens.map(()=>actor('AUTHOR')),reviewer:actor('REVIEWER'),request:p});
  }
  const initial=await boundedMap(r.tenants,async t=>{
   const p=t.request,a=await t.author.identity.verify(p.authorAccessToken,{purpose:'AUTHOR',signal:s}),contributors=await boundedMap(t.contributors,(x,i)=>x.identity.verify(p.contributorAccessTokens[i],{purpose:'AUTHOR',signal:s}));
   const reviewer=await t.reviewer.identity.verify(p.reviewerAccessToken,{purpose:'REVIEWER',otherActorId:a.actorId,signal:s});
   const row={tenantId:t.tenantId,externalConfigSha256:t.externalConfigSha256,author:a,contributors,reviewer};assertColdActorIndependenceV1(row);return row;
  });
  for(const t of r.tenants)delete t.request;
  r.initial=initial;const handle=Object.freeze({});records.set(handle,r);return handle;
 }catch(e){r.abort.abort();await Promise.allSettled(r.actors.map(x=>x.identity.close()));throw e;}
}

export async function beginColdCurrentActorsV1(handle,{session,context}){
 const r=held(handle,session,context);need(!r.window,'COLD_ACTORS_WINDOW_ALREADY_STARTED');
 const started=performance.now(),capturedFrom=new Date().toISOString(),s=signal(r),before=await current(r,s);
 need(same(before,r.initial),'COLD_ACTORS_CHANGED_DURING_FULL_CHECK');
 const marker=join(r.workDirectory,'actors-window-'+randomUUID()+'.private.json');
 await privateNewFile(marker,canonical({format:'COLD_CURRENT_ACTORS_WINDOW_V1',sourceHash:context.trust.sourceHash,recoveryId:context.recoveryId,capturedFrom,actors:before,approvalGranted:false}));
 r.window={started,capturedFrom,signal:s,before,marker,finished:false};
 return{marker};
}

export async function finishColdCurrentActorsV1(handle,{session,context,fullFactsCheck,beforeWorkflows,afterWorkflows,beforeConsistency,afterConsistency}){
 const r=held(handle,session,context),w=r.window;need(w&&!w.finished,'COLD_ACTORS_WINDOW_REQUIRED');
 need(beforeConsistency?.workflowOrderInventoryVerified===true&&same(beforeConsistency,afterConsistency)&&beforeWorkflows.sourceHash===context.trust.sourceHash&&afterWorkflows.sourceHash===context.trust.sourceHash&&beforeWorkflows.recoveryId===context.recoveryId&&afterWorkflows.recoveryId===context.recoveryId&&beforeWorkflows.intentSha256===afterWorkflows.intentSha256&&beforeWorkflows.readerLeaseId===afterWorkflows.readerLeaseId&&fullFactsCheck.sourceFullFactsSha256===context.source.fullFacts.sha256,'COLD_ACTORS_WORKFLOW_CHANGED');
 let after;try{after=await current(r,w.signal);}catch(e){
  const failure={format:'COLD_CURRENT_ACTORS_READ_FAILURE_V1',sourceHash:context.trust.sourceHash,recoveryId:context.recoveryId,windowMarker:w.marker,beforeActorsSha256:hash(w.before),workflowCaptures:[beforeWorkflows,afterWorkflows],capturedAt:new Date().toISOString(),failureCode:typeof e.code==='string'&&/^[A-Z_0-9]{4,128}$/.test(e.code)?e.code:'CURRENT_IDENTITY_READ_FAILED',approvalGranted:false};
  const file=join(r.workDirectory,'actors-read-failure-'+randomUUID()+'.private.json');await privateNewFile(file,canonical(failure));e.coldActorFailureEvidenceFile=file;throw e;
 }
 need(same(w.before,after),'COLD_ACTORS_CHANGED_DURING_READ');
 const expiries=after.flatMap(t=>[t.author,...t.contributors,t.reviewer].map(a=>Date.parse(a.tokenExpiresAt)-10000)),now=Date.now();
 need(!w.signal.aborted&&performance.now()-w.started<=30000&&expiries.every(v=>Number.isFinite(v)&&v>now),'COLD_ACTORS_OBSERVATION_EXPIRED');
 const body={format:'COLD_CURRENT_ACTORS_OBSERVATION_V1',controlId:context.trust.controlId,sourceHash:context.trust.sourceHash,sourceFullFactsSha256:context.source.fullFacts.sha256,recoveryId:context.recoveryId,intentSha256:beforeWorkflows.intentSha256,readerLeaseId:beforeWorkflows.readerLeaseId,fullFactsCheckSha256:hash(fullFactsCheck),reviewConsistencySha256:beforeConsistency.sha256,workflowCaptures:[beforeWorkflows,afterWorkflows],actors:after,beforeActorsSha256:hash(w.before),afterActorsSha256:hash(after),capturedFrom:w.capturedFrom,capturedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(...expiries,now+30000)).toISOString(),workflowReadTransport:'ORIGINAL_OWNED_READER',externalWorkflowHttpUsed:false,currentOidcReviewerVerified:true,independentReviewersVerified:true,declaredContributorsCurrentVerified:true,durablePlanContributorsVerified:false,approvalGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 body.windowMarker=w.marker;
 const observation={...body,sha256:hash(body)},evidenceFile=join(r.workDirectory,'actors-observation-'+randomUUID()+'.private.json');await privateNewFile(evidenceFile,canonical(observation));w.finished=true;return{...observation,evidenceFile};
}

export async function closeColdCurrentActorsV1(handle){const r=records.get(handle);need(r,'COLD_ACTORS_HANDLE_NOT_MINTED');if(r.closed)return;r.closed=true;r.abort.abort();const results=await Promise.allSettled(r.actors.map(x=>x.identity.close()));records.delete(handle);need(results.every(v=>v.status==='fulfilled'),'COLD_ACTORS_IDENTITY_CLEANUP_UNPROVEN');}
