import type {TemplateVersion} from './domain.ts';
import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import {canonical} from './imports.ts';
import {DomainError} from './service.ts';
import {sourcePolicySchema,type SourcePolicy} from './source-policy-schema.ts';
import {sourceGovernanceIntegrity,validateSourcePolicyReferences} from './source-policy-references.ts';
import {templatePublication,publicationIndex,type PublicationEvidence} from './template-history.ts';
export const isSourcePolicy=(t:Pick<TemplateVersion,'manifest'>)=>t.manifest.purpose==='telemetry-source-policy';
const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
export function sourcePolicyHistory(templates:readonly TemplateVersion[],tenant:string,edge:string,knownAt:number,get:(id:string)=>PublicationEvidence|undefined,witnesses?:ReadonlyMap<string,PublicationEvidence>){
 try{if(!Number.isFinite(knownAt))throw Error();const edgeOf=(t:TemplateVersion|undefined)=>(t?.manifest?.telemetrySourcePolicy as {edgeId?:unknown})?.edgeId;
  if(witnesses)for(const [id,evidence]of witnesses)if(edgeOf(evidence.approval?.after as TemplateVersion|undefined)===edge&&!templates.some(t=>t.tenantId===tenant&&t.id===id))throw Error();
  const candidates=templates.filter(t=>t.tenantId===tenant&&((isSourcePolicy(t)&&['PUBLISHED','RETIRED'].includes(t.status)&&edgeOf(t)===edge)||edgeOf(get(t.id)?.approval?.after as TemplateVersion|undefined)===edge));
  if(new Set(candidates.map(t=>t.templateKey)).size>1)throw Error();const versions=candidates.map(item=>({item,publication:templatePublication(item,get(item.id)),policy:sourcePolicySchema(item.manifest.telemetrySourcePolicy)})).sort((a,b)=>compare(a.item.version,b.item.version));
  if(versions.some(v=>!isSourcePolicy(v.item)||v.policy.edgeId!==edge)||new Set(versions.map(v=>v.policy.deviceCode)).size>1||versions.length&&(versions.at(-1)!.item.status!=='PUBLISHED'||versions.filter(v=>v.item.status==='PUBLISHED').length!==1))throw Error();
  for(let i=1;i<versions.length;i++)if(compare(versions[i-1].item.version,versions[i].item.version)>=0||Date.parse(versions[i].publication.recordedAt)<Date.parse(versions[i-1].publication.recordedAt))throw Error();const selected=versions.filter(v=>Date.parse(v.publication.recordedAt)<=knownAt).at(-1);
  return {everPublished:versions.length>0,selected:selected?{policy:selected.policy,source:{templateId:selected.item.id,templateKey:selected.item.templateKey,version:selected.item.version,contentDigest:selected.item.contentDigest!,recordedAt:selected.publication.recordedAt,governanceEventId:selected.publication.approval.eventId,changeIntent:selected.policy.changeIntent,changeReason:selected.policy.changeReason}}:null};
 }catch{throw sourceGovernanceIntegrity();}
}
export type SourcePolicyContext=ReturnType<typeof sourcePolicyHistory>;
export function validateSourcePublication(store:Pick<Store,'templates'|'audits'>,item:TemplateVersion,recordedAt:string,data?:ImportView){
 if(!isSourcePolicy(item))return;const policy=sourcePolicySchema(item.manifest.telemetrySourcePolicy),at=Date.parse(recordedAt);validateSourcePolicyReferences(policy,data,store.audits,item.tenantId,at);const current=store.templates.find(t=>t.tenantId===item.tenantId&&t.templateKey===item.templateKey&&t.status==='PUBLISHED');if(!current){if(policy.changeIntent!=='INITIAL')throw new DomainError(409,'首个来源治理版本须为INITIAL');return;}
 if(policy.changeIntent==='INITIAL')throw new DomainError(409,'已有来源治理须明确未来调整或历史修订');const evidence=publicationIndex(store.audits,item.tenantId),prior=templatePublication(current,evidence.get(current.id));if(at<Date.parse(prior.recordedAt))throw new DomainError(409,'来源治理批准记录时间倒退');
 if(policy.changeIntent==='PROSPECTIVE'){const past=(p:SourcePolicy)=>p.entries.filter(e=>Date.parse(e.effectiveFrom)<=at);if(canonical(past(sourcePolicySchema(current.manifest.telemetrySourcePolicy)))!==canonical(past(policy)))throw new DomainError(409,'未来调整不能改变已生效来源条目；历史修改须RETROSPECTIVE_CORRECTION');}
}
