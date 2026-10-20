import {canonicalDigest,jsonWireClone} from './canonical-state.ts';
import {tenantWorkspace,workspacePayload} from './tenant-workspace.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {encodeDomainEntities} from './domain-entities-v4.ts';
import {compileGovernanceMap} from './source-governance-map-v4.ts';
import {compileDomainReadCatalogV4} from './domain-read-catalog-v4.ts';
import {auditPositionKey,verifyLocalDomainAudit,type TelemetryDomainControl} from './telemetry-map-v4.ts';
import {stateValueText} from './state-map-v1.ts';
import {legacyJsonText,type LegacyEntry} from './legacy-map-v4.ts';
import {createTemplate,editTemplate,submitTemplate,approveTemplate} from './catalog.ts';
import {createBatch,approveBatch,getBatch,type Batch} from './imports.ts';
import {commandAccess} from './command-access.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {DomainError} from './service.ts';
import type {PublicGovernedSource} from './source-governance.ts';
export type GovernanceActionV4='TEMPLATE_CREATE'|'TEMPLATE_EDIT'|'TEMPLATE_SUBMIT'|'TEMPLATE_APPROVE'|'IMPORT_CREATE'|'IMPORT_APPROVE';
export interface GovernanceCommandV4 {action:GovernanceActionV4;id?:string;input:Record<string,unknown>}
const permissions:Record<GovernanceActionV4,string>={TEMPLATE_CREATE:'template:edit',TEMPLATE_EDIT:'template:edit',TEMPLATE_SUBMIT:'template:submit',TEMPLATE_APPROVE:'template:publish',IMPORT_CREATE:'upload',IMPORT_APPROVE:'approve'};
export function governanceBasicAccessV4(command:GovernanceCommandV4,ctx:AccessContext){domainReadAccessV4(ctx);if(!command||!Object.hasOwn(permissions,command.action)||!command.input||typeof command.input!=='object'||Array.isArray(command.input)||Object.keys(command).some(k=>!['action','id','input'].includes(k))||command.id!==undefined&&(typeof command.id!=='string'||!/^[-\w]{1,128}$/.test(command.id)))throw new DomainError(400,'GOVERNANCE_COMMAND_INVALID');requireAccess(ctx,permissions[command.action]);}
export function governanceCommandAccessV4(payload:TenantPayload,command:GovernanceCommandV4,ctx:AccessContext){
 governanceBasicAccessV4(command,ctx);const {store,imports}=tenantWorkspace(payload);
 if(command.action==='IMPORT_APPROVE'){getBatch(imports,command.id||'',ctx);return;}
 if(command.action==='IMPORT_CREATE')return;
 const suffix=command.action==='TEMPLATE_EDIT'?'edit':command.action==='TEMPLATE_SUBMIT'?'submit':'approval',path=command.action==='TEMPLATE_CREATE'?'/api/v1/templates':'/api/v1/templates/'+command.id+'/'+suffix;
 commandAccess(path,'POST',command.input,ctx,imports,store);
}
function batchSummary(b:Batch){return {batchId:b.batchId,status:b.status,version:b.version,snapshotDigest:b.snapshotDigest,fileSha256:b.fileSha256,counts:b.counts,aiReviewStatus:b.aiReview.status};}
/** Maintenance preparation: original domain rules and complete validation, no external side effects. */
export function prepareGovernancePayloadV4(before:TenantPayload,command:GovernanceCommandV4,ctx:AccessContext){
 validateTenantPayload(before,ctx.tenantId);governanceCommandAccessV4(before,command,ctx);const workspace=tenantWorkspace(before),{store,imports}=workspace,input=jsonWireClone(command.input);let result:Record<string,unknown>;
 if(command.action==='IMPORT_CREATE'){
  const allowed=['dataType','templateVersion','sourceSystem','rows','originalBase64','filename','mime','sourceKind','lineNumbers','mappingRef','sourceHeaders','supersedesBatchId','correctionReason','equipmentProfileRef','profileDeviceCode'];
  if(Object.keys(input).some(k=>!allowed.includes(k))||typeof input.originalBase64!=='string'||input.originalBase64.length>12*1024*1024||typeof input.filename!=='string'||typeof input.mime!=='string'||typeof input.sourceKind!=='string')throw new DomainError(400,'GOVERNANCE_IMPORT_INPUT');
  const original=Buffer.from(input.originalBase64,'base64');if(original.toString('base64')!==input.originalBase64)throw new DomainError(400,'GOVERNANCE_IMPORT_BYTES');
  const {originalBase64,...fields}=input;const b=createBatch(imports,store,{...fields,original,aiMode:'unavailable'} as Parameters<typeof createBatch>[2],ctx);result=batchSummary(b);
 }else if(command.action==='IMPORT_APPROVE')result=batchSummary(approveBatch(imports,store,command.id||'',input,ctx));
 else{const item=command.action==='TEMPLATE_CREATE'?createTemplate(store,input,ctx,imports):command.action==='TEMPLATE_EDIT'?editTemplate(store,command.id||'',input,ctx,imports):command.action==='TEMPLATE_SUBMIT'?submitTemplate(store,command.id||'',input,ctx,imports):approveTemplate(store,command.id||'',input,ctx,imports);result={id:item.id,templateKey:item.templateKey,version:item.version,status:item.status,revision:item.revision,contentDigest:item.contentDigest};}
 const after=workspacePayload(workspace,ctx.tenantId);validateTenantPayload(after,ctx.tenantId);return {after,result:jsonWireClone(result)};
}
export function* encodeGovernanceCandidateV4(after:TenantPayload,previousAuditCount:number,control:TelemetryDomainControl,sources:readonly PublicGovernedSource[]):Generator<LegacyEntry>{
 const tenant=control.tenantId,anchor=canonicalDigest(after);yield* encodeDomainEntities(after,tenant);
 for(let i=previousAuditCount;i<after.audits.length;i++){const a=verifyLocalDomainAudit(after.audits[i],tenant);yield {namespace:'audit',key:a.eventId,valueText:stateValueText(a)};yield {namespace:'audit_order',key:auditPositionKey(String(i+1)),valueText:stateValueText({tenantId:tenant,position:String(i+1),eventId:a.eventId})};}
 yield {namespace:'domain_head',key:'audit',valueText:stateValueText({tenantId:tenant,count:String(after.audits.length),eventId:after.audits.at(-1)?.eventId||null,hash:after.audits.at(-1)?.hash||'GENESIS'})};
 yield* compileGovernanceMap(after,tenant,sources).entries;const catalog=compileDomainReadCatalogV4(after,tenant,anchor);yield* catalog.entries;yield {namespace:'domain_head',key:'read_catalog',valueText:stateValueText(catalog.head)};
 yield {namespace:'domain_head',key:'control',valueText:stateValueText({...control,status:'ACTIVE',governanceAnchorDigest:anchor,epoch:String(BigInt(control.epoch)+1n)})};
}
export const governancePayloadDigestV4=(value:unknown)=>canonicalDigest(JSON.parse(legacyJsonText(jsonWireClone(value))));
