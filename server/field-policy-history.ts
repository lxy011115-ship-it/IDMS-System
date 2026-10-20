import type {TemplateVersion} from './domain.ts';
import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import {canonical} from './imports.ts';
import {DomainError} from './service.ts';
import {fieldPolicySchema,fieldPolicyEntry,type FieldPolicy,type FieldSourcePolicyRef,type FieldAdmission} from './field-policy-schema.ts';
import {sourcePolicySchema,sourcePolicyEntry} from './source-policy-schema.ts';
import {sourcePolicyHistory} from './source-policy-history.ts';
import {sourceGovernanceFacts,referencedPoint,validateSourcePolicyReferences} from './source-policy-references.ts';
import {templatePublication,publicationIndex,type PublicationEvidence} from './template-history.ts';
export const isFieldPolicy=(t:Pick<TemplateVersion,'manifest'>)=>t.manifest.purpose==='field-channel-policy';
export const fieldPolicyIntegrity=()=>new DomainError(503,'现场通道历史或批准依据不可验证');
export const exactFieldSourceRef=(t:Pick<TemplateVersion,'id'|'templateKey'|'version'|'contentDigest'>):FieldSourcePolicyRef=>({templateId:t.id,templateKey:t.templateKey,version:t.version,contentDigest:t.contentDigest!});
const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
export function fieldPolicyHistory(templates:readonly TemplateVersion[],tenant:string,edge:string,knownAt:number,get:(id:string)=>PublicationEvidence|undefined,witnesses?:ReadonlyMap<string,PublicationEvidence>){
 try{if(!Number.isFinite(knownAt))throw Error();const edgeOf=(t:TemplateVersion|undefined)=>(t?.manifest?.fieldChannelPolicy as {edgeId?:unknown})?.edgeId;
  if(witnesses)for(const [id,e]of witnesses)if(edgeOf(e.approval?.after as TemplateVersion|undefined)===edge&&!templates.some(t=>t.tenantId===tenant&&t.id===id))throw Error();
  const candidates=templates.filter(t=>t.tenantId===tenant&&((isFieldPolicy(t)&&['PUBLISHED','RETIRED'].includes(t.status)&&edgeOf(t)===edge)||edgeOf(get(t.id)?.approval?.after as TemplateVersion|undefined)===edge));if(new Set(candidates.map(t=>t.templateKey)).size>1)throw Error();
  const versions=candidates.map(item=>({item,publication:templatePublication(item,get(item.id)),policy:fieldPolicySchema(item.manifest.fieldChannelPolicy)})).sort((a,b)=>compare(a.item.version,b.item.version));
  if(versions.some(v=>!isFieldPolicy(v.item)||v.policy.edgeId!==edge)||new Set(versions.map(v=>v.policy.deviceCode)).size>1||versions.length&&(versions.at(-1)!.item.status!=='PUBLISHED'||versions.filter(v=>v.item.status==='PUBLISHED').length!==1))throw Error();
  for(let i=1;i<versions.length;i++)if(compare(versions[i-1].item.version,versions[i].item.version)>=0||Date.parse(versions[i].publication.recordedAt)<Date.parse(versions[i-1].publication.recordedAt))throw Error();
  const selected=versions.filter(v=>Date.parse(v.publication.recordedAt)<=knownAt).at(-1);return {everPublished:versions.length>0,selected:selected?{policy:selected.policy,source:{...exactFieldSourceRef(selected.item),recordedAt:selected.publication.recordedAt,governanceEventId:selected.publication.approval.eventId}}:null};
 }catch{throw fieldPolicyIntegrity();}
}
export type FieldPolicyContext=ReturnType<typeof fieldPolicyHistory>;
function requireSourceMapping(admission:FieldAdmission,policy:ReturnType<typeof sourcePolicySchema>,from:number,to:number){
 const starts=[from,...policy.entries.map(e=>Date.parse(e.effectiveFrom)).filter(t=>t>from&&t<to)];
 const wanted=admission.profile,points=(p:{tagCode:string;nodeId:string;unit:string}[])=>p.map(({tagCode,nodeId,unit})=>({tagCode,nodeId,unit})).sort((a,b)=>a.tagCode<b.tagCode?-1:a.tagCode>b.tagCode?1:0);
 for(const at of starts){const m=sourcePolicyEntry(policy,at)?.mapping;if(!m||m.origin!=='FIELD'||m.mapVersion!==wanted.source.mapVersion||canonical(points(m.points))!==canonical(points(wanted.points)))throw new DomainError(409,'现场通道生效期间须匹配准确来源版本的FIELD点表；暂停或切换须同步明确通道条目');}return starts;
}
export function validateFieldPolicyReferences(store:Pick<Store,'templates'|'audits'>,policy:FieldPolicy,tenant:string,at:number,data?:ImportView){
 if(!data||!Number.isFinite(at))throw new DomainError(409,'现场通道需要当前批准设备和来源定义');const publications=publicationIndex(store.audits,tenant),facts=sourceGovernanceFacts(data,store.audits,tenant,at),history=sourcePolicyHistory(store.templates,tenant,policy.edgeId,at,id=>publications.get(id),publications);
 if(facts.current.filter(h=>h.record.dataType==='DEVICE'&&h.record.value.device_code===policy.deviceCode).length!==1)throw new DomainError(409,'现场通道设备须为唯一当前批准设备');
 const active=fieldPolicyEntry(policy,at);
 for(let i=0;i<policy.entries.length;i++){const e=policy.entries[i],a=e.admission;if(!a)continue;if(a.profile.source.tenantId!==tenant)throw new DomainError(409,'现场公开配置不能跨企业');const ref=a.sourcePolicyRef,item=store.templates.find(t=>t.tenantId===tenant&&t.id===ref.templateId);
  if(!item||item.manifest.purpose!=='telemetry-source-policy'||canonical(exactFieldSourceRef(item))!==canonical(ref))throw new DomainError(409,'现场通道准确来源版本不存在或摘要不符');const publication=templatePublication(item,publications.get(item.id)),source=sourcePolicySchema(item.manifest.telemetrySourcePolicy);
  if(Date.parse(publication.recordedAt)>at||source.deviceCode!==policy.deviceCode||source.edgeId!==policy.edgeId)throw new DomainError(409,'现场通道引用的来源未经本设备同源独立批准');
  const currentOrFuture=e===active||Date.parse(e.effectiveFrom)>at;
  if(currentOrFuture&&(!history.selected||canonical(ref)!==canonical({templateId:history.selected.source.templateId,templateKey:history.selected.source.templateKey,version:history.selected.source.version,contentDigest:history.selected.source.contentDigest})))throw new DomainError(409,'当前或未来通道必须引用当前准确来源发布版');
  if(currentOrFuture)validateSourcePolicyReferences(source,data,store.audits,tenant,at);
  const from=currentOrFuture?Math.max(at,Date.parse(e.effectiveFrom)):Date.parse(e.effectiveFrom),to=i+1<policy.entries.length?Date.parse(policy.entries[i+1].effectiveFrom):Infinity,starts=requireSourceMapping(a,source,from,to);
  // Pins bind the actual certificate bytes and therefore their validity. The
  // reader still checks the real certificate at every request; a declaration
  // or an approval alone never attests to certificate or field commissioning.
  for(const segment of starts)for(const point of a.profile.points){const mapping=sourcePolicyEntry(source,segment)!.mapping!,approved=mapping.points.find(p=>p.tagCode===point.tagCode)!,h=referencedPoint(facts,source,approved),v=h.record.value;
   if(point.minimum!==Number(v.min_value)||point.maximum!==Number(v.max_value))throw new DomainError(409,'现场数值范围必须与准确批准定义一致');
   if(currentOrFuture){const current=facts.current.filter(r=>r.record.dataType==='POINT_DEFINITION'&&r.record.value.device_code===policy.deviceCode&&r.record.value.tag_code===point.tagCode);if(current.length!==1||current[0].source.snapshotDigest!==h.source.snapshotDigest||current[0].source.batchId!==h.source.batchId||current[0].source.sourceRow!==h.source.sourceRow||current[0].source.recordVersion!==h.source.recordVersion)throw new DomainError(409,'现场通道定义已更正，必须重新核对来源和通道审批');}
  }
 }return {history,facts};
}
export function validateFieldPublication(store:Pick<Store,'templates'|'audits'>,item:TemplateVersion,recordedAt:string,data?:ImportView){
 if(!isFieldPolicy(item))return;const policy=fieldPolicySchema(item.manifest.fieldChannelPolicy),at=Date.parse(recordedAt);validateFieldPolicyReferences(store,policy,item.tenantId,at,data);
 const current=store.templates.find(t=>t.tenantId===item.tenantId&&t.templateKey===item.templateKey&&t.status==='PUBLISHED');if(!current){if(policy.changeIntent!=='INITIAL')throw new DomainError(409,'首个现场通道版本须为INITIAL');return;}
 if(policy.changeIntent==='INITIAL')throw new DomainError(409,'现场通道后续版本须明确未来调整或历史修订');const index=publicationIndex(store.audits,item.tenantId),prior=templatePublication(current,index.get(current.id));if(at<Date.parse(prior.recordedAt))throw new DomainError(409,'现场通道批准记录时间倒退');
 if(policy.changeIntent==='PROSPECTIVE'){const past=(p:FieldPolicy)=>p.entries.filter(e=>Date.parse(e.effectiveFrom)<=at);if(canonical(past(fieldPolicySchema(current.manifest.fieldChannelPolicy)))!==canonical(past(policy)))throw new DomainError(409,'未来调整不能改变已生效现场条目；历史修改须RETROSPECTIVE_CORRECTION');}
}
