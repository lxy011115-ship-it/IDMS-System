import type {EdgeSource} from '../integrations/telemetry.ts';
import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import {qualitySources,type QualitySource} from './telemetry-quality.ts';
import {calendarTime} from './calendar-schema.ts';
import {object,keys} from './schema-primitives.ts';

export const registryIntegrity=()=>new DomainError(503,'接入配置观察历史、顺序或来源不可验证');
export interface RegistrySnapshot {format:1;tenantId:string;sources:QualitySource[]}
const validTenant=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(s);
const sha=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export function publicRegistry(sources:readonly EdgeSource[],tenant:string):RegistrySnapshot{
 if(!validTenant(tenant))throw registryIntegrity();
 const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
 const selected=qualitySources(sources,tenant).map(s=>({...s,points:[...s.points].sort((a,b)=>compare(a.tagCode,b.tagCode))})).sort((a,b)=>compare(a.edgeId,b.edgeId));
 if(selected.some(s=>!validTenant(s.tenantId)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s.deviceCode)))throw registryIntegrity();
 return {format:1,tenantId:tenant,sources:selected};
}
export function registrySnapshot(raw:unknown):RegistrySnapshot{
 try{const value=object(raw);keys(value,['format','tenantId','sources']);if(value.format!==1||!validTenant(value.tenantId)||!Array.isArray(value.sources))throw Error();
  for(const source of value.sources){const s=object(source);keys(s,['tenantId','edgeId','deviceCode','mapVersion','origin','points']);if(s.tenantId!==value.tenantId||!Array.isArray(s.points))throw Error();for(const p of s.points)keys(object(p),['tagCode','nodeId','unit']);}
  const parsed=publicRegistry(value.sources as EdgeSource[],value.tenantId);if(canonical(parsed)!==canonical(raw))throw Error();return parsed;
 }catch{throw registryIntegrity();}
}
export interface RegistryRow {tenant_id:string;revision:string;observed_at:string;writer_id:string;configuration_hash:string;previous_hash:string;hash:string;body:RegistrySnapshot}
export interface RegistryHead {tenant_id:string;count:string;revision:string;hash:string}
const revision=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(v)||BigInt(v)>9223372036854775807n)throw registryIntegrity();return BigInt(v);};
export function registryRowHash(row:Omit<RegistryRow,'hash'>){return digest(canonical({format:1,tenantId:row.tenant_id,revision:row.revision,observedAt:row.observed_at,writerId:row.writer_id,configurationHash:row.configuration_hash,previousHash:row.previous_hash,snapshot:row.body}));}
export function registryObservation(snapshot:RegistrySnapshot,last:RegistryRow|null,observedAt:string,writerId:string):RegistryRow|null{
 const body=registrySnapshot(snapshot),at=calendarTime(observedAt);if(new Date(at).toISOString()!==observedAt||!/^[A-Za-z0-9._:-]{1,100}$/.test(writerId)||last&&last.tenant_id!==body.tenantId||last&&at<calendarTime(last.observed_at))throw registryIntegrity();
 const configuration_hash=digest(canonical(body));if(last?.configuration_hash===configuration_hash)return null;
 const row={tenant_id:body.tenantId,revision:String(last?revision(last.revision)+1n:1n),observed_at:observedAt,writer_id:writerId,configuration_hash,previous_hash:last?.hash||'GENESIS',body};revision(row.revision);return {...row,hash:registryRowHash(row)};
}
export class RegistryChain {
 private position=0n;private previous='GENESIS';private time=-Infinity;private closed=false;
 last:RegistryRow|null=null;selected:RegistryRow|null=null;firstObservedAt:string|null=null;
 readonly tenant:string;readonly knownAt:number;
 constructor(tenant:string,knownAt:number){if(!validTenant(tenant)||!Number.isFinite(knownAt))throw registryIntegrity();this.tenant=tenant;this.knownAt=knownAt;}
 accept(row:RegistryRow){
  if(this.closed)throw registryIntegrity();
  try{const body=registrySnapshot(row.body),at=calendarTime(row.observed_at);if(row.tenant_id!==this.tenant||body.tenantId!==this.tenant||revision(row.revision)!==this.position+1n||row.previous_hash!==this.previous||!sha(row.configuration_hash)||!sha(row.hash)||!/^[A-Za-z0-9._:-]{1,100}$/.test(row.writer_id)||new Date(at).toISOString()!==row.observed_at||at<this.time||row.configuration_hash!==digest(canonical(body))||row.hash!==registryRowHash(row)||this.last?.configuration_hash===row.configuration_hash)throw Error();
   this.position++;this.previous=row.hash;this.time=at;this.last=row;this.firstObservedAt??=row.observed_at;if(at<=this.knownAt)this.selected=row;
  }catch{this.discard();throw registryIntegrity();}
 }
 finish(head:RegistryHead){try{if(this.closed||head.tenant_id!==this.tenant||revision(head.count)!==this.position||revision(head.revision)!==this.position||head.hash!==this.previous)throw Error();this.closed=true;return {selected:this.selected,last:this.last,firstObservedAt:this.firstObservedAt,verifiedRevisions:String(this.position),chainTip:this.previous,knowledgeBasis:'SERVER_OBSERVED_CONFIGURATION' as const};}catch{this.discard();throw registryIntegrity();}}
 discard(){this.closed=true;this.last=null;this.selected=null;this.firstObservedAt=null;}
}
