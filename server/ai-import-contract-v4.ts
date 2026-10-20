import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {validateRequest,stable,sha,type ReviewRequest} from '../integrations/ai.ts';
import {aiReviewNeedV4 as need,aiReviewGatewayV4,aiReviewConfigDigestV4,type AiReviewGatewayV4} from './ai-review-request-v4.ts';
import type {AiReviewHeaderV4,AiReviewBindingV4} from './ai-review-crypto-v4.ts';
export interface AiImportConfigurationV4 {binding:Pick<AiReviewBindingV4,'tenantId'|'deployment'|'databaseOid'>;gateway:AiReviewGatewayV4}
export interface AiImportIntentV4 {format:'IDMS_AI_IMPORT_INTENT_V4_1';header:AiReviewHeaderV4;headerDigest:string;request:ReviewRequest;correlationId:string}
export interface AiImportApplyCommandV4 {action:'AI_IMPORT_APPLY';id:string;input:{requestId:string;outcomeDigest:string}}
export const aiImportPolicyKeyV4='ai_import_policy';
export const aiImportIntentKeyV4=(batchId:string)=>'ai_import_intent:'+batchId;
export function aiImportPolicyV4(c:AiImportConfigurationV4){aiReviewGatewayV4(c.gateway);need(c.binding.tenantId===c.gateway.tenantId,'AI_IMPORT_TENANT');return {format:'IDMS_AI_IMPORT_POLICY_V4_1',tenantId:c.binding.tenantId,deployment:c.binding.deployment,configDigest:aiReviewConfigDigestV4(c.gateway),model:c.gateway.model};}
export function verifyAiImportIntentV4(input:unknown,c:AiImportConfigurationV4):AiImportIntentV4 {const i=input as AiImportIntentV4;need(i?.format==='IDMS_AI_IMPORT_INTENT_V4_1'&&Object.keys(i).length===5&&i.headerDigest===sha(stable(i.header))&&typeof i.correlationId==='string'&&i.correlationId.length<=512,'AI_IMPORT_INTENT');const r=validateRequest(i.request,c.binding.tenantId);need(i.header.deployment===c.binding.deployment&&i.header.databaseOid===c.binding.databaseOid&&i.header.tenantId===c.binding.tenantId&&i.header.configDigest===aiReviewConfigDigestV4(c.gateway)&&i.header.requestId===r.requestId&&i.header.objectId===r.objectId&&i.header.requestDigest===r.requestDigest&&i.header.snapshotDigest===r.snapshotDigest&&Number.isSafeInteger(i.header.batchVersion)&&i.header.batchVersion>0,'AI_IMPORT_INTENT_BINDING');return structuredClone(i);}
export function aiImportUuidV4(value:unknown){const h=canonicalDigest(value).slice(0,32);return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');}
export function aiImportApplicationIdentityV4(tenant:string,requestId:string,objectId:string,outcomeDigest:string){const command:AiImportApplyCommandV4={action:'AI_IMPORT_APPLY',id:objectId,input:{requestId,outcomeDigest}},commandId=aiImportUuidV4(['ai-import-apply',requestId,outcomeDigest]);return {command,commandId,requestHash:canonicalDigest(command),businessKey:canonicalDigest([tenant,'idms.ai-import-v4','SYSTEM',commandId])};}
export const aiImportEqualV4=canonicalEqual;
