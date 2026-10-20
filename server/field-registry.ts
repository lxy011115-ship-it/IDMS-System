import type {Store} from './store.ts';
import type {AuditEvent} from './domain.ts';
import {canonical,digest} from './imports.ts';
import {appendAudit,verifyAuditChain} from './audit.ts';
import {DomainError} from './service.ts';
import {fieldRecoveryIdentity,type FieldRecoveryIdentity} from '../integrations/field-recovery.ts';
import {fieldObject,fieldText,fieldHash,parsePublicFieldProfile,publicFieldProfileDigest,type PublicFieldProfile} from '../integrations/field-profile.ts';
export interface FieldRegistryChannel {profile:PublicFieldProfile;profileDigest:string;requestKeySha256:string}
export interface FieldRegistrySnapshot {format:'idms-field-registry-v1'|'idms-field-registry-v2';tenantId:string;leaseKeyId:string;channels:FieldRegistryChannel[];recovery?:FieldRecoveryIdentity}
export const fieldRegistryIntegrity=()=>new DomainError(503,'现场注册观察或签发依据不可验证');
export function fieldRegistrySnapshot(raw:unknown):FieldRegistrySnapshot{
 try{const v2=(raw as any)?.format==='idms-field-registry-v2',r=fieldObject(raw,['format','tenantId','leaseKeyId','channels',...(v2?['recovery']:[])]),tenantId=fieldText(r.tenantId,80),leaseKeyId=fieldHash(r.leaseKeyId);if(r.format!==(v2?'idms-field-registry-v2':'idms-field-registry-v1')||!/^[A-Za-z0-9_-]+$/.test(tenantId)||!Array.isArray(r.channels)||r.channels.length>32)throw Error();const edges=new Set<string>(),keys=new Set<string>();let points=0;
  const channels=r.channels.map(raw=>{const c=fieldObject(raw,['profile','profileDigest','requestKeySha256']),profile=parsePublicFieldProfile(c.profile),profileDigest=fieldHash(c.profileDigest),requestKeySha256=fieldHash(c.requestKeySha256);points+=profile.points.length;if(profile.transport&&profile.transport.acknowledgementKeyId!==leaseKeyId||profile.source.tenantId!==tenantId||profileDigest!==publicFieldProfileDigest(profile)||edges.has(profile.source.edgeId)||keys.has(requestKeySha256)||points>512)throw Error();edges.add(profile.source.edgeId);keys.add(requestKeySha256);return {profile,profileDigest,requestKeySha256};}).sort((a,b)=>a.profile.source.edgeId<b.profile.source.edgeId?-1:a.profile.source.edgeId>b.profile.source.edgeId?1:0);
  return {format:v2?'idms-field-registry-v2':'idms-field-registry-v1',tenantId,leaseKeyId,channels,...(v2?{recovery:fieldRecoveryIdentity(r.recovery)}:{})};
 }catch{throw fieldRegistryIntegrity();}
}
interface Observation {event:AuditEvent;snapshot:FieldRegistrySnapshot;revision:string;registryDigest:string}
// Callers provide the complete root-verified tenant audit image from the
// business transaction. A valid prefix alone does not prove completeness.
export function fieldRegistryHistory(events:readonly AuditEvent[],tenant:string){
 if(!verifyAuditChain(events as AuditEvent[],tenant))throw fieldRegistryIntegrity();let last:Observation|null=null;let count=0n;
 for(const event of events){if(event.tenantId!==tenant||event.objectType!=='FIELD_REGISTRY')continue;
  try{const m=fieldObject(event.metadata,['format','revision','registryDigest','previousRegistryEventId','previousRegistryDigest']),snapshot=fieldRegistrySnapshot(event.after),revision=String(++count),registryDigest=digest(canonical(snapshot));
   if(event.objectId!==tenant||event.action!=='FIELD_REGISTRY_OBSERVED'||event.actorType!=='SYSTEM'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(event.actorId)||event.before!==undefined||snapshot.tenantId!==tenant||canonical(snapshot)!==canonical(event.after)||m.format!=='idms-field-registry-observation-v1'||m.revision!==revision||m.registryDigest!==registryDigest||m.previousRegistryEventId!==(last?.event.eventId||null)||m.previousRegistryDigest!==(last?.registryDigest||null)||!Number.isFinite(Date.parse(event.businessTime))||new Date(event.businessTime).toISOString()!==event.businessTime||last&&(Date.parse(event.businessTime)<Date.parse(last.event.businessTime)||registryDigest===last.registryDigest||last.snapshot.format==='idms-field-registry-v2'&&snapshot.format!=='idms-field-registry-v2'))throw Error();
   last={event,snapshot,revision,registryDigest};
  }catch{throw fieldRegistryIntegrity();}
 }return {last,count:String(count)};
}
export function appendFieldRegistryObservation(store:Store,raw:unknown,instanceId:string){
 const snapshot=fieldRegistrySnapshot(raw),tenant=snapshot.tenantId;if(!store.tenants.some(t=>t.id===tenant&&t.status==='ACTIVE')||!/^[A-Za-z0-9_.:-]{1,100}$/.test(instanceId))throw fieldRegistryIntegrity();const prior=fieldRegistryHistory(store.audits,tenant),registryDigest=digest(canonical(snapshot));if(prior.last?.snapshot.format==='idms-field-registry-v2'&&snapshot.format!=='idms-field-registry-v2')throw fieldRegistryIntegrity();if(prior.last?.registryDigest===registryDigest)return {changed:false,revision:prior.last.revision,registryDigest,registryEventId:prior.last.event.eventId};
 const offset=store.audits.length;try{const revision=String(BigInt(prior.count)+1n),event=appendAudit(store,{tenantId:tenant,objectType:'FIELD_REGISTRY',objectId:tenant,action:'FIELD_REGISTRY_OBSERVED',actorType:'SYSTEM',actorId:instanceId,correlationId:crypto.randomUUID(),after:snapshot,metadata:{format:'idms-field-registry-observation-v1',revision,registryDigest,previousRegistryEventId:prior.last?.event.eventId||null,previousRegistryDigest:prior.last?.registryDigest||null}});if(prior.last&&Date.parse(event.businessTime)<Date.parse(prior.last.event.businessTime))throw fieldRegistryIntegrity();return {changed:true,revision,registryDigest,registryEventId:event.eventId};}catch(e){store.audits.splice(offset);throw e;}
}
export function assertFieldRegistryCurrent(store:Pick<Store,'audits'>,raw:unknown){
 const snapshot=fieldRegistrySnapshot(raw),history=fieldRegistryHistory(store.audits,snapshot.tenantId),last=history.last;if(!last)throw new DomainError(409,'现场配置尚无注册观察');if(last.registryDigest!==digest(canonical(snapshot)))throw Object.assign(new DomainError(409,'运行实例的现场配置观察已过期'),{code:'FIELD_REGISTRY_STALE'});return {revision:last.revision,registryDigest:last.registryDigest,registryEventId:last.event.eventId,observedAt:last.event.businessTime};
}
