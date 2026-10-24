import {randomUUID,type KeyObject} from 'node:crypto';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {canonical,digest} from './imports.ts';
import {fieldRegistrySnapshot,type FieldRegistrySnapshot} from './field-registry.ts';
import {fieldRuntimeMapFormatV1,fieldRegistryMapHeadV1,inspectRegistryMapHeadV1,issuanceBodyFromMapV1,fieldIssuanceMapKeyV1,type FieldRegistryMapHeadV1,type FieldIssuanceMapIndexV1} from './field-runtime-map-v1.ts';
import {fieldMapAuditPlanV1,type FieldMapSnapshotV1} from './field-map-audit-v1.ts';
import {readCurrentFieldAdmissionMapV1,readFieldAdmissionMapV1} from './field-admission-map-v1.ts';
import {fieldAdmissionBindingDigest} from './field-admission.ts';
import {verifyLocalDomainAudit} from './telemetry-map-v4.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {fieldLeaseBody,verifyFieldLease,type FieldLeaseBody} from '../integrations/field-lease.ts';
import {fieldCheckBody,fieldLeaseDigest,type FieldCheckRequest} from '../integrations/field-check.ts';
import type {FieldLeaseRequest} from '../integrations/field-request.ts';
import type {AuditEvent} from './domain.ts';
import type {StateOperation} from './state-map-v1.ts';

async function ready(s:FieldMapSnapshotV1){
 const marker=await s.get('domain_head','field_runtime');need(canonicalEqual(marker,{format:fieldRuntimeMapFormatV1,tenantId:s.tenantId}),'FIELD_MAP_NOT_PREPARED');
}
async function registry(s:FieldMapSnapshotV1,expected?:FieldRegistrySnapshot){
 await ready(s);const state=await s.state('domain_head','field_registry');if(!state.present){need(!expected,'FIELD_MAP_REGISTRY_UNOBSERVED');return null;}
 const head=state.value as FieldRegistryMapHeadV1;need(head.tenantId===s.tenantId,'FIELD_MAP_REGISTRY_INTEGRITY');const event=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',head.registryEventId),s.tenantId);inspectRegistryMapHeadV1(head,event);
 if(expected)need(canonicalDigest(expected)===head.registryDigest,'FIELD_REGISTRY_STALE');return head;
}
export async function planFieldRegistryObservationMapV1(s:FieldMapSnapshotV1,raw:unknown,instanceId:string){
 const snapshot=fieldRegistrySnapshot(raw);need(snapshot.tenantId===s.tenantId&&/^[A-Za-z0-9_.:-]{1,100}$/.test(instanceId),'FIELD_MAP_REGISTRY_CONFIG');
 const control=await s.get<any>('domain_head','control');need(control.tenantId===s.tenantId&&control.status==='ACTIVE','FIELD_ADMISSION_MAP_NOT_ACTIVE');
 const tenant=JSON.parse(await decodeLegacyText('v4_entity',domainEntityKey('business/tenants',{id:s.tenantId}),(ns,key)=>s.get(ns,key)));need(tenant.id===s.tenantId&&tenant.status==='ACTIVE','FIELD_MAP_TENANT_INACTIVE');
 const prior=await registry(s),registryDigest=canonicalDigest(snapshot);need(!(prior?.snapshot.format==='idms-field-registry-v2'&&snapshot.format!=='idms-field-registry-v2'),'FIELD_MAP_REGISTRY_DOWNGRADE');
 if(prior?.registryDigest===registryDigest)return {operations:[] as StateOperation[],value:{changed:false,revision:prior.revision,registryDigest,registryEventId:prior.registryEventId}};
 const revision=String(BigInt(prior?.revision??'0')+1n);need(BigInt(revision)<=9223372036854775807n,'FIELD_MAP_REGISTRY_LIMIT');
 const p=await fieldMapAuditPlanV1(s,businessTime=>{need(!prior||Date.parse(businessTime)>=Date.parse(prior.observedAt),'FIELD_MAP_REGISTRY_CLOCK');return {tenantId:s.tenantId,objectType:'FIELD_REGISTRY',objectId:s.tenantId,action:'FIELD_REGISTRY_OBSERVED',actorType:'SYSTEM',actorId:instanceId,correlationId:randomUUID(),after:snapshot,metadata:{format:'idms-field-registry-observation-v1',revision,registryDigest,previousRegistryEventId:prior?.registryEventId??null,previousRegistryDigest:prior?.registryDigest??null}};});
 const head=fieldRegistryMapHeadV1(snapshot,p.event);return {operations:[...p.operations,await s.operation('domain_head','field_registry',head)],value:{changed:true,revision,registryDigest,registryEventId:p.event.eventId}};
}
async function current(s:FieldMapSnapshotV1,snapshot:FieldRegistrySnapshot,edge:string,at:number){
 need(Number.isSafeInteger(at),'FIELD_MAP_CLOCK');const channel=snapshot.channels.find(c=>c.profile.source.edgeId===edge);need(snapshot.tenantId===s.tenantId&&channel,'FIELD_MAP_CHANNEL');
 const r=await registry(s,snapshot);need(r&&Date.parse(r.observedAt)<=at,'FIELD_MAP_REGISTRY_CLOCK');
 const admission=await readCurrentFieldAdmissionMapV1(channel.profile,at,null,(ns,key)=>s.get(ns,key));
 return {registry:r,channel,admission,admissionDigest:admission.decision.allowed?fieldAdmissionBindingDigest(admission.decision):null};
}
export async function inspectFieldIssuanceMapV1(s:FieldMapSnapshotV1,requestId:string){
 await ready(s);const index=await s.get<FieldIssuanceMapIndexV1>('field_issuance',fieldIssuanceMapKeyV1(requestId)),event=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',index.auditEventId),s.tenantId),body=issuanceBodyFromMapV1(index,event,s.tenantId,requestId);
 need(typeof event.metadata.registryEventId==='string','FIELD_MAP_ISSUANCE_INTEGRITY');const observation=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',event.metadata.registryEventId),s.tenantId),old=fieldRegistrySnapshot(observation.after),head=fieldRegistryMapHeadV1(old,observation);inspectRegistryMapHeadV1(head,observation);
 const channel=old.channels.find(c=>c.profile.source.edgeId===body.edgeId);need(channel&&old.tenantId===s.tenantId&&old.leaseKeyId===body.keyId&&channel.profileDigest===body.profileDigest&&channel.profile.source.deviceCode===body.deviceCode&&channel.profile.source.mapVersion===body.mapVersion&&head.revision===body.registryRevision&&head.registryDigest===body.registryDigest&&Date.parse(head.observedAt)<=body.issuedAtMs,'FIELD_MAP_ISSUANCE_INTEGRITY');
 const control=await s.get<any>('domain_head','control'),original=await readFieldAdmissionMapV1(channel.profile,body.issuedAtMs,null,control.governanceAnchorDigest,(ns,key)=>s.get(ns,key));
 need(original.decision.allowed&&canonicalEqual(original.decision.binding,event.metadata.admissionBinding)&&body.admissionDigest===fieldAdmissionBindingDigest(original.decision)&&body.expiresAtMs===Math.min(body.issuedAtMs+original.decision.leaseDurationMs,original.decision.nextBoundary??Infinity),'FIELD_MAP_ISSUANCE_INTEGRITY');
 return {body,event,observation,registry:head,original:original.decision};
}
/** Request authentication belongs to the runtime service, as in the original pure planner. */
export async function planFieldLeaseIssuanceMapV1(s:FieldMapSnapshotV1,request:FieldLeaseRequest,raw:FieldRegistrySnapshot){
 const snapshot=fieldRegistrySnapshot(raw),now=Date.now(),live=await current(s,snapshot,request.edgeId,now),source=live.channel.profile.source;
 need(request.tenantId===s.tenantId&&request.deviceCode===source.deviceCode&&request.mapVersion===source.mapVersion&&request.profileDigest===live.channel.profileDigest,'FIELD_MAP_REQUEST_IDENTITY');
 const valid=(at:number)=>need(request.requestedAtMs<=at&&at-request.requestedAtMs<30000,'FIELD_LEASE_REQUEST_EXPIRED');valid(now);need(live.admission.decision.allowed,live.admission.decision.reason??'FIELD_APPROVAL_DENIED');
 const prior=await s.state('field_issuance',fieldIssuanceMapKeyV1(request.requestId)),requestDigest=digest(canonical(request));
 if(prior.present){const original=await inspectFieldIssuanceMapV1(s,request.requestId),body=original.body;need(original.event.actorId===source.edgeId,'FIELD_MAP_ISSUANCE_INTEGRITY');need(original.event.metadata.requestDigest===requestDigest,'FIELD_LEASE_REQUEST_CONFLICT');need(body.admissionDigest===live.admissionDigest&&body.registryDigest===live.registry.registryDigest&&body.registryRevision===live.registry.revision&&original.observation.eventId===live.registry.registryEventId,'FIELD_LEASE_APPROVAL_OR_REGISTRY_CHANGED');need(now<body.expiresAtMs,'FIELD_LEASE_EXPIRED');return {operations:[] as StateOperation[],value:body};}
 let body:FieldLeaseBody|undefined;const p=await fieldMapAuditPlanV1(s,async businessTime=>{
  const issuedAtMs=Date.parse(businessTime),exact=await current(s,snapshot,request.edgeId,issuedAtMs);valid(issuedAtMs);need(exact.admission.decision.allowed,exact.admission.decision.reason??'FIELD_APPROVAL_DENIED');
  body=fieldLeaseBody({format:'idms-field-channel-lease-v1',keyId:snapshot.leaseKeyId,leaseId:randomUUID(),requestId:request.requestId,tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion,profileDigest:live.channel.profileDigest,admissionDigest:exact.admissionDigest,registryRevision:exact.registry.revision,registryDigest:exact.registry.registryDigest,issuedAtMs,expiresAtMs:Math.min(issuedAtMs+exact.admission.decision.leaseDurationMs,exact.admission.decision.nextBoundary??Infinity)});
  return {tenantId:s.tenantId,objectType:'FIELD_LEASE',objectId:request.requestId,action:'FIELD_LEASE_ISSUED',actorType:'INTERFACE',actorId:source.edgeId,correlationId:request.requestId,metadata:{format:'idms-field-lease-issuance-v1',requestDigest,leaseBody:body,registryEventId:exact.registry.registryEventId,admissionBinding:exact.admission.decision.binding}};
 });
 const index:FieldIssuanceMapIndexV1={format:fieldRuntimeMapFormatV1,tenantId:s.tenantId,requestId:request.requestId,auditEventId:p.event.eventId};
 return {operations:[...p.operations,await s.operation('field_issuance',request.requestId,index)],value:body!};
}
export async function fieldCurrentLeaseCheckMapV1(s:FieldMapSnapshotV1,request:FieldCheckRequest,raw:FieldRegistrySnapshot,key:KeyObject,at:number){
 const snapshot=fieldRegistrySnapshot(raw),body=request.lease.body;need(request.requestedAtMs<=at&&at-request.requestedAtMs<30000,'FIELD_CHECK_REQUEST_EXPIRED');
 const live=await current(s,snapshot,body.edgeId,at);need(live.channel.profileDigest===body.profileDigest,'FIELD_MAP_CHECK_IDENTITY');verifyFieldLease(request.lease,key,{...live.channel.profile.source,profileDigest:live.channel.profileDigest},body.issuedAtMs);
 const original=await inspectFieldIssuanceMapV1(s,body.requestId);need(canonicalEqual(original.body,body),'FIELD_MAP_ISSUANCE_INTEGRITY');
 let reason=live.admission.decision.allowed?null:live.admission.decision.reason??'FIELD_APPROVAL_DENIED';
 if(body.issuedAtMs>at)reason='FIELD_LEASE_CLOCK_INVALID';else if(at>=body.expiresAtMs)reason='FIELD_LEASE_EXPIRED';else if(body.registryDigest!==live.registry.registryDigest||body.registryRevision!==live.registry.revision)reason='FIELD_LEASE_REGISTRY_CHANGED';else if(live.admission.decision.allowed&&body.admissionDigest!==live.admissionDigest)reason='FIELD_LEASE_APPROVAL_CHANGED';
 return fieldCheckBody({format:'idms-field-lease-check-v1',keyId:snapshot.leaseKeyId,requestId:request.requestId,leaseId:body.leaseId,leaseDigest:fieldLeaseDigest(request.lease),tenantId:body.tenantId,edgeId:body.edgeId,deviceCode:body.deviceCode,mapVersion:body.mapVersion,profileDigest:body.profileDigest,checkedAtMs:at,validUntilMs:reason===null?Math.min(at+2000,body.expiresAtMs,live.admission.decision.nextBoundary??Infinity):at+2000,allowed:reason===null,reason,admissionDigest:live.admissionDigest,registryRevision:live.registry.revision,registryDigest:live.registry.registryDigest});
}
