import type {TemplateVersion,AuditEvent} from './domain.ts';
import {canonical,digest} from './imports.ts';
import {validateManifest} from './template-schema.ts';
import {DomainError} from './service.ts';

export interface PublicationEvidence {approval?:AuditEvent;approvalCount:number;anchor?:AuditEvent}
export const historyIntegrity=()=>new DomainError(503,'日历历史、审批记录或生效安排不可验证');
export function publicationIndex(events:readonly AuditEvent[],tenant:string){
 const index=new Map<string,PublicationEvidence>();for(const a of events){if(a.tenantId!==tenant||a.objectType!=='TEMPLATE')continue;const e=index.get(a.objectId)||{approvalCount:0};e.anchor=a;if(a.action==='TEMPLATE_APPROVED'){e.approvalCount++;e.approval=a;}index.set(a.objectId,e);}return index;
}
export function templatePublication(item:TemplateVersion,e:PublicationEvidence|undefined){
 try{const parsed=validateManifest(item.manifest);if(canonical(parsed)!==canonical(item.manifest))throw Error();}catch{throw historyIntegrity();}
 const a=e?.approval,last=e?.anchor,approved=a?.after as TemplateVersion|undefined;
 if(typeof item.version!=='string'||!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(item.version)||typeof item.templateKey!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(item.templateKey)||!Number.isSafeInteger(item.revision)||item.revision! < 1)throw historyIntegrity();
 const digestOf=(t:TemplateVersion)=>digest(canonical({kind:'template',templateKey:t.templateKey,version:t.version,industry:t.industry,parent:t.parent||null,manifest:t.manifest}));
 if(!a||!last||e?.approvalCount!==1||!approved||!['PUBLISHED','RETIRED'].includes(item.status)||a.tenantId!==item.tenantId||a.objectId!==item.id||a.objectType!=='TEMPLATE'||a.action!=='TEMPLATE_APPROVED'||a.actorType!=='USER'||approved.status!=='PUBLISHED'||approved.id!==item.id||approved.tenantId!==item.tenantId||approved.publishedBy!==a.actorId||!approved.publishedBy||[approved.createdBy,approved.editedBy,approved.submittedBy,...(approved.contributors||[])].includes(a.actorId)||item.contentDigest!==digestOf(item)||approved.contentDigest!==digestOf(approved)||!Number.isFinite(Date.parse(a.businessTime))||typeof approved.publishedAt!=='string'||!Number.isFinite(Date.parse(approved.publishedAt))||Date.parse(approved.publishedAt)>Date.parse(a.businessTime))throw historyIntegrity();
 if(item.status==='PUBLISHED'){if(last.eventId!==a.eventId||canonical(item)!==canonical(approved))throw historyIntegrity();}
 else if(last.tenantId!==item.tenantId||last.objectType!=='TEMPLATE'||last.objectId!==item.id||last.action!=='RETIRED_BY_NEW_VERSION'||last.actorType!=='USER'||canonical(last.before)!==canonical(approved)||canonical(last.after)!==canonical(item)||canonical({...item,status:'PUBLISHED'})!==canonical(approved)||!Number.isFinite(Date.parse(last.businessTime))||Date.parse(last.businessTime)<Date.parse(a.businessTime))throw historyIntegrity();
 return {approved,approval:a,recordedAt:a.businessTime};
}
