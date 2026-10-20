import type {AuditEvent} from './domain.ts';
import type {ImportView} from './imports.ts';
import {canonical} from './imports.ts';
import {revisionFacts} from './import-revisions.ts';
import {historicalImportPlan,importHistoryIndex,historicalRecord,type HistoricalImportRecord} from './asof-imports.ts';
import {DomainError} from './service.ts';
import type {SourceDefinitionRef,SourcePolicy,SourcePolicyPoint} from './source-policy-schema.ts';
import {sourcePolicyEntry} from './source-policy-schema.ts';
export const sourceGovernanceIntegrity=()=>new DomainError(503,'来源治理历史、批准引用或接收绑定不可验证');
const refKey=(r:SourceDefinitionRef)=>canonical([r.batchId,r.sourceRow,r.recordVersion,r.snapshotDigest]);
export const sourceDefinitionRef=(h:HistoricalImportRecord):SourceDefinitionRef=>({batchId:h.source.batchId,sourceRow:h.source.sourceRow,recordVersion:h.source.recordVersion,snapshotDigest:h.source.snapshotDigest});
export function sourceGovernanceFacts(data:ImportView,events:readonly AuditEvent[],tenant:string,knownAt:number){
 const index=importHistoryIndex(events,tenant),plan=historicalImportPlan(data.batches,tenant,knownAt,id=>index.get(id)),ordered=[...plan.values()].sort((a,b)=>BigInt(a.history.sequence)<BigInt(b.history.sequence)?-1:1).map(p=>data.batches.find(b=>b.batchId===p.batch.batchId&&b.tenantId===tenant)!),roots=data.records.filter(r=>r.tenantId===tenant&&plan.has(r.batchId));
 let facts:ReturnType<typeof revisionFacts>;try{facts=revisionFacts({batches:ordered,records:roots},tenant);}catch{throw sourceGovernanceIntegrity();}
 const all=new Map<string,HistoricalImportRecord>();for(const r of roots){const h=historicalRecord(r,1,plan),key=refKey(sourceDefinitionRef(h));if(all.has(key))throw sourceGovernanceIntegrity();all.set(key,h);}for(const f of facts.facts){const h=historicalRecord(f.record,f.revision,plan),key=refKey(sourceDefinitionRef(h));if(all.has(key))throw sourceGovernanceIntegrity();all.set(key,h);}
 const current=[...facts.current.values()].map(f=>historicalRecord(f.record,f.revision,plan));return {all,current};
}
export type SourceGovernanceFacts=ReturnType<typeof sourceGovernanceFacts>;
export function referencedPoint(facts:SourceGovernanceFacts,policy:Pick<SourcePolicy,'deviceCode'>,point:SourcePolicyPoint){
 const h=facts.all.get(refKey(point.definitionRef)),v=h?.record.value;if(!h||h.record.dataType!=='POINT_DEFINITION'||v!.device_code!==policy.deviceCode||v!.tag_code!==point.tagCode||v!.unit!==point.unit)throw new DomainError(409,'来源策略引用不是本设备同测点同单位的已批准定义');if(!Number.isFinite(Number(v!.min_value))||!Number.isFinite(Number(v!.max_value))||Number(v!.min_value)>=Number(v!.max_value))throw sourceGovernanceIntegrity();return h;
}
export function validateSourcePolicyReferences(policy:SourcePolicy,data:ImportView|undefined,events:readonly AuditEvent[],tenant:string,at:number){
 if(!data)throw new DomainError(409,'来源策略需要可验证的批准设备和测点定义');const facts=sourceGovernanceFacts(data,events,tenant,at),assets=facts.current.filter(h=>h.record.dataType==='DEVICE'&&h.record.value.device_code===policy.deviceCode);if(assets.length!==1)throw new DomainError(409,'来源策略设备不是唯一当前批准设备');
 const definitions=new Map<string,HistoricalImportRecord>();for(const h of facts.current.filter(h=>h.record.dataType==='POINT_DEFINITION'&&h.record.value.device_code===policy.deviceCode)){const tag=String(h.record.value.tag_code);if(definitions.has(tag))throw sourceGovernanceIntegrity();definitions.set(tag,h);}
 const active=sourcePolicyEntry(policy,at);for(const entry of policy.entries)for(const point of entry.mapping?.points||[]){const ref=referencedPoint(facts,policy,point);if(entry===active||Date.parse(entry.effectiveFrom)>at){const current=definitions.get(point.tagCode);if(!current||canonical(sourceDefinitionRef(current))!==canonical(sourceDefinitionRef(ref)))throw new DomainError(409,'当前或未来来源条目必须引用当前批准定义；请先核对定义更正和切换时间');}}
 return facts;
}
