import {canonical} from '../server/imports.ts';
import {reviewSourceNeedV1 as need,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f]/.test(v);

/** Only a complete reconstructed payload may supply review inputs; never a filtered list. */
export function coldReviewInputsV1({payload,tenantId,sourceFullFactsSha256,sourceMapFactsSha256,payloadSha256}){
 need(typeof tenantId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(tenantId)&&[sourceFullFactsSha256,sourceMapFactsSha256,payloadSha256].every(hex),'COLD_REVIEW_INPUT_BINDING');
 need(payload&&hash(payload)===payloadSha256,'COLD_REVIEW_INPUT_PAYLOAD_CHANGED');
 const b=payload.business;need(b&&Array.isArray(b.workOrders)&&Array.isArray(b.templates),'COLD_REVIEW_INPUT_SHAPE');
 const orders=b.workOrders,templates=b.templates.filter(t=>t?.status==='PUBLISHED');
 need(orders.length<=512&&templates.length<=512,'COLD_REVIEW_INPUT_LIMIT');
 need(orders.every(o=>o&&o.tenantId===tenantId&&text(o.id))&&new Set(orders.map(o=>o.id)).size===orders.length,'COLD_REVIEW_INPUT_ORDER_INVENTORY');
 need(templates.every(t=>t.tenantId===tenantId&&text(t.id)&&text(t.templateKey)&&text(t.version)&&(!t.contentDigest||hex(t.contentDigest)))&&new Set(templates.map(t=>t.id)).size===templates.length,'COLD_REVIEW_INPUT_POLICY_INVENTORY');
 const policies=templates.map(t=>{const bodySha256=hash(t);return{id:t.id,templateKey:t.templateKey,version:t.version,contentDigest:t.contentDigest||bodySha256,digestKind:t.contentDigest?'DECLARED':'LEGACY_BODY_SHA256',bodySha256,purpose:typeof t.manifest?.purpose==='string'?t.manifest.purpose:'LEGACY_UNCLASSIFIED'};}).sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
 const body={format:'COLD_REVIEW_INPUTS_V1',tenantId,sourceFullFactsSha256,sourceMapFactsSha256,payloadSha256,orders,policies};
 need(Buffer.byteLength(canonical(body))<=16*1024**2,'COLD_REVIEW_INPUT_LIMIT');
 return structuredClone({...body,sha256:hash(body)});
}

export function assertColdReviewInputsV1(inputs,{tenantId,sourceFullFactsSha256,sourceMapFactsSha256,payloadSha256}){
 const {sha256,...body}=inputs??{};
 need(inputs?.format==='COLD_REVIEW_INPUTS_V1'&&Object.keys(inputs).sort().join(',')==='format,orders,payloadSha256,policies,sha256,sourceFullFactsSha256,sourceMapFactsSha256,tenantId'&&hex(sha256)&&hash(body)===sha256&&inputs.tenantId===tenantId&&inputs.sourceFullFactsSha256===sourceFullFactsSha256&&inputs.sourceMapFactsSha256===sourceMapFactsSha256&&inputs.payloadSha256===payloadSha256,'COLD_REVIEW_INPUT_CHANGED');
 need(Array.isArray(inputs.orders)&&inputs.orders.length<=512&&Array.isArray(inputs.policies)&&inputs.policies.length<=512&&Buffer.byteLength(canonical(body))<=16*1024**2,'COLD_REVIEW_INPUT_LIMIT');
 return true;
}
