import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {fieldRegistryHistory,fieldRegistrySnapshot,type FieldRegistrySnapshot} from './field-registry.ts';
import {inspectFieldLeaseEvidence} from './field-lease-evidence.ts';
import {fieldLeaseBody,type FieldLeaseBody} from '../integrations/field-lease.ts';
import {stateValueText} from './state-map-v1.ts';
import type {LegacyEntry} from './legacy-map-v4.ts';
import type {AuditEvent} from './domain.ts';

export const fieldRuntimeMapFormatV1='IDMS_FIELD_RUNTIME_MAP_V1';
export interface FieldRegistryMapHeadV1 {format:typeof fieldRuntimeMapFormatV1;tenantId:string;snapshot:FieldRegistrySnapshot;revision:string;registryDigest:string;registryEventId:string;observedAt:string}
export interface FieldIssuanceMapIndexV1 {format:typeof fieldRuntimeMapFormatV1;tenantId:string;requestId:string;auditEventId:string}
export const fieldIssuanceMapKeyV1=(requestId:string)=>{if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId))throw Error('FIELD_MAP_INTEGRITY');return requestId;};
export function fieldRegistryMapHeadV1(snapshot:FieldRegistrySnapshot,event:AuditEvent):FieldRegistryMapHeadV1{
 return {format:fieldRuntimeMapFormatV1,tenantId:snapshot.tenantId,snapshot,revision:String(event.metadata.revision),registryDigest:canonicalDigest(snapshot),registryEventId:event.eventId,observedAt:event.businessTime};
}
/** Maintenance only: complete audited history proves absent runtime indexes. */
export function compileFieldRuntimeMapV1(payload:TenantPayload,tenantId:string):LegacyEntry[]{
 validateTenantPayload(payload,tenantId);const history=fieldRegistryHistory(payload.audits,tenantId),entries:LegacyEntry[]=[{namespace:'domain_head',key:'field_runtime',valueText:stateValueText({format:fieldRuntimeMapFormatV1,tenantId})}];
 if(history.last)entries.push({namespace:'domain_head',key:'field_registry',valueText:stateValueText(fieldRegistryMapHeadV1(history.last.snapshot,history.last.event))});
 const observations=new Map(payload.audits.filter(a=>a.objectType==='FIELD_REGISTRY').map(a=>[a.eventId,a])),ids=new Set<string>(),store={...payload.business,audits:payload.audits};
 for(const a of payload.audits)if(a.objectType==='FIELD_LEASE'){
  inspectFieldLeaseEvidence(store,payload.imports,a,observations);const body=fieldLeaseBody(a.metadata.leaseBody);if(ids.has(body.requestId))throw Error('FIELD_MAP_DUPLICATE_ISSUANCE');ids.add(body.requestId);
  const value:FieldIssuanceMapIndexV1={format:fieldRuntimeMapFormatV1,tenantId,requestId:body.requestId,auditEventId:a.eventId};entries.push({namespace:'field_issuance',key:fieldIssuanceMapKeyV1(body.requestId),valueText:stateValueText(value)});
 }
 return entries;
}

/** Local audit membership is verified by the caller against one trusted root. */
export function inspectRegistryMapHeadV1(head:FieldRegistryMapHeadV1,event:AuditEvent){
 const snapshot=fieldRegistrySnapshot(head.snapshot),m=event.metadata;
 if(!canonicalEqual(head,fieldRegistryMapHeadV1(snapshot,event))||snapshot.tenantId!==head.tenantId||event.tenantId!==head.tenantId||event.objectType!=='FIELD_REGISTRY'||event.objectId!==head.tenantId||event.action!=='FIELD_REGISTRY_OBSERVED'||event.actorType!=='SYSTEM'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(event.actorId)||event.before!==undefined||!canonicalEqual(event.after,snapshot)||m.format!=='idms-field-registry-observation-v1'||! /^[1-9][0-9]{0,18}$/.test(head.revision)||BigInt(head.revision)>9223372036854775807n||new Date(Date.parse(head.observedAt)).toISOString()!==head.observedAt)throw Error('FIELD_MAP_REGISTRY_INTEGRITY');
 if(m.revision!==head.revision||m.registryDigest!==head.registryDigest||Object.keys(m).sort().join(',')!==['format','revision','registryDigest','previousRegistryEventId','previousRegistryDigest'].sort().join(','))throw Error('FIELD_MAP_REGISTRY_INTEGRITY');
 if(head.revision==='1'?(m.previousRegistryEventId!==null||m.previousRegistryDigest!==null):!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(String(m.previousRegistryEventId))&&/^[a-f0-9]{64}$/.test(String(m.previousRegistryDigest))&&m.previousRegistryDigest!==head.registryDigest))throw Error('FIELD_MAP_REGISTRY_INTEGRITY');
 return snapshot;
}

export function issuanceBodyFromMapV1(index:FieldIssuanceMapIndexV1,event:AuditEvent,tenantId:string,requestId:string):FieldLeaseBody{
 const body=fieldLeaseBody(event.metadata.leaseBody);
 if(!canonicalEqual(index,{format:fieldRuntimeMapFormatV1,tenantId,requestId,auditEventId:event.eventId})||body.tenantId!==tenantId||body.requestId!==requestId||event.tenantId!==tenantId||event.objectType!=='FIELD_LEASE'||event.objectId!==requestId||event.action!=='FIELD_LEASE_ISSUED'||event.actorType!=='INTERFACE'||event.actorId!==body.edgeId||event.correlationId!==requestId||event.before!==undefined||event.after!==undefined||event.businessTime!==new Date(body.issuedAtMs).toISOString()||event.metadata.format!=='idms-field-lease-issuance-v1'||!/^[a-f0-9]{64}$/.test(String(event.metadata.requestDigest))||Object.keys(event.metadata).sort().join(',')!==['format','requestDigest','leaseBody','registryEventId','admissionBinding'].sort().join(','))throw Error('FIELD_MAP_ISSUANCE_INTEGRITY');
 return body;
}
