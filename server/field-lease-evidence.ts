import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import type {AuditEvent} from './domain.ts';
import {canonical,digest} from './imports.ts';
import {fieldObject} from '../integrations/field-profile.ts';
import {fieldLeaseBody} from '../integrations/field-lease.ts';
import {fieldRegistrySnapshot,fieldRegistryIntegrity} from './field-registry.ts';
import {fieldAdmissionDecision,fieldAdmissionBindingDigest} from './field-admission.ts';
// Public persisted evidence only: no historical HMAC reauthentication and no
// assertion that the gateway read or physically commissioned an OT device.
export function inspectFieldLeaseEvidence(store:Pick<Store,'templates'|'audits'>,data:ImportView,event:AuditEvent,registryEvents:ReadonlyMap<string,AuditEvent>){
 try{const m=fieldObject(event.metadata,['format','requestDigest','leaseBody','registryEventId','admissionBinding']),body=fieldLeaseBody(m.leaseBody),observation=typeof m.registryEventId==='string'?registryEvents.get(m.registryEventId):undefined;if(!observation)throw Error();const registry=fieldRegistrySnapshot(observation.after),channel=registry.channels.find(c=>c.profile.source.edgeId===body.edgeId),profile=channel?.profile;
  if(!profile||event.tenantId!==body.tenantId||event.objectType!=='FIELD_LEASE'||event.objectId!==body.requestId||event.action!=='FIELD_LEASE_ISSUED'||event.actorType!=='INTERFACE'||event.actorId!==body.edgeId||event.correlationId!==body.requestId||event.before!==undefined||event.after!==undefined||event.businessTime!==new Date(body.issuedAtMs).toISOString()||m.format!=='idms-field-lease-issuance-v1'||typeof m.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(m.requestDigest)||canonical(body)!==canonical(m.leaseBody)||registry.tenantId!==body.tenantId||registry.leaseKeyId!==body.keyId||channel!.profileDigest!==body.profileDigest||profile.source.deviceCode!==body.deviceCode||profile.source.mapVersion!==body.mapVersion||observation.tenantId!==body.tenantId||observation.objectType!=='FIELD_REGISTRY'||observation.metadata.revision!==body.registryRevision||observation.metadata.registryDigest!==body.registryDigest||digest(canonical(registry))!==body.registryDigest||Date.parse(observation.businessTime)>body.issuedAtMs)throw Error();
  const original=fieldAdmissionDecision(store,data,profile,body.issuedAtMs);if(!original.allowed||canonical(original.binding)!==canonical(m.admissionBinding)||fieldAdmissionBindingDigest(original)!==body.admissionDigest||body.expiresAtMs!==Math.min(body.issuedAtMs+original.leaseDurationMs,original.nextBoundary??Infinity))throw Error();
  return {leaseId:body.leaseId,requestId:body.requestId,issuedAt:new Date(body.issuedAtMs).toISOString(),expiresAt:new Date(body.expiresAtMs).toISOString(),profileDigest:body.profileDigest,admissionDigest:body.admissionDigest,registry:{revision:body.registryRevision,digest:body.registryDigest,eventId:observation.eventId},fieldPolicy:original.binding.policySource,sourcePolicy:original.binding.sourceConfiguration.policySource,entryId:original.binding.entryId,auditEventId:event.eventId,fieldCommissioned:false as const};
 }catch{throw fieldRegistryIntegrity();}
}
