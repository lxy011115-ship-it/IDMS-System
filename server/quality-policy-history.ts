import type {TemplateVersion} from './domain.ts';
import type {Store} from './store.ts';
import {canonical} from './imports.ts';
import {DomainError} from './service.ts';
import {dataQualityPolicySchema,type DataQualityPolicy} from './quality-policy-schema.ts';
import {templatePublication,publicationIndex,type PublicationEvidence} from './template-history.ts';

export const isQualityPolicy=(t:Pick<TemplateVersion,'manifest'>)=>t.manifest.purpose==='data-quality-policy';
export const qualityPolicyIntegrity=()=>new DomainError(503,'质量策略历史、批准来源或生效顺序不可验证');
const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
export function qualityPolicyHistory(templates:readonly TemplateVersion[],tenant:string,device:string,knownAt:number,get:(id:string)=>PublicationEvidence|undefined){
 try{
  const candidates=templates.filter(t=>t.tenantId===tenant&&isQualityPolicy(t)&&['PUBLISHED','RETIRED'].includes(t.status)&&(t.manifest.dataQualityPolicy as {deviceCode?:unknown})?.deviceCode===device);
  if(new Set(candidates.map(t=>t.templateKey)).size>1)throw Error();
  const versions=candidates.map(item=>({item,publication:templatePublication(item,get(item.id)),policy:dataQualityPolicySchema(item.manifest.dataQualityPolicy)})).sort((a,b)=>compare(a.item.version,b.item.version));
  if(versions.length&&(versions.at(-1)!.item.status!=='PUBLISHED'||versions.filter(v=>v.item.status==='PUBLISHED').length!==1))throw Error();
  for(let i=1;i<versions.length;i++)if(compare(versions[i-1].item.version,versions[i].item.version)>=0||Date.parse(versions[i].publication.recordedAt)<Date.parse(versions[i-1].publication.recordedAt))throw Error();
  const eligible=versions.filter(v=>Date.parse(v.publication.recordedAt)<=knownAt),selected=eligible.at(-1);
  return selected?{policy:selected.policy,source:{templateId:selected.item.id,templateKey:selected.item.templateKey,version:selected.item.version,contentDigest:selected.item.contentDigest!,recordedAt:selected.publication.recordedAt,governanceEventId:selected.publication.approval.eventId,changeIntent:selected.policy.changeIntent,changeReason:selected.policy.changeReason}}:null;
 }catch{throw qualityPolicyIntegrity();}
}
export type QualityPolicyContext=ReturnType<typeof qualityPolicyHistory>;
export function validateQualityPolicyPublication(store:Pick<Store,'templates'|'audits'>,item:TemplateVersion,recordedAt:string){
 if(!isQualityPolicy(item))return;const policy=dataQualityPolicySchema(item.manifest.dataQualityPolicy),current=store.templates.find(t=>t.tenantId===item.tenantId&&t.templateKey===item.templateKey&&t.status==='PUBLISHED');
 if(!current){if(policy.changeIntent!=='INITIAL')throw new DomainError(409,'首个质量策略须选择INITIAL');return;}
 if(policy.changeIntent==='INITIAL')throw new DomainError(409,'已有质量策略须选择未来调整或历史修订');
 const index=publicationIndex(store.audits,item.tenantId),prior=templatePublication(current,index.get(current.id));if(Date.parse(recordedAt)<Date.parse(prior.recordedAt))throw new DomainError(409,'质量策略批准时间倒退');
 if(policy.changeIntent==='PROSPECTIVE'){
  const past=(v:DataQualityPolicy)=>v.entries.filter(e=>Date.parse(e.effectiveFrom)<=Date.parse(recordedAt));
  if(canonical(past(dataQualityPolicySchema(current.manifest.dataQualityPolicy)))!==canonical(past(policy)))throw new DomainError(409,'未来调整不能改变已生效质量规则；历史改动须RETROSPECTIVE_CORRECTION');
 }
}
