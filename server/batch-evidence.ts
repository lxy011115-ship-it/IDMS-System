import type {Store} from './store.ts';
import type {BatchBody,Batch} from './imports.ts';
import type {AuditEvent} from './domain.ts';
import {digest} from './imports.ts';
// Explicit evidence required by shared frozen-binding rules. Read verifiers
// provide these only after the complete chain and every file were verified.
export interface TemplateEvidence {
 readonly templates:Store['templates'];
 templateAnchor:(tenant:string,id:string)=>AuditEvent|undefined;
}
export interface ReceivedAuditEvidence {readonly count:number;readonly first:AuditEvent|undefined;readonly hasCorrection:boolean;readonly hasMapping:boolean;readonly hasEquipmentProfile:boolean}
export type BatchMetadata=Omit<BatchBody,'rows'|'validRows'>;
export interface FrozenInputEvidence {readonly rowCount:number;digest:()=>string;profileReferencesMatch:(expected:string)=>boolean}
export interface MetadataBatchEvidence extends TemplateEvidence {
 received:(tenant:string,batch:string)=>ReceivedAuditEvidence;
 originalMatches:(batch:BatchMetadata)=>boolean;
}
export interface BatchEvidence extends TemplateEvidence {
 received:(tenant:string,batch:string)=>ReceivedAuditEvidence;
 originalMatches:(batch:BatchBody)=>boolean;
}
// Full write/maintenance paths retain their original complete bodies and chain.
export function fullBatchEvidence(store:Store):BatchEvidence{return {
 templates:store.templates,
 templateAnchor:(tenant,id)=>store.audits.filter(a=>a.tenantId===tenant&&a.objectType==='TEMPLATE'&&a.objectId===id).at(-1),
 received:(tenant,batch)=>{const rows=store.audits.filter(a=>a.tenantId===tenant&&a.objectType==='DATA_IMPORT'&&a.objectId===batch&&a.action==='IMPORT_RECEIVED');return {count:rows.length,first:rows[0],hasCorrection:rows.some(a=>!!a.metadata?.correction),hasMapping:rows.some(a=>!!a.metadata?.mappingBinding),hasEquipmentProfile:rows.some(a=>!!a.metadata?.equipmentProfileBinding)};},
 originalMatches:batch=>digest(Buffer.from((batch as Batch).originalBase64,'base64'))===batch.fileSha256
};}

export function metadataBatchEvidence(evidence:BatchEvidence,batch:BatchBody):MetadataBatchEvidence{return {...evidence,originalMatches:meta=>meta===batch&&evidence.originalMatches(batch)};}
