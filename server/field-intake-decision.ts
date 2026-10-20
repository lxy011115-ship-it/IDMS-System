import type {KeyObject} from 'node:crypto';
import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import {canonical} from './imports.ts';
import {fieldAdmissionDecision,fieldAdmissionBindingDigest} from './field-admission.ts';
import {assertFieldRegistryCurrent,type FieldRegistrySnapshot} from './field-registry.ts';
import {inspectFieldLeaseEvidence} from './field-lease-evidence.ts';
import {fieldStorageIntegrity} from './field-schema-check.ts';
import {fieldEventProfile,fieldStreamBinding,fieldMaxQueueAgeMs,type SignedFieldEvent} from '../integrations/field-event.ts';
export function fieldIntakeDecision(store:Pick<Store,'templates'|'audits'>,data:ImportView,rawProfile:unknown,snapshot:FieldRegistrySnapshot,event:SignedFieldEvent,key:KeyObject,at:number){
 if(!Number.isSafeInteger(at))throw fieldStorageIntegrity();const profile=fieldEventProfile(rawProfile),registry=assertFieldRegistryCurrent(store,snapshot),current=fieldAdmissionDecision(store,data,profile,at),point=fieldAdmissionDecision(store,data,profile,at,event.sample.tagCode);if(event.source.tenantId!==snapshot.tenantId||profile.source.edgeId!==event.source.edgeId||snapshot.channels.find(c=>c.profile.source.edgeId===event.source.edgeId)?.profileDigest!==event.profileDigest||Date.parse(registry.observedAt)>at)throw fieldStorageIntegrity();
 const issuance=store.audits.filter(a=>a.tenantId===event.source.tenantId&&a.objectType==='FIELD_LEASE'&&a.objectId===event.lease.body.requestId);if(issuance.length!==1||canonical(issuance[0].metadata.leaseBody)!==canonical(event.lease.body))throw fieldStorageIntegrity();const observations=new Map(store.audits.filter(a=>a.tenantId===event.source.tenantId&&a.objectType==='FIELD_REGISTRY').map(a=>[a.eventId,a])),originalLease=inspectFieldLeaseEvidence(store,data,issuance[0],observations),capture=fieldStreamBinding(profile,event.lease,key),observed=Date.parse(event.witness.observedAt);
 let reason:string|null=current.allowed&&point.allowed?null:current.reason&&/^FIELD_[A-Z0-9_]{1,96}$/.test(current.reason)?current.reason:'FIELD_CURRENT_APPROVAL_DENIED';if(!reason&&observed>at)reason='FIELD_OBSERVATION_IN_FUTURE';if(!reason&&at-observed>fieldMaxQueueAgeMs)reason='FIELD_QUEUE_AGE_EXCEEDED';if(!reason&&(capture.registryRevision!==registry.revision||capture.registryDigest!==registry.registryDigest))reason='FIELD_CAPTURE_REGISTRY_CHANGED';if(!reason&&current.allowed&&capture.admissionDigest!==fieldAdmissionBindingDigest(current))reason='FIELD_CAPTURE_APPROVAL_CHANGED';
 return {allowed:reason===null,reason,capture,registry,currentAdmission:current.binding,pointAdmission:point.binding,originalLease};
}
export type FieldIntakeDecision=ReturnType<typeof fieldIntakeDecision>;
export function fieldIntakeFingerprint(decision:FieldIntakeDecision){const {evaluatedAt:_,...binding}=decision.currentAdmission,{evaluatedAt:_point,...point}=decision.pointAdmission;return canonical({...decision,currentAdmission:binding,pointAdmission:point});}
