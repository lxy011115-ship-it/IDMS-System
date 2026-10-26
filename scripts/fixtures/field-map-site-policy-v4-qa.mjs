import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {opaqueId} from '../../server/auth-state.ts';
import {authorityJsonV1} from '../../server/identity-authority-live-v1.ts';
import {publicGovernedSource} from '../../server/source-governance.ts';
import {reconstructDomainPayload,domainEntityKey} from '../../server/domain-entities-v4.ts';
import {decodeLegacyText} from '../../server/legacy-map-v4.ts';
import {sourceGovernanceFacts,sourceDefinitionRef} from '../../server/source-policy-references.ts';
import {exactFieldSourceRef} from '../../server/field-policy-history.ts';
import {loadGovernanceConsoleAuthRuntimeV4} from '../../server/governance-console-auth-runtime-v4.ts';
import {GovernanceConsoleWorkerV6} from '../../server/governance-console-worker-v6.ts';
import {createRuntimeColdConfigGenerationV1} from '../runtime-cold-config-v1.mjs';
import {readRuntimeColdControlV1} from '../runtime-cold-portable-control-v1.mjs';
import {privateNewFile} from '../backup-support.mjs';
import {fieldManifest} from './field-issuance-model.mjs';
import {fieldSiteSourceUpgradeQaV1} from './field-site-source-upgrade-v1-qa.mjs';

import {publicFieldProfileDigest} from '../../integrations/field-profile.ts';
import {fieldSiteRotationProfileQaV1} from './field-site-rotation-profile-v1-qa.mjs';
const json=async file=>JSON.parse(await readFile(file,'utf8'));

/** Actual OIDC sessions and sealed SQL queue; no fixture actor declarations or direct publication. */
export async function prepareFieldMapSitePolicyQaV4({work,nonce,cluster,recovered,local,site,identity,users,tx}){
 const tenantId='sandbox',source=publicGovernedSource(site.boots[tenantId].model.source),snapshot=await tx.maintenanceSnapshot();let payload;
 try{payload=await reconstructDomainPayload(tenantId,(ns,key)=>snapshot.get(ns,key));}finally{await snapshot.close();}
 const facts=sourceGovernanceFacts(payload.imports,payload.audits,tenantId,Date.now()),definitions=source.points.map(p=>{
  const h=facts.current.find(h=>h.record.dataType==='POINT_DEFINITION'&&h.record.value.device_code===source.deviceCode&&h.record.value.tag_code===p.tagCode);assert(h,'FIELD_SITE_APPROVED_DEFINITION_REQUIRED');
  assert.equal(h.record.value.unit,p.unit);return{...p,definitionRef:sourceDefinitionRef(h),minimum:Number(h.record.value.min_value),maximum:Number(h.record.value.max_value)};
 });
 const target=site.qa.targets[tenantId],control=await cluster.client(target.account.database);
 try{const pending=(await control.query("SELECT count(*)::int AS n FROM governance_jobs_v4.jobs WHERE status NOT IN ('COMMITTED','FAILED','CANCELLED')")).rows[0].n;assert.equal(pending,0,'FIELD_SITE_OLD_GOVERNANCE_JOBS_NOT_DRAINED');}finally{await control.end();}
 const cold=await readRuntimeColdControlV1(recovered.trust),credentials=await json(cold.details.admission.credentialFile),generation=await createRuntimeColdConfigGenerationV1(join(work,'field-governance-config'),credentials),common=await json(join(work,tenantId+'-g.private.json')),config={...common,mode:'WORKER',queue:{account:target.account,binding:target.queue.worker},business:{account:target.account,binding:target.binding},sources:[source]};delete config.host;delete config.port;
 const sourceFile=join(work,'field-governance-source.private.json');await privateNewFile(sourceFile,canonical(config));const generated=await generation.clone(sourceFile);await generation.finish();
 const runtime=await loadGovernanceConsoleAuthRuntimeV4(generated),resolve=runtime.provider.resolve.bind(runtime.provider),jobs=[],rotations=[];
 let closed=false,closing=false,failed=false,active=null,closeJob=null,currentFieldTemplate=null;
 runtime.provider.resolve=async reference=>{await local.coldGuard.assertCurrent();if(reference.kind==='SESSION')await local.coldGuard.requireSession(reference.value);const value=await resolve(reference);await local.coldGuard.assertCurrent();return value;};
 const failures=[],worker=new GovernanceConsoleWorkerV6({queue:runtime.queue,queueAccount:runtime.config.queue.account,crypto:runtime.crypto,auth:runtime.provider,account:runtime.config.business.account,binding:runtime.config.business.binding,sources:runtime.config.sources,onError:async e=>failures.push({message:e.message,stack:e.stack})});
 async function login(label){const u=users[label],tokens=await authorityJsonV1(identity.runtime.issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'authority-web',username:u.username,password:u.password,scope:'openid'})}),checked=await local.base.auth.verify(tokens.access_token);assert.equal(checked.identity.actorId,u.id);assert.equal(checked.identity.actorType,'USER');assert.equal(checked.identity.authMode,'oidc');assert.equal(checked.identity.tenantId,tenantId);if(label==='analyst')assert(!checked.identity.roles.includes('final-approver'));u.sid=opaqueId();u.csrf=opaqueId();await local.base.state.createSession(u.sid,{...checked,tokens,createdAt:Date.now(),csrf:u.csrf});return u;}
 async function call(u,path,body){const r=await fetch(site.origin+path,{method:body===undefined?'GET':'POST',headers:{cookie:'idms_session='+u.sid,'x-tenant-id':tenantId,'x-idms-actor-id':u.id,...(body===undefined?{}:{origin:site.origin,'x-csrf-token':u.csrf,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return{status:r.status,value:await r.json()};}
 async function command(label,command){assert(!closed);const u=await login(label),commandId=randomUUID(),submitted=await call(u,'/api/v4/governance/jobs',{commandId,command});assert.equal(submitted.status,202,JSON.stringify(submitted));const actual=await worker.runOne();assert(actual&&actual.commandId===commandId,'FIELD_SITE_WRONG_GOVERNANCE_CLAIM');const result=await call(u,'/api/v4/governance/commands/'+commandId);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.value.job.status,'COMMITTED',JSON.stringify({job:result.value.job,failures}));assert.equal(result.value.job.businessCommitted,true);jobs.push({commandId,actorId:u.id,action:command.action,status:result.value.job.status});return result.value.job.result;}
 async function publish(purpose,key,value,templateKey,version='1.0.0'){let t=await command('analyst',{action:'TEMPLATE_CREATE',input:{templateKey,version,industry:'现场恢复链路验证',manifest:fieldManifest(purpose,key,value)}});const expected=()=>({expectedRevision:t.revision,expectedDigest:t.contentDigest});t=await command('analyst',{action:'TEMPLATE_SUBMIT',id:t.id,input:expected()});t=await command('operator',{action:'TEMPLATE_APPROVE',id:t.id,input:{...expected(),decision:'APPROVED',comment:'由独立实际登录用户核对恢复后现场策略'}});return t;}
 async function committedTemplate(summary,transactions){
  assert(transactions&&typeof transactions.maintenanceSnapshot==='function','FIELD_SITE_POLICY_CURRENT_TRANSACTION_REQUIRED');const snapshot=await transactions.maintenanceSnapshot();let template;
  try{template=JSON.parse(await decodeLegacyText('v4_entity',domainEntityKey('business/templates',{id:summary.id}),(namespace,key)=>snapshot.get(namespace,key)));}finally{await snapshot.close();}
  assert(template&&template.tenantId===tenantId,'FIELD_SITE_POLICY_COMMITTED_TEMPLATE_MISSING');for(const key of ['id','templateKey','version','contentDigest','revision','status'])assert.equal(template[key],summary[key],'FIELD_SITE_POLICY_COMMITTED_SUMMARY_MISMATCH');assert.equal(template.status,'PUBLISHED');return structuredClone(template);
 }
 async function operation(work){
  assert(!closed&&!closing&&!failed&&!active,'FIELD_SITE_POLICY_OPERATION_UNAVAILABLE');
  const job=Promise.resolve().then(work);active=job;
  try{return await job;}catch(error){failed=true;throw error;}finally{if(active===job)active=null;}
 }
 async function boundary(effectiveAt){while(Date.now()<=effectiveAt){await local.coldGuard.assertCurrent();await new Promise(ok=>setTimeout(ok,Math.min(250,effectiveAt+1-Date.now())));}await local.coldGuard.assertCurrent();}
 return{source,definitions,jobs,rotations,login,state(){return{closed,closing,failed,active:!!active,initialPublished:!!currentFieldTemplate,rotations:rotations.length};},publish(profile,profileDigest){return operation(async()=>{
  assert(!currentFieldTemplate,'FIELD_SITE_POLICY_INITIAL_ALREADY_PUBLISHED');assert.notEqual(users.analyst.id,users.operator.id);assert.equal(publicFieldProfileDigest(profile),profileDigest);
  const points=definitions.map(({minimum,maximum,...p})=>p),upgrade=fieldSiteSourceUpgradeQaV1(payload,source,points),effectiveFrom=new Date(upgrade.effectiveAt).toISOString(),sourceTemplate=await publish('telemetry-source-policy','telemetrySourcePolicy',upgrade.policy,upgrade.templateKey,upgrade.version),fieldPolicy={edgeId:source.edgeId,deviceCode:source.deviceCode,definitionVersion:'field-channel-admission-1.0.0',changeIntent:'INITIAL',changeReason:'实际冷恢复后独立现场审批',entries:[{id:'field-after-cold',effectiveFrom,reason:'固定现场证书与当前来源引用',admission:{sourcePolicyRef:exactFieldSourceRef(sourceTemplate),profile,profileDigest,leaseDurationMs:30000}}]},fieldTemplateSummary=await publish('field-channel-policy','fieldChannelPolicy',fieldPolicy,'field-cold-channel-'+nonce),fieldTemplate=await committedTemplate(fieldTemplateSummary,tx);
  assert.equal(fieldTemplate.status,'PUBLISHED');assert.equal(canonical(fieldTemplate.manifest.fieldChannelPolicy),canonical(fieldPolicy));currentFieldTemplate=structuredClone(fieldTemplate);await boundary(upgrade.effectiveAt);
  return{sourceTemplate,fieldTemplate,effectiveAt:upgrade.effectiveAt,priorSource:upgrade.priorSource,sourceHistoryPreserved:true};
 });},rotate(kind,profile,transactions){return operation(async()=>{
  assert(currentFieldTemplate,'FIELD_SITE_ROTATION_INITIAL_REQUIRED');assert.equal(kind,['PROFILE','EVENT_KEY','PLATFORM_KEY'][rotations.length],'FIELD_SITE_ROTATION_ORDER');
  const previous=structuredClone(currentFieldTemplate),priorPolicy=previous.manifest.fieldChannelPolicy,priorAdmission=priorPolicy.entries.at(-1).admission;
  assert(priorAdmission,'FIELD_SITE_ROTATION_PRIOR_ADMISSION');const next=fieldSiteRotationProfileQaV1(priorAdmission.profile,profile,kind),policy=structuredClone(priorPolicy),effectiveAtMs=Date.now()+240000;
  assert(priorPolicy.entries.every(entry=>Date.parse(entry.effectiveFrom)<effectiveAtMs),'FIELD_SITE_ROTATION_BOUNDARY_ORDER');
  policy.changeIntent='PROSPECTIVE';policy.changeReason='实际身份独立审批 '+kind+' 轮换';policy.entries.push({id:'field-rotation-'+String(rotations.length+1),effectiveFrom:new Date(effectiveAtMs).toISOString(),reason:kind+' 独立生效边界',admission:{...structuredClone(priorAdmission),profile:next,profileDigest:publicFieldProfileDigest(next)}});
  const start=jobs.length,summary=await publish('field-channel-policy','fieldChannelPolicy',policy,previous.templateKey,'1.0.'+String(rotations.length+1)),approvedAtMs=Date.now(),template=await committedTemplate(summary,transactions),actual=jobs.slice(start);
  assert.equal(template.status,'PUBLISHED');assert.equal(canonical(template.manifest.fieldChannelPolicy),canonical(policy));assert.equal(canonical(policy.entries.slice(0,-1)),canonical(priorPolicy.entries));
  assert.equal(actual.length,3);assert.deepEqual(actual.map(job=>job.action),['TEMPLATE_CREATE','TEMPLATE_SUBMIT','TEMPLATE_APPROVE']);assert.equal(actual[0].actorId,users.analyst.id);assert.equal(actual[1].actorId,users.analyst.id);assert.equal(actual[2].actorId,users.operator.id);assert.notEqual(actual[0].actorId,actual[2].actorId);assert(actual.every(job=>job.status==='COMMITTED'));assert(approvedAtMs<effectiveAtMs,'FIELD_SITE_ROTATION_APPROVAL_MISSED_FUTURE_BOUNDARY');
  currentFieldTemplate=structuredClone(template);const evidence={kind,approvedAtMs,effectiveAtMs,templateId:template.id,templateKey:template.templateKey,version:template.version,contentDigest:template.contentDigest,oldProfileDigest:priorAdmission.profileDigest,newProfileDigest:publicFieldProfileDigest(next),jobs:structuredClone(actual),actualOidcIdentityAuthenticated:true,priorEffectiveEntriesPreserved:true,originalLeaseDurationMs:priorAdmission.leaseDurationMs,formalFieldActivationGranted:false,fullGoalComplete:false};rotations.push(evidence);await boundary(effectiveAtMs);return structuredClone(evidence);
 });},close(){if(closeJob)return closeJob;closing=true;return closeJob=(async()=>{try{if(active)await active.catch(()=>{});}finally{await runtime.close();closed=true;}})();}};
}
