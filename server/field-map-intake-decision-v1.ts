import type {KeyObject} from 'node:crypto';
import {canonical, digest} from './imports.ts';
import {canonicalEqual} from './canonical-state.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {fieldRegistrySnapshot,type FieldRegistrySnapshot} from './field-registry.ts';
import {inspectRegistryMapHeadV1,fieldRegistryMapHeadV1,type FieldRegistryMapHeadV1} from './field-runtime-map-v1.ts';
import {inspectFieldIssuanceMapV1} from './field-map-lease-v1.ts';
import {readCurrentFieldAdmissionMapV1} from './field-admission-map-v1.ts';
import {fieldAdmissionBindingDigest} from './field-admission.ts';
import {assertFieldMapIntakePreparedV1} from './field-map-intake-bootstrap-v1.ts';
import {verifyLocalDomainAudit} from './telemetry-map-v4.ts';
import type {FieldMapSnapshotV1} from './field-map-audit-v1.ts';
import type {AuditEvent} from './domain.ts';
import {fieldEventProfile,fieldStreamBinding,fieldMaxQueueAgeMs,type SignedFieldEvent} from '../integrations/field-event.ts';
import type {FieldIntakeDecision} from './field-intake-decision.ts';

async function decision(s:FieldMapSnapshotV1,rawProfile:unknown,rawSnapshot:FieldRegistrySnapshot,event:SignedFieldEvent,key:KeyObject,at:number,head:FieldRegistryMapHeadV1):Promise<FieldIntakeDecision>{
 need(Number.isSafeInteger(at),'FIELD_MAP_CLOCK');await assertFieldMapIntakePreparedV1(s);const snapshot=fieldRegistrySnapshot(rawSnapshot),profile=fieldEventProfile(rawProfile);need(head.tenantId===s.tenantId,'FIELD_MAP_REGISTRY_INTEGRITY');
 inspectRegistryMapHeadV1(head,verifyLocalDomainAudit(await s.get<AuditEvent>('audit',head.registryEventId),s.tenantId));need(head.registryDigest===digest(canonical(snapshot)),'FIELD_REGISTRY_STALE');
 const current=(await readCurrentFieldAdmissionMapV1(profile,at,null,(ns,k)=>s.get(ns,k))).decision,point=(await readCurrentFieldAdmissionMapV1(profile,at,event.sample.tagCode,(ns,k)=>s.get(ns,k))).decision;
 need(event.source.tenantId===s.tenantId&&snapshot.tenantId===s.tenantId&&profile.source.edgeId===event.source.edgeId&&snapshot.channels.find(c=>c.profile.source.edgeId===event.source.edgeId)?.profileDigest===event.profileDigest&&Date.parse(head.observedAt)<=at,'FIELD_MAP_INTAKE_IDENTITY');
 const issuance=await inspectFieldIssuanceMapV1(s,event.lease.body.requestId);need(canonicalEqual(issuance.body,event.lease.body),'FIELD_MAP_ISSUANCE_INTEGRITY');
 const original=issuance.original,body=issuance.body,originalLease={leaseId:body.leaseId,requestId:body.requestId,issuedAt:new Date(body.issuedAtMs).toISOString(),expiresAt:new Date(body.expiresAtMs).toISOString(),profileDigest:body.profileDigest,admissionDigest:body.admissionDigest,registry:{revision:body.registryRevision,digest:body.registryDigest,eventId:issuance.observation.eventId},fieldPolicy:original.binding.policySource,sourcePolicy:original.binding.sourceConfiguration.policySource,entryId:original.binding.entryId,auditEventId:issuance.event.eventId,fieldCommissioned:false as const};
 const capture=fieldStreamBinding(profile,event.lease,key),observed=Date.parse(event.witness.observedAt),registry={revision:head.revision,registryDigest:head.registryDigest,registryEventId:head.registryEventId,observedAt:head.observedAt};
 let reason:string|null=current.allowed&&point.allowed?null:current.reason&&/^FIELD_[A-Z0-9_]{1,96}$/.test(current.reason)?current.reason:'FIELD_CURRENT_APPROVAL_DENIED';
 if(!reason&&observed>at)reason='FIELD_OBSERVATION_IN_FUTURE';if(!reason&&at-observed>fieldMaxQueueAgeMs)reason='FIELD_QUEUE_AGE_EXCEEDED';if(!reason&&(capture.registryRevision!==registry.revision||capture.registryDigest!==registry.registryDigest))reason='FIELD_CAPTURE_REGISTRY_CHANGED';if(!reason&&current.allowed&&capture.admissionDigest!==fieldAdmissionBindingDigest(current))reason='FIELD_CAPTURE_APPROVAL_CHANGED';
 return {allowed:reason===null,reason,capture,registry,currentAdmission:current.binding,pointAdmission:point.binding,originalLease};
}
export async function fieldIntakeDecisionMapV1(s:FieldMapSnapshotV1,profile:unknown,snapshot:FieldRegistrySnapshot,event:SignedFieldEvent,key:KeyObject,at:number){return decision(s,profile,snapshot,event,key,at,await s.get<FieldRegistryMapHeadV1>('domain_head','field_registry'));}
/** Historical inspection only; intake must always use the current-head function above. */
export async function inspectHistoricalIntakeDecisionMapV1(s:FieldMapSnapshotV1,event:SignedFieldEvent,key:KeyObject,at:number,registryEventId:string){
 const observation=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',registryEventId),s.tenantId),snapshot=fieldRegistrySnapshot(observation.after),head=fieldRegistryMapHeadV1(snapshot,observation),channel=snapshot.channels.find(c=>c.profile.source.edgeId===event.source.edgeId);need(channel,'FIELD_MAP_HISTORICAL_CHANNEL');return decision(s,channel.profile,snapshot,event,key,at,head);
}
export function fieldIntakeFingerprintMapV1(decision:FieldIntakeDecision){const {evaluatedAt:_,...binding}=decision.currentAdmission,{evaluatedAt:_point,...point}=decision.pointAdmission;return canonical({...decision,currentAdmission:binding,pointAdmission:point});}
