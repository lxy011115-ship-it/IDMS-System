import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {stable,sha,validateRequest,validateReceipt,type ReviewRequest,type ReviewReceipt} from '../integrations/ai.ts';
import {aiReviewNeedV4 as need,aiReviewConfigDigestV4,aiReviewGatewayV4,type AiReviewGatewayV4} from './ai-review-request-v4.ts';
export interface AiReviewBindingV4 {deployment:string;databaseOid:string;tenantId:string;roleOid:string;catalogHash:string}
export interface AiReviewHeaderV4 {format:'IDMS_AI_REVIEW_TRANSPORT_V4_1';deployment:string;databaseOid:string;tenantId:string;requestId:string;objectId:string;requestDigest:string;snapshotDigest:string;batchVersion:number;configDigest:string}
export type AiReviewFallbackCodeV4='GATEWAY_REJECTED'|'GATEWAY_RECEIPT_INVALID'|'NETWORK_ATTEMPTS_EXHAUSTED';
export type AiReviewOutcomeV4={format:'IDMS_AI_REVIEW_OUTCOME_V4_1';kind:'SIGNED_GATEWAY';requiresHumanReview:true;receipt:ReviewReceipt}|{format:'IDMS_AI_REVIEW_OUTCOME_V4_1';kind:'LOCAL_HUMAN_REQUIRED';requiresHumanReview:true;reason:AiReviewFallbackCodeV4;requestId:string;requestDigest:string};
type Sealed={version:1;iv:string;tag:string;ciphertext:string};
const codes:AiReviewFallbackCodeV4[]=['GATEWAY_REJECTED','GATEWAY_RECEIPT_INVALID','NETWORK_ATTEMPTS_EXHAUSTED'];
export function aiReviewHeaderV4(binding:Pick<AiReviewBindingV4,'deployment'|'databaseOid'|'tenantId'>,request:ReviewRequest,batchVersion:number,config:AiReviewGatewayV4):AiReviewHeaderV4 {
 validateRequest(request,binding.tenantId);need(/^[a-f0-9]{64}$/.test(binding.deployment)&&/^[1-9][0-9]*$/.test(binding.databaseOid)&&Number.isSafeInteger(batchVersion)&&batchVersion>0,'AI_REVIEW_HEADER');need(config.tenantId===binding.tenantId,'AI_REVIEW_CONFIG_TENANT');
 return {format:'IDMS_AI_REVIEW_TRANSPORT_V4_1',deployment:binding.deployment,databaseOid:binding.databaseOid,tenantId:binding.tenantId,requestId:request.requestId,objectId:request.objectId,requestDigest:request.requestDigest,snapshotDigest:request.snapshotDigest,batchVersion,configDigest:aiReviewConfigDigestV4(config)};
}
export function validateAiReviewOutcomeV4(input:unknown,header:AiReviewHeaderV4,request:ReviewRequest,config:AiReviewGatewayV4):AiReviewOutcomeV4 {
 const o=input as AiReviewOutcomeV4;need(o&&o.format==='IDMS_AI_REVIEW_OUTCOME_V4_1'&&o.requiresHumanReview===true,'AI_REVIEW_OUTCOME');
 if(o.kind==='SIGNED_GATEWAY'){need(Object.keys(o).length===4,'AI_REVIEW_OUTCOME');const receipt=validateReceipt(o.receipt,request,config.serviceToken);need(receipt.model.name===config.model.name&&receipt.model.digest===config.model.digest,'AI_REVIEW_MODEL_PIN');}
 else{need(o.kind==='LOCAL_HUMAN_REQUIRED'&&Object.keys(o).length===6&&codes.includes(o.reason)&&o.requestId===header.requestId&&o.requestDigest===header.requestDigest,'AI_REVIEW_OUTCOME');}
 return structuredClone(o);
}
export class AiReviewCryptoV4 {
 #key:Buffer;#binding:Pick<AiReviewBindingV4,'deployment'|'databaseOid'|'tenantId'>;#config:Readonly<AiReviewGatewayV4>;
 constructor(master:Uint8Array,binding:Pick<AiReviewBindingV4,'deployment'|'databaseOid'|'tenantId'>,config:AiReviewGatewayV4){need(master.length===32,'AI_REVIEW_KEY');this.#binding={deployment:binding.deployment,databaseOid:binding.databaseOid,tenantId:binding.tenantId};this.#config=aiReviewGatewayV4(config);need(config.tenantId===binding.tenantId,'AI_REVIEW_CONFIG_TENANT');this.#key=Buffer.from(hkdfSync('sha256',master,Buffer.from(stable(this.#binding)),Buffer.from('IDMS_AI_REVIEW_TRANSPORT_V4_1'),32));}
 get config(){return this.#config;}
 #assert(header:AiReviewHeaderV4){need(header.format==='IDMS_AI_REVIEW_TRANSPORT_V4_1'&&header.deployment===this.#binding.deployment&&header.databaseOid===this.#binding.databaseOid&&header.tenantId===this.#binding.tenantId&&header.configDigest===aiReviewConfigDigestV4(this.#config),'AI_REVIEW_CRYPTO_BINDING');}
 #seal(purpose:string,header:unknown,value:unknown):Sealed {const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key,iv);cipher.setAAD(Buffer.from(stable({purpose,header})));const ciphertext=Buffer.concat([cipher.update(stable(value),'utf8'),cipher.final()]).toString('base64url');return {version:1,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext};}
 #open(purpose:string,header:unknown,input:unknown):unknown {const s=input as Sealed;need(s&&s.version===1&&Object.keys(s).length===4&&typeof s.ciphertext==='string'&&s.ciphertext.length<=140000&&typeof s.iv==='string'&&typeof s.tag==='string','AI_REVIEW_CIPHERTEXT');const iv=Buffer.from(s.iv,'base64url'),tag=Buffer.from(s.tag,'base64url');need(iv.length===12&&tag.length===16,'AI_REVIEW_CIPHERTEXT');try{const d=createDecipheriv('aes-256-gcm',this.#key,iv);d.setAAD(Buffer.from(stable({purpose,header})));d.setAuthTag(tag);return JSON.parse(Buffer.concat([d.update(Buffer.from(s.ciphertext,'base64url')),d.final()]).toString('utf8'));}catch{throw Error('AI_REVIEW_DECRYPT_FAILED');}}
 witness(){return this.#seal('KEY_CHECK',this.#binding,{purpose:'AI_REVIEW_KEY_CHECK'});}
 verifyWitness(input:unknown){need(stable(this.#open('KEY_CHECK',this.#binding,input))===stable({purpose:'AI_REVIEW_KEY_CHECK'}),'AI_REVIEW_KEY_CHECK');}
 sealRequest(header:AiReviewHeaderV4,request:ReviewRequest){this.#assert(header);this.#request(header,request);need(Buffer.byteLength(JSON.stringify(request))<=48000,'AI_REVIEW_REQUEST_LIMIT');return this.#seal('REQUEST',header,request);}
 #request(header:AiReviewHeaderV4,input:unknown){const request=validateRequest(input,header.tenantId);need(request.requestId===header.requestId&&request.objectId===header.objectId&&request.requestDigest===header.requestDigest&&request.snapshotDigest===header.snapshotDigest,'AI_REVIEW_REQUEST_BINDING');return request;}
 openRequest(header:AiReviewHeaderV4,sealed:unknown){this.#assert(header);return this.#request(header,this.#open('REQUEST',header,sealed));}
 sealOutcome(header:AiReviewHeaderV4,request:ReviewRequest,input:AiReviewOutcomeV4){this.#assert(header);this.#request(header,request);const outcome=validateAiReviewOutcomeV4(input,header,request,this.#config);return {sealed:this.#seal('OUTCOME',header,outcome),digest:sha(stable(outcome))};}
 openOutcome(header:AiReviewHeaderV4,request:ReviewRequest,sealed:unknown,digest:string){this.#assert(header);this.#request(header,request);const outcome=validateAiReviewOutcomeV4(this.#open('OUTCOME',header,sealed),header,request,this.#config);need(sha(stable(outcome))===digest,'AI_REVIEW_OUTCOME_DIGEST');return outcome;}
}
