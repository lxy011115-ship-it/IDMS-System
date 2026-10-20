import {randomUUID,createHash} from 'node:crypto';
import type {BatchBody} from './imports.ts';
import {promptVersion,policyVersion,stable,sha,requestHash,validateRequest,type ReviewRequest} from '../integrations/ai.ts';

export function aiReviewNeedV4(value:unknown,code='AI_REVIEW_INVALID'):asserts value {if(!value)throw Error(code);}
export interface AiReviewGatewayV4 {baseUrl:string;model:{name:string;digest:string};tenantId:string;serviceToken:string}
export function aiReviewGatewayV4(input:AiReviewGatewayV4){
 const c=structuredClone(input);const u=new URL(c.baseUrl);
 aiReviewNeedV4(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash&&u.port&&Number(u.port)>0&&Number(u.port)<=65535,'AI_REVIEW_LOCAL_GATEWAY_REQUIRED');
 aiReviewNeedV4(c.model?.name==='qwen3:4b'&&/^sha256:[a-f0-9]{64}$/.test(c.model.digest)&&/^[A-Za-z0-9_-]{1,80}$/.test(c.tenantId)&&/^[A-Za-z0-9_-]{32,256}$/.test(c.serviceToken),'AI_REVIEW_GATEWAY_CONFIG');
 c.baseUrl=u.origin;return Object.freeze({...c,model:Object.freeze(c.model)});
}
export function aiReviewConfigDigestV4(c:AiReviewGatewayV4){const safe=aiReviewGatewayV4(c);return sha(stable({...safe,serviceToken:sha(safe.serviceToken),promptVersion,policyVersion}));}
/** Truncate at a code point boundary; hashes always describe the bytes actually sent. */
export function aiReviewSummaryV4(value:unknown){const text=stable(value);if(Buffer.byteLength(text)<=2100)return text;const suffix=' [TRUNCATED SUMMARY]';let out='',bytes=0;for(const character of text){const size=Buffer.byteLength(character);if(bytes+size>2000)break;out+=character;bytes+=size;}return out+suffix;}
export function buildAiReviewRequestV4(batch:Pick<BatchBody,'batchId'|'tenantId'|'rows'|'lineNumbers'|'dataType'|'templateVersion'|'counts'|'sourceSystem'|'snapshotDigest'>,requestId=randomUUID()):ReviewRequest {
 aiReviewNeedV4(batch.rows.length===batch.counts.total&&batch.rows.length>=1&&batch.rows.length<=10000,'AI_REVIEW_BATCH_ROWS');
 const n=Math.min(12,batch.rows.length),indices=Array.from({length:n},(_,i)=>n===1?0:Math.round(i*(batch.rows.length-1)/(n-1)));
 const evidence:ReviewRequest['evidence']=[];const add=(id:string,kind:ReviewRequest['evidence'][number]['kind'],value:unknown)=>{const content=aiReviewSummaryV4(value);evidence.push({id,kind,content,sha256:sha(content)});};
 add('RULE_SUMMARY','RULE_SUMMARY',{dataType:batch.dataType,templateVersion:batch.templateVersion,rule:'upload-rules-1.0.0',counts:batch.counts,sourceSystem:batch.sourceSystem,snapshotDigest:batch.snapshotDigest});
 add('INPUT_SCOPE','INPUT_SCOPE',{totalRows:batch.rows.length,sampledRows:n,fullContentReviewed:false,authority:'SHADOW ONLY; independent human approval required; no fault probability or RUL'});
 for(const index of indices)add('ROW_'+(index+1),'DATA_ROW',{line:batch.lineNumbers[index]??index+2,value:batch.rows[index]});
 const body={version:1 as const,tenantId:batch.tenantId,requestId,objectId:batch.batchId,snapshotDigest:batch.snapshotDigest,promptVersion,policyVersion,scope:{totalRows:batch.rows.length,sampledRows:n,fullContentReviewed:false as const},evidence};
 return validateRequest({...body,requestDigest:requestHash(body)},batch.tenantId);
}
export const aiReviewShaBytesV4=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
