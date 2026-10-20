import type {ClientConfig} from 'pg';
import {readLimited,validateReceipt,type ReviewRequest} from '../integrations/ai.ts';
import {aiReviewNeedV4 as need,aiReviewConfigDigestV4,type AiReviewGatewayV4} from './ai-review-request-v4.ts';
import {type AiReviewHeaderV4,type AiReviewOutcomeV4,type AiReviewFallbackCodeV4,validateAiReviewOutcomeV4} from './ai-review-crypto-v4.ts';
import {AiReviewSourceV4,type AiReviewClaimV4} from './ai-review-source-v4.ts';
import {startAiReviewHeartbeatV4} from './ai-review-heartbeat-v4.ts';
class RetryableGatewayV4 extends Error {constructor(){super('AI_REVIEW_NETWORK_RETRY');}}
const fallback=(request:ReviewRequest,reason:AiReviewFallbackCodeV4):AiReviewOutcomeV4=>({format:'IDMS_AI_REVIEW_OUTCOME_V4_1',kind:'LOCAL_HUMAN_REQUIRED',requiresHumanReview:true,reason,requestId:request.requestId,requestDigest:request.requestDigest});
async function review(config:AiReviewGatewayV4,request:ReviewRequest,header:AiReviewHeaderV4):Promise<AiReviewOutcomeV4>{
 let response:Response;try{response=await fetch(config.baseUrl+'/v1/reviews',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.serviceToken,'X-IDMS-Tenant':request.tenantId},body:JSON.stringify(request),signal:AbortSignal.timeout(130000),redirect:'error'});}catch{throw new RetryableGatewayV4();}
 if(!response.ok){await response.body?.cancel().catch(()=>{});if([429,500,502,503,504].includes(response.status))throw new RetryableGatewayV4();return fallback(request,'GATEWAY_REJECTED');}
 try{const receipt=validateReceipt(JSON.parse(await readLimited(response.body as unknown as AsyncIterable<Uint8Array>,65536)),request,config.serviceToken);return validateAiReviewOutcomeV4({format:'IDMS_AI_REVIEW_OUTCOME_V4_1',kind:'SIGNED_GATEWAY',requiresHumanReview:true,receipt},header,request,config);}catch{return fallback(request,'GATEWAY_RECEIPT_INVALID');}
}
export interface AiReviewWorkerOptionsV4 {
 source:AiReviewSourceV4;account:ClientConfig;
 /** Must read current trusted tenant/configuration state; submitted user roles are never sufficient. */
 admit:(header:AiReviewHeaderV4)=>Promise<{active:boolean;configDigest:string}>;
 onPhase?:(phase:'CLAIMED'|'DISPATCHED'|'RESPONSE_VALIDATED'|'RESULT_READY',claim:AiReviewClaimV4)=>Promise<void>;
 onError?:(code:'RESULT_UNCONFIRMED'|'WORKER_INTERRUPTED',requestId:string)=>Promise<void>;
}
export class AiReviewWorkerV4 {
 #options:AiReviewWorkerOptionsV4;#busy=false;
 constructor(options:AiReviewWorkerOptionsV4){need(typeof options.admit==='function','AI_REVIEW_ADMISSION_REQUIRED');this.#options=options;}
 async runOne(){need(!this.#busy,'AI_REVIEW_WORKER_BUSY');this.#busy=true;const o=this.#options;let claim:AiReviewClaimV4|null=null,heartbeat:Awaited<ReturnType<typeof startAiReviewHeartbeatV4>>|undefined,persisting=false;
  try{claim=await o.source.claim();if(!claim)return null;heartbeat=await startAiReviewHeartbeatV4(o.account,o.source.binding,claim);await o.onPhase?.('CLAIMED',claim);heartbeat.assertLive();
   const admission=await o.admit(claim.header);if(!admission.active||admission.configDigest!==claim.header.configDigest){await heartbeat.stop();heartbeat=undefined;await o.source.defer(claim,!admission.active?'TENANT_NOT_ADMITTED':'CONFIGURATION_CHANGED');return {requestId:claim.header.requestId,status:'DEFERRED'};}
   need(aiReviewConfigDigestV4(o.source.crypto.config)===claim.header.configDigest,'AI_REVIEW_CONFIG_CHANGED');const request=o.source.request(claim);let outcome:AiReviewOutcomeV4;
   if(claim.networkFailures>=3)outcome=fallback(request,'NETWORK_ATTEMPTS_EXHAUSTED');
   else{await o.source.dispatch(claim);heartbeat.assertLive();await o.onPhase?.('DISPATCHED',claim);
    try{outcome=await review(o.source.crypto.config,request,claim.header);}catch(error){if(!(error instanceof RetryableGatewayV4))throw error;const failures=await o.source.networkFailure(claim);if(failures>=3)outcome=fallback(request,'NETWORK_ATTEMPTS_EXHAUSTED');else{await heartbeat.stop();heartbeat=undefined;await o.source.defer(claim,'NETWORK_RETRY');return {requestId:claim.header.requestId,status:'RETRY'};}}
   }
   heartbeat.assertLive();await o.onPhase?.('RESPONSE_VALIDATED',claim);heartbeat.assertLive();persisting=true;const saved=await o.source.saveOutcome(claim,outcome);await heartbeat.stop();heartbeat=undefined;await o.onPhase?.('RESULT_READY',claim);return {requestId:claim.header.requestId,status:'RESULT_READY',outcome:saved};
  }catch(error){if(!claim)throw error;await heartbeat?.stop();heartbeat=undefined;const found=await o.source.read(claim.header.requestId);if(found?.status==='RESULT_READY')return {requestId:claim.header.requestId,status:'RESULT_READY',outcome:o.source.outcome(found)};const code=persisting?'RESULT_UNCONFIRMED':'WORKER_INTERRUPTED';await o.onError?.(code,claim.header.requestId);await o.source.defer(claim,code).catch(()=>{});return {requestId:claim.header.requestId,status:'RETRY'};
  }finally{await heartbeat?.stop();this.#busy=false;}
 }
}
