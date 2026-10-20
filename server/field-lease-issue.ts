import {randomUUID} from 'node:crypto';
import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import {canonical,digest} from './imports.ts';
import {appendClockBoundAudit} from './audit.ts';
import {DomainError} from './service.ts';
import {fieldObject,publicFieldProfileDigest} from '../integrations/field-profile.ts';
import {fieldLeaseBody,type FieldLeaseBody} from '../integrations/field-lease.ts';
import type {FieldLeaseRequest} from '../integrations/field-request.ts';
import {assertFieldRegistryCurrent,fieldRegistrySnapshot,fieldRegistryIntegrity,type FieldRegistrySnapshot} from './field-registry.ts';
import {fieldAdmissionDecision,fieldAdmissionBindingDigest} from './field-admission.ts';
export function prepareFieldLeaseIssuance(store:Store,data:ImportView,request:FieldLeaseRequest,raw:FieldRegistrySnapshot):FieldLeaseBody{
 const snapshot=fieldRegistrySnapshot(raw),channel=snapshot.channels.find(c=>c.profile.source.edgeId===request.edgeId),source=channel?.profile.source;if(!channel||!source||snapshot.tenantId!==request.tenantId||source.deviceCode!==request.deviceCode||source.mapVersion!==request.mapVersion||channel.profileDigest!==request.profileDigest)throw new DomainError(401,'现场签发请求身份无效');
 const current=(at:number)=>{if(request.requestedAtMs>at||at-request.requestedAtMs>=30000)throw new DomainError(401,'现场签发请求已失效');const registry=assertFieldRegistryCurrent(store,snapshot),decision=fieldAdmissionDecision(store,data,channel.profile,at);if(!decision.allowed)throw new DomainError(409,decision.reason||'FIELD_APPROVAL_DENIED');if(Date.parse(registry.observedAt)>at)throw fieldRegistryIntegrity();return {registry,decision,admissionDigest:fieldAdmissionBindingDigest(decision)};};
 // Current root, registry, configuration and approval are checked before the
 // old issuance receipt. Replays never refresh the original expiry.
 const now=Date.now(),live=current(now),found=store.audits.filter(a=>a.tenantId===request.tenantId&&a.objectType==='FIELD_LEASE'&&a.objectId===request.requestId),requestDigest=digest(canonical(request));if(found.length>1)throw fieldRegistryIntegrity();
 if(found.length){const event=found[0];let m:Record<string,unknown>,body:FieldLeaseBody;try{m=fieldObject(event.metadata,['format','requestDigest','leaseBody','registryEventId','admissionBinding']);body=fieldLeaseBody(m.leaseBody);}catch{throw fieldRegistryIntegrity();}
  if(event.action!=='FIELD_LEASE_ISSUED'||event.actorType!=='INTERFACE'||event.actorId!==source.edgeId||event.correlationId!==request.requestId||event.before!==undefined||event.after!==undefined||m.format!=='idms-field-lease-issuance-v1'||new Date(body.issuedAtMs).toISOString()!==event.businessTime||canonical(body)!==canonical(m.leaseBody))throw fieldRegistryIntegrity();
  if(m.requestDigest!==requestDigest)throw new DomainError(409,'FIELD_LEASE_REQUEST_CONFLICT');
  const original=fieldAdmissionDecision(store,data,channel.profile,body.issuedAtMs);if(!original.allowed||canonical(original.binding)!==canonical(m.admissionBinding)||body.admissionDigest!==fieldAdmissionBindingDigest(original)||body.profileDigest!==publicFieldProfileDigest(channel.profile)||body.keyId!==snapshot.leaseKeyId||body.requestId!==request.requestId||body.tenantId!==source.tenantId||body.edgeId!==source.edgeId||body.deviceCode!==source.deviceCode||body.mapVersion!==source.mapVersion||body.expiresAtMs!==Math.min(body.issuedAtMs+original.leaseDurationMs,original.nextBoundary??Infinity))throw fieldRegistryIntegrity();
  if(body.admissionDigest!==live.admissionDigest||body.registryDigest!==live.registry.registryDigest||body.registryRevision!==live.registry.revision||m.registryEventId!==live.registry.registryEventId)throw new DomainError(409,'FIELD_LEASE_APPROVAL_OR_REGISTRY_CHANGED');if(now>=body.expiresAtMs)throw new DomainError(409,'FIELD_LEASE_EXPIRED');return body;
 }
 const offset=store.audits.length;let lease:FieldLeaseBody|undefined;
 try{appendClockBoundAudit(store,businessTime=>{const issuedAtMs=Date.parse(businessTime),exact=current(issuedAtMs),expiresAtMs=Math.min(issuedAtMs+exact.decision.leaseDurationMs,exact.decision.nextBoundary??Infinity);lease=fieldLeaseBody({format:'idms-field-channel-lease-v1',keyId:snapshot.leaseKeyId,leaseId:randomUUID(),requestId:request.requestId,tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion,profileDigest:channel.profileDigest,admissionDigest:exact.admissionDigest,registryRevision:exact.registry.revision,registryDigest:exact.registry.registryDigest,issuedAtMs,expiresAtMs});return {tenantId:source.tenantId,objectType:'FIELD_LEASE',objectId:request.requestId,action:'FIELD_LEASE_ISSUED',actorType:'INTERFACE',actorId:source.edgeId,correlationId:request.requestId,metadata:{format:'idms-field-lease-issuance-v1',requestDigest,leaseBody:lease,registryEventId:exact.registry.registryEventId,admissionBinding:exact.decision.binding}};});return lease!;}catch(e){store.audits.splice(offset);throw e;}
}
