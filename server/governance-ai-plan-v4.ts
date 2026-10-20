import {prepareGovernancePayloadV4,governanceBasicAccessV4,governanceCommandAccessV4,type GovernanceCommandV4} from './governance-plan-v4.ts';
import {tenantWorkspace,workspacePayload} from './tenant-workspace.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {createBatch,type Batch} from './imports.ts';
import {batchInputDigest} from './import-revisions.ts';
import {appendAudit} from './audit.ts';
import {DomainError} from './service.ts';
import type {AccessContext} from './access.ts';
import {canonicalDigest,jsonWireClone,canonicalEqual} from './canonical-state.ts';
import {stateValueText} from './state-map-v1.ts';
import {buildAiReviewRequestV4} from './ai-review-request-v4.ts';
import {aiReviewHeaderV4} from './ai-review-crypto-v4.ts';
import {stable,sha,findingLabels} from '../integrations/ai.ts';
import {aiImportIntentKeyV4,type AiImportConfigurationV4,type AiImportApplyCommandV4,type AiImportIntentV4} from './ai-import-contract-v4.ts';
import {VerifiedAiImportResultV4} from './ai-import-result-proof-v4.ts';
import type {LegacyEntry} from './legacy-map-v4.ts';
export {encodeGovernanceCandidateV4} from './governance-plan-v4.ts';
export type GovernanceAiCommandV4=GovernanceCommandV4|AiImportApplyCommandV4;
export type AiImportExecutionV4={kind:'GOVERNANCE';configuration:AiImportConfigurationV4}|{kind:'APPLY';configuration:AiImportConfigurationV4;proof:VerifiedAiImportResultV4};
const reject=()=>{throw new DomainError(403,'AI_IMPORT_INTERNAL_AUTHORITY');};
function internal(command:GovernanceAiCommandV4,ctx:AccessContext,execution:AiImportExecutionV4){if(execution.kind!=='APPLY'||!(execution.proof instanceof VerifiedAiImportResultV4))reject();const p=(execution as Extract<AiImportExecutionV4,{kind:'APPLY'}>).proof.data();if(ctx.tenantId!==p.intent.header.tenantId||ctx.actorType!=='SYSTEM'||ctx.actorId!=='idms.ai-import-v4'||!canonicalEqual(command,p.identity.command))reject();return p;}
export function governanceAiBasicAccessV4(command:GovernanceAiCommandV4,ctx:AccessContext,execution:AiImportExecutionV4){if(command?.action==='AI_IMPORT_APPLY'){internal(command,ctx,execution);return;}if(execution.kind!=='GOVERNANCE')reject();governanceBasicAccessV4(command as GovernanceCommandV4,ctx);}
export function governanceAiCommandAccessV4(payload:TenantPayload,command:GovernanceAiCommandV4,ctx:AccessContext,execution:AiImportExecutionV4){governanceAiBasicAccessV4(command,ctx,execution);if(command.action!=='AI_IMPORT_APPLY')governanceCommandAccessV4(payload,command,ctx);}
const summary=(b:Batch)=>({batchId:b.batchId,status:b.status,version:b.version,snapshotDigest:b.snapshotDigest,fileSha256:b.fileSha256,counts:b.counts,aiReviewStatus:b.aiReview.status});
export function prepareGovernanceAiPayloadV4(before:TenantPayload,command:GovernanceAiCommandV4,ctx:AccessContext,execution:AiImportExecutionV4):{after:TenantPayload;result:Record<string,unknown>;extraEntries:LegacyEntry[]}{
 governanceAiCommandAccessV4(before,command,ctx,execution);if(command.action!=='IMPORT_CREATE'&&command.action!=='AI_IMPORT_APPLY')return {...prepareGovernancePayloadV4(before,command,ctx),extraEntries:[]};
 validateTenantPayload(before,ctx.tenantId);const workspace=tenantWorkspace(before),{store,imports}=workspace;const extraEntries:LegacyEntry[]=[];let result:Record<string,unknown>;
 if(command.action==='IMPORT_CREATE'){
  const input=jsonWireClone(command.input),allowed=['dataType','templateVersion','sourceSystem','rows','originalBase64','filename','mime','sourceKind','lineNumbers','mappingRef','sourceHeaders','supersedesBatchId','correctionReason','equipmentProfileRef','profileDeviceCode'];
  if(Object.keys(input).some(k=>!allowed.includes(k))||typeof input.originalBase64!=='string'||input.originalBase64.length>12*1024*1024||typeof input.filename!=='string'||typeof input.mime!=='string'||typeof input.sourceKind!=='string')throw new DomainError(400,'GOVERNANCE_IMPORT_INPUT');
  const original=Buffer.from(input.originalBase64,'base64');if(original.toString('base64')!==input.originalBase64)throw new DomainError(400,'GOVERNANCE_IMPORT_BYTES');const {originalBase64,...fields}=input;
  const b=createBatch(imports,store,{...fields,original,aiMode:'gateway'} as Parameters<typeof createBatch>[2],ctx);result=summary(b);
  if(b.status==='AI_PENDING'){
   const request=buildAiReviewRequestV4(b),header=aiReviewHeaderV4(execution.configuration.binding,request,b.version,execution.configuration.gateway),intent:AiImportIntentV4={format:'IDMS_AI_IMPORT_INTENT_V4_1',header,headerDigest:sha(stable(header)),request,correlationId:ctx.correlationId};
   b.aiReview.gateway={requestId:request.requestId,requestDigest:request.requestDigest,mode:'SHADOW',promptVersion:request.promptVersion,policyVersion:request.policyVersion,modelDigest:execution.configuration.gateway.model.digest,sampledRows:request.scope.sampledRows,totalRows:request.scope.totalRows};
   appendAudit(store,{tenantId:ctx.tenantId,objectType:'DATA_IMPORT',objectId:b.batchId,action:'IMPORT_AI_QUEUED',actorType:'SYSTEM',actorId:'idms.ai-import-v4',correlationId:ctx.correlationId,metadata:{...b.aiReview.gateway,snapshotDigest:b.snapshotDigest,fullContentReviewed:false}});
   extraEntries.push({namespace:'blob',key:aiImportIntentKeyV4(b.batchId),valueText:stateValueText(intent)});result={...summary(b),aiRequestId:request.requestId};
  }
 }else{
  const p=internal(command,ctx,execution),{intent,outcome}=p,h=intent.header,b=imports.batches.find(b=>b.batchId===h.objectId&&b.tenantId===h.tenantId);
  const valid=b&&b.status==='AI_PENDING'&&b.version===h.batchVersion&&b.snapshotDigest===h.snapshotDigest&&batchInputDigest(b)===h.snapshotDigest&&b.aiReview.gateway?.requestId===h.requestId&&b.aiReview.gateway.requestDigest===h.requestDigest;
  let action:string,actorType:'SYSTEM'|'AI'|'RULE',metadata:Record<string,unknown>={requestId:h.requestId,requestDigest:h.requestDigest,outcomeDigest:p.outcomeDigest,requiresHumanReview:true};
  if(!valid){if(b?.status==='AI_PENDING'){b.status='HUMAN_REVIEW';b.version++;b.aiReview.status='HUMAN_REQUIRED';b.aiReview.conclusion='冻结输入发生冲突，必须人工复核；未采用模型输出';}action='IMPORT_AI_INPUT_CONFLICT';actorType='SYSTEM';result={batchId:h.objectId,status:b?.status??'MISSING',inputConflict:true,requiresHumanReview:true};}
  else{b.status='HUMAN_REVIEW';b.version++;b.aiReview.confidence=null;
   if(outcome.kind==='SIGNED_GATEWAY'){const r=outcome.receipt;b.aiReview.status=r.status;b.aiReview.modelVersion=r.model.name+'@'+r.model.digest;b.aiReview.conclusion=r.output?'本地模型已作影子审阅，请独立审核人员核实证据和原件':'AI 政策或模型异常，转人工复核：'+r.reason;b.aiReview.gateway!.receipt=r;b.aiReview.evidence.push(...r.output?.findingCodes.map(c=>findingLabels[c])??[],...r.evidence.map(e=>'证据 '+e.id+' / SHA-256 '+e.sha256));action=r.provenance==='LOCAL_MODEL'?'IMPORT_REAL_AI_SHADOW_REVIEWED':'IMPORT_AI_POLICY_FALLBACK';actorType=r.provenance==='LOCAL_MODEL'?'AI':'RULE';metadata={...metadata,receipt:r,scope:intent.request.scope};}
   else{b.aiReview.status='HUMAN_REQUIRED';b.aiReview.conclusion='AI 网关未获有效回执，转人工复核：'+outcome.reason;action='IMPORT_AI_HUMAN_REQUIRED';actorType='SYSTEM';metadata={...metadata,reason:outcome.reason};}
   b.aiReview.evidence.push('审阅范围：'+intent.request.scope.sampledRows+'/'+intent.request.scope.totalRows+' 行摘要；未覆盖全部内容','影子审阅不具备最终批准权限；置信度未校准');result={...summary(b),inputConflict:false,requiresHumanReview:true};
  }
  appendAudit(store,{tenantId:h.tenantId,objectType:'DATA_IMPORT',objectId:h.objectId,action,actorType,actorId:actorType==='SYSTEM'?'idms.ai-import-v4':'idms.ai-gateway',correlationId:intent.correlationId,metadata});result={...result,requestId:h.requestId,outcomeDigest:p.outcomeDigest};
 }
 const after=workspacePayload(workspace,ctx.tenantId);validateTenantPayload(after,ctx.tenantId);return {after,result:jsonWireClone(result),extraEntries};
}
