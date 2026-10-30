import {performance} from 'node:perf_hooks';
import {canonical} from '../server/imports.ts';
import {authorityRuntimeV1,IdentityAuthorityGuardV1} from '../server/identity-authority-live-v1.ts';
import {CurrentRecoveryActor} from './field-recovery-current-actor.mjs';
import {recoveryExternalConfig} from './field-recovery-external-config.mjs';
import {currentDeploymentReviewPurposeV1,validateColdCurrentDeploymentReviewContractV1,assertFreshColdCurrentDeploymentReviewIntentV1} from './cold-current-deployment-review-contract-v1.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

export const currentDeploymentUserActionV1='REQUEST_CURRENT_DEPLOYMENT_DIAGNOSTIC_REVIEW';
const purpose=currentDeploymentReviewPurposeV1,handles=new WeakMap();
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v);
const token=v=>typeof v==='string'&&v.length>0&&v.length<=32768&&!/[\u0000-\u0020\u007f]/.test(v);
const same=(a,b)=>canonical(a)===canonical(b),sort=a=>[...a].sort();
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function fresh(r){return assertFreshColdCurrentDeploymentReviewIntentV1(r.record,r.context,r.intentSha256);}
function request(r,raw){
  const b=fresh(r);
  need(exact(raw,['purpose','reviewId','operationId','expectedIntentSha256','confirmations'])&&raw.purpose===purpose&&raw.reviewId===b.reviewId&&raw.operationId===b.operationId&&raw.expectedIntentSha256===r.intentSha256,'CURRENT_DEPLOYMENT_USER_REQUEST');
  need(Array.isArray(raw.confirmations)&&raw.confirmations.length>0&&raw.confirmations.length<=32&&same(sort(raw.confirmations.map(v=>v?.tenantId)),r.tenants),'CURRENT_DEPLOYMENT_USER_TENANTS');
  const ids=new Set(),now=Date.now();
  for(const c of raw.confirmations){
    need(exact(c,['tenantId','confirmationId','confirmedAt','action','expectedSourceHash','expectedFullFactsSha256','expectedDeploymentSha256','expectedProgramInventorySha256','accessToken'])&&uuid(c.confirmationId)&&!ids.has(c.confirmationId)&&![b.reviewId,b.operationId].includes(c.confirmationId)&&c.action===currentDeploymentUserActionV1&&token(c.accessToken),'CURRENT_DEPLOYMENT_USER_CONFIRMATION');ids.add(c.confirmationId);
    need(c.expectedSourceHash===b.sourceHash&&c.expectedFullFactsSha256===b.sourceFullFactsSha256&&c.expectedDeploymentSha256===b.deploymentSha256&&c.expectedProgramInventorySha256===b.programInventorySha256,'CURRENT_DEPLOYMENT_USER_EXPECTED_BINDING');
    const at=Date.parse(c.confirmedAt);need(Number.isSafeInteger(at)&&new Date(at).toISOString()===c.confirmedAt&&at>=Date.parse(b.createdAt)&&at<=now+5000&&now-at<120000&&at<Date.parse(b.expiresAt),'CURRENT_DEPLOYMENT_USER_CONFIRMATION_EXPIRED');
  }
  return structuredClone(raw.confirmations).sort((a,b)=>a.tenantId.localeCompare(b.tenantId));
}
async function authority(r){
  const h=await r.authority.assertCurrent(),s=r.context.source.sourceAuthority;
  need(h.event.authorityId===s.authorityId&&h.event.issuer===s.issuer&&h.event.epoch>=s.epoch&&h.event.binding.systemIdentifier!==r.context.source.inventory.identity.system_id,'CURRENT_DEPLOYMENT_USER_AUTHORITY_BINDING');return h;
}
function available(r){need(!r.closed&&!r.closing&&!r.failed,'CURRENT_DEPLOYMENT_USER_GATE_CLOSED');fresh(r);}
function owned(r,handle){const h=handles.get(handle);available(r);need(h&&h.owner===r&&r.handle===handle,'CURRENT_DEPLOYMENT_USER_HANDLE_NOT_MINTED');need(Date.now()<Date.parse(h.proof.expiresAt),'CURRENT_DEPLOYMENT_USER_HANDLE_EXPIRED');return h;}
async function identities(r,signal){const result=[];for(const row of r.actors)result.push(await row.actor.current({purpose:'AUTHOR',signal}));return result;}
async function closeActors(r){const result=await Promise.allSettled(r.actors.map(v=>v.actor.close()));need(result.every(v=>v.status==='fulfilled'),'CURRENT_DEPLOYMENT_USER_IDENTITY_CLEANUP_UNCONFIRMED');}
async function operation(r,run){available(r);need(!r.active,'CURRENT_DEPLOYMENT_USER_GATE_BUSY');let job;job=run();r.active=job;try{return await job;}finally{if(r.active===job)r.active=null;}}

/** Trusted coordinator construction only. No SQL, process or application authority is minted here. */
export function createColdCurrentDeploymentUserIntentGateV1(raw){
  need(exact(raw,['context','privateRecord','expectedIntentSha256','authority','participants']),'CURRENT_DEPLOYMENT_USER_CONFIG');
  const context=structuredClone(raw.context),record=validateColdCurrentDeploymentReviewContractV1(raw.privateRecord,context,raw.expectedIntentSha256),runtime=authorityRuntimeV1(raw.authority);
  const tenants=sort(context.source.fullFacts.databases.filter(d=>d.map).map(d=>d.map.tenantId));
  need(tenants.length>0&&tenants.length<=32&&new Set(tenants).size===tenants.length&&Array.isArray(raw.participants)&&same(sort(raw.participants.map(v=>v?.tenantId)),tenants),'CURRENT_DEPLOYMENT_USER_CONFIG_TENANTS');
  need(runtime.issuer===context.source.sourceAuthority.issuer&&runtime.trust.authorityId===context.source.sourceAuthority.authorityId,'CURRENT_DEPLOYMENT_USER_CONFIG_AUTHORITY');
  const participants=raw.participants.map(recoveryExternalConfig).sort((a,b)=>a.tenantId.localeCompare(b.tenantId));
  for(const c of participants){const reader=record.readerCredentials.readers.find(v=>v.tenantId===c.tenantId),source=context.source.readerContract.readers.find(v=>v.facts.tenantId===c.tenantId)?.facts;
    need(c.auth.issuer===runtime.issuer&&reader&&source&&reader.authorityId===source.authorityId&&reader.bpmnSha256===source.bpmnSha256&&c.workflow.authorityId===reader.authorityId&&c.workflow.definitionSha256===reader.bpmnSha256&&c.workflow.recoveryReadToken===reader.token,'CURRENT_DEPLOYMENT_USER_CONFIG_READER');}
  const r={context,record,intentSha256:raw.expectedIntentSha256,tenants,participants,runtime,authority:new IdentityAuthorityGuardV1(runtime),actors:[],abort:new AbortController(),consumed:false,handle:null,active:null,closing:false,closed:false,failed:false,closeJob:null};fresh(r);
  return Object.freeze({
    authorize(rawRequest){const confirmations=request(r,rawRequest);return operation(r,async()=>{
      need(!r.consumed,'CURRENT_DEPLOYMENT_USER_GATE_CONSUMED');r.consumed=true;
      const started=performance.now(),signal=AbortSignal.any([r.abort.signal,AbortSignal.timeout(30000)]);
      try{
        const before=await authority(r),initial=[];
        for(const c of confirmations){const configuration=r.participants.find(v=>v.tenantId===c.tenantId),actor=new CurrentRecoveryActor(configuration);r.actors.push({tenantId:c.tenantId,actor});initial.push(await actor.verify(c.accessToken,{purpose:'AUTHOR',signal}));c.accessToken='';}
        const current=await identities(r,signal),after=await authority(r);available(r);
        need(!signal.aborted&&performance.now()-started<=30000&&before.hash===after.hash&&same(initial,current),'CURRENT_DEPLOYMENT_USER_CHANGED_DURING_CHECK');
        const now=Date.now(),expires=Math.min(Date.parse(r.record.intent.body.expiresAt),now+30000,...confirmations.map(v=>Date.parse(v.confirmedAt)+120000),...current.map(v=>Date.parse(v.tokenExpiresAt)-10000));need(expires>now,'CURRENT_DEPLOYMENT_USER_CONFIRMATION_EXPIRED');
        const b=r.record.intent.body,body={format:'CURRENT_DEPLOYMENT_USER_EXPLICIT_INTENT_V1',purpose,action:currentDeploymentUserActionV1,controlId:b.controlId,sourceHash:b.sourceHash,sourceFullFactsSha256:b.sourceFullFactsSha256,reviewId:b.reviewId,operationId:b.operationId,intentSha256:r.intentSha256,deploymentSha256:b.deploymentSha256,programInventorySha256:b.programInventorySha256,currentAuthorityHash:after.hash,confirmations:confirmations.map((v,i)=>({tenantId:v.tenantId,confirmationId:v.confirmationId,confirmedAt:v.confirmedAt,actor:current[i]})),capturedAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),actualCurrentUsersAuthenticated:true,allSourceTenantsExplicitlyRequested:true,durableConsentRecorded:false,ownedRuntimeSessionMinted:false,allCurrentTargetFactsRechecked:false,programStartupGranted:false,mqttApplicationProbeGranted:false,independentApprovalGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
        const handle=Object.freeze({});handles.set(handle,{owner:r,proof:freeze({...body,sha256:hash(body)})});r.handle=handle;return handle;
      }catch(error){r.failed=true;await closeActors(r);throw error;}finally{for(const c of confirmations)c.accessToken='';}
    });},
    inspect(handle){return structuredClone(owned(r,handle).proof);},
    revalidate(handle){const h=owned(r,handle);return operation(r,async()=>{try{const signal=AbortSignal.any([r.abort.signal,AbortSignal.timeout(30000)]),started=performance.now(),before=await authority(r),current=await identities(r,signal),after=await authority(r);owned(r,handle);need(!signal.aborted&&performance.now()-started<=30000&&before.hash===h.proof.currentAuthorityHash&&after.hash===before.hash&&same(current,h.proof.confirmations.map(v=>v.actor)),'CURRENT_DEPLOYMENT_USER_CURRENT_CHANGED');return structuredClone(h.proof);}catch(error){r.failed=true;throw error;}});},
    close(){if(r.closeJob)return r.closeJob;r.closing=true;r.abort.abort();r.closeJob=(async()=>{await r.active?.catch(()=>{});await closeActors(r);r.record.journalKey='';r.record.readerCredentials.key='';for(const reader of r.record.readerCredentials.readers){reader.password='';reader.token='';}for(const c of r.participants){c.identityReader.clientSecret='';c.workflow.recoveryReadToken='';}r.runtime.reader.clientSecret='';r.closed=true;return{format:'CURRENT_DEPLOYMENT_USER_GATE_CLOSED_V1',allOwnedIdentityClientsClosed:true,ownedTargetSqlClients:0,ownedRuntimePrograms:0};})();return r.closeJob;}
  });
}
