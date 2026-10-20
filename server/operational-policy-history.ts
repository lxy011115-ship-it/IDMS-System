import type {TemplateVersion} from './domain.ts';
import type {Store} from './store.ts';
import {canonical} from './imports.ts';
import {DomainError} from './service.ts';
import {operationalPolicySchema,type OperationalPolicy} from './operational-policy-schema.ts';
import {templatePublication,publicationIndex,type PublicationEvidence} from './template-history.ts';
export const isOperationalPolicy=(t:Pick<TemplateVersion,'manifest'>)=>t.manifest.purpose==='operational-metric-policy';
export const operationalIntegrity=()=>new DomainError(503,'运营指标输入、定义历史或计算不可验证');
const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
export function operationalPolicyHistory(templates:readonly TemplateVersion[],tenant:string,device:string,knownAt:number,get:(id:string)=>PublicationEvidence|undefined){
 try{const candidates=templates.filter(t=>t.tenantId===tenant&&isOperationalPolicy(t)&&['PUBLISHED','RETIRED'].includes(t.status)&&(t.manifest.operationalMetricPolicy as {deviceCode?:unknown})?.deviceCode===device);if(new Set(candidates.map(t=>t.templateKey)).size>1)throw Error();
  const versions=candidates.map(item=>({item,publication:templatePublication(item,get(item.id)),policy:operationalPolicySchema(item.manifest.operationalMetricPolicy)})).sort((a,b)=>compare(a.item.version,b.item.version));if(versions.length&&(versions.at(-1)!.item.status!=='PUBLISHED'||versions.filter(v=>v.item.status==='PUBLISHED').length!==1))throw Error();
  for(let i=1;i<versions.length;i++)if(compare(versions[i-1].item.version,versions[i].item.version)>=0||Date.parse(versions[i].publication.recordedAt)<Date.parse(versions[i-1].publication.recordedAt))throw Error();const selected=versions.filter(v=>Date.parse(v.publication.recordedAt)<=knownAt).at(-1);
  return selected?{policy:selected.policy,source:{templateId:selected.item.id,templateKey:selected.item.templateKey,version:selected.item.version,contentDigest:selected.item.contentDigest!,recordedAt:selected.publication.recordedAt,governanceEventId:selected.publication.approval.eventId,changeIntent:selected.policy.changeIntent,changeReason:selected.policy.changeReason}}:null;
 }catch{throw operationalIntegrity();}
}
export type OperationalPolicyContext=ReturnType<typeof operationalPolicyHistory>;
export function validateOperationalPublication(store:Pick<Store,'templates'|'audits'>,item:TemplateVersion,recordedAt:string){
 if(!isOperationalPolicy(item))return;const policy=operationalPolicySchema(item.manifest.operationalMetricPolicy),current=store.templates.find(t=>t.tenantId===item.tenantId&&t.templateKey===item.templateKey&&t.status==='PUBLISHED');if(!current){if(policy.changeIntent!=='INITIAL')throw new DomainError(409,'首个指标口径须为INITIAL');return;}
 if(policy.changeIntent==='INITIAL')throw new DomainError(409,'已有指标定义须明确未来调整或历史修订');const evidence=publicationIndex(store.audits,item.tenantId),prior=templatePublication(current,evidence.get(current.id));if(Date.parse(recordedAt)<Date.parse(prior.recordedAt))throw new DomainError(409,'指标定义批准时间倒退');
 if(policy.changeIntent==='PROSPECTIVE'){const past=(p:OperationalPolicy)=>p.entries.filter(e=>Date.parse(e.effectiveFrom)<=Date.parse(recordedAt));if(canonical(past(operationalPolicySchema(current.manifest.operationalMetricPolicy)))!==canonical(past(policy)))throw new DomainError(409,'未来调整不能改变已生效指标口径；历史修改须RETROSPECTIVE_CORRECTION');}
}
