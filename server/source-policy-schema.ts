import {object,keys,text} from './schema-primitives.ts';
import {calendarTime} from './calendar-schema.ts';
import {DomainError} from './service.ts';
export const sourcePolicyVersion='telemetry-source-governance-1.0.0';
export interface SourceDefinitionRef {batchId:string;sourceRow:number;recordVersion:number;snapshotDigest:string}
export interface SourcePolicyPoint {tagCode:string;nodeId:string;unit:string;definitionRef:SourceDefinitionRef}
export interface SourcePolicyMapping {origin:'SIMULATOR'|'FIELD';mapVersion:string;points:SourcePolicyPoint[]}
export interface SourcePolicyEntry {id:string;effectiveFrom:string;reason:string;mapping:SourcePolicyMapping|null}
export interface SourcePolicy {deviceCode:string;edgeId:string;definitionVersion:typeof sourcePolicyVersion;changeIntent:'INITIAL'|'PROSPECTIVE'|'RETROSPECTIVE_CORRECTION';changeReason:string;entries:SourcePolicyEntry[]}
const clean=(v:unknown,label:string,max:number)=>{const s=text(v,label,max);if(/[\u0000-\u001f\u007f]/.test(s))throw new DomainError(400,label+'不能含控制字符');return s;};
export function sourcePolicySchema(raw:unknown):SourcePolicy{
 const p=object(raw,'来源治理策略');keys(p,['deviceCode','edgeId','definitionVersion','changeIntent','changeReason','entries']);const deviceCode=clean(p.deviceCode,'设备编码',128),edgeId=clean(p.edgeId,'采集源编码',80),changeReason=clean(p.changeReason,'来源变更依据',2000);
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deviceCode)||!/^[A-Za-z0-9_-]+$/.test(edgeId)||p.definitionVersion!==sourcePolicyVersion||!['INITIAL','PROSPECTIVE','RETROSPECTIVE_CORRECTION'].includes(String(p.changeIntent)))throw new DomainError(400,'来源身份、定义版本或变更意图无效');
 if(!Array.isArray(p.entries)||!p.entries.length||p.entries.length>64)throw new DomainError(400,'来源策略须有1至64条生效定义');const ids=new Set<string>();let previous=-Infinity,totalPoints=0;
 const entries=p.entries.map(raw=>{const e=object(raw,'来源生效条目');keys(e,['id','effectiveFrom','reason','mapping']);const id=clean(e.id,'条目编码',64),at=calendarTime(e.effectiveFrom),reason=clean(e.reason,'生效依据',500);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)||ids.has(id)||at<=previous)throw new DomainError(400,'来源条目编码须唯一，生效时间须严格递增');ids.add(id);previous=at;
  let mapping:SourcePolicyMapping|null=null;if(e.mapping!==null){const m=object(e.mapping,'批准点表');keys(m,['origin','mapVersion','points']);const mapVersion=clean(m.mapVersion,'点表版本',128);if(!['SIMULATOR','FIELD'].includes(String(m.origin))||!Array.isArray(m.points)||!m.points.length||m.points.length>128)throw new DomainError(400,'批准点表须有1至128测点及明确来源标记');const tags=new Set<string>(),nodes=new Set<string>();totalPoints+=m.points.length;if(totalPoints>512)throw new DomainError(400,'来源策略全版最多512个测点绑定');
   const points=m.points.map(raw=>{const p=object(raw,'批准测点');keys(p,['tagCode','nodeId','unit','definitionRef']);const tagCode=clean(p.tagCode,'测点编码',128),nodeId=clean(p.nodeId,'只读节点编码',512),unit=clean(p.unit,'测点单位',64);if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tagCode)||tags.has(tagCode)||nodes.has(nodeId))throw new DomainError(400,'同一批准点表的测点和节点须分别唯一');tags.add(tagCode);nodes.add(nodeId);const r=object(p.definitionRef,'批准定义引用');keys(r,['batchId','sourceRow','recordVersion','snapshotDigest']);if(typeof r.batchId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.batchId)||!Number.isSafeInteger(r.sourceRow)||Number(r.sourceRow)<2||!Number.isSafeInteger(r.recordVersion)||Number(r.recordVersion)<1||typeof r.snapshotDigest!=='string'||!/^[a-f0-9]{64}$/.test(r.snapshotDigest))throw new DomainError(400,'批准定义引用的批次、源行、版本或摘要无效');return {tagCode,nodeId,unit,definitionRef:{batchId:r.batchId,sourceRow:Number(r.sourceRow),recordVersion:Number(r.recordVersion),snapshotDigest:r.snapshotDigest}};});mapping={origin:m.origin as SourcePolicyMapping['origin'],mapVersion,points};
  }return {id,effectiveFrom:new Date(at).toISOString(),reason,mapping};
 });return {deviceCode,edgeId,definitionVersion:sourcePolicyVersion,changeIntent:p.changeIntent as SourcePolicy['changeIntent'],changeReason,entries};
}
export function sourcePolicyEntry(policy:SourcePolicy,at:number){return policy.entries.filter(e=>calendarTime(e.effectiveFrom)<=at).at(-1)||null;}
