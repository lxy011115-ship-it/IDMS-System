import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const promptVersion = 'import-evidence-review-1.0.0';
export const policyVersion = 'shadow-no-final-approval-1.0.0';
export const findingCodes = ['NO_SEMANTIC_ISSUE', 'INCOMPLETE_COVERAGE', 'SEMANTIC_REVIEW', 'CROSS_FIELD_CONFLICT', 'SUSPECTED_INSTRUCTION'] as const;
export interface Evidence { id:string; kind:'RULE_SUMMARY'|'INPUT_SCOPE'|'DATA_ROW'; content:string; sha256:string }
export interface ReviewRequest {
  version:1; tenantId:string; requestId:string; objectId:string; snapshotDigest:string;
  promptVersion:string; policyVersion:string; scope:{totalRows:number;sampledRows:number;fullContentReviewed:false};
  evidence:Evidence[]; requestDigest:string;
}
export interface ModelReview { decision:'NO_OBJECTION'|'REVIEW_REQUIRED'; risk:'LOW'|'MEDIUM'|'HIGH'; evidenceIds:string[]; findingCodes:string[]; confidence:number }
export interface ReviewReceipt {
  version:1; receiptId:string; requestId:string; tenantId:string; objectId:string; requestDigest:string; snapshotDigest:string;
  status:'SHADOW_REVIEWED'|'HUMAN_REQUIRED'; provenance:'LOCAL_MODEL'|'POLICY'; reason:string;
  model:{name:string;digest:string}; promptVersion:string; policyVersion:string;
  output:ModelReview|null; evidence: {id:string;sha256:string}[]; rawOutputDigest:string|null;
  completedAt:string; mode:'SHADOW'; requiresHumanReview:true; confidenceCalibrated:false;
  usage:{inputTokens:number;outputTokens:number;durationMs:number}|null; signature:string;
}
export class AiError extends Error { code:string; status:number; constructor(code:string,status=422){super(code);this.code=code;this.status=status;} }
export function stable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export function requestHash(request:Omit<ReviewRequest,'requestDigest'>|ReviewRequest){const {requestDigest,...body}=request as ReviewRequest;return sha(stable(body));}
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validateRequest(input:unknown,tenantId:string):ReviewRequest {
  const r=input as ReviewRequest;
  if(!exact(r,['version','tenantId','requestId','objectId','snapshotDigest','promptVersion','policyVersion','scope','evidence','requestDigest'])||r.version!==1||r.tenantId!==tenantId||!uuid(r.requestId)||!uuid(r.objectId)||!hex(r.snapshotDigest)||r.promptVersion!==promptVersion||r.policyVersion!==policyVersion)throw new AiError('INVALID_REQUEST');
  if(!exact(r.scope,['totalRows','sampledRows','fullContentReviewed'])||!Number.isInteger(r.scope.totalRows)||r.scope.totalRows<1||r.scope.totalRows>10000||!Number.isInteger(r.scope.sampledRows)||r.scope.sampledRows<1||r.scope.sampledRows>12||r.scope.sampledRows>r.scope.totalRows||r.scope.fullContentReviewed!==false)throw new AiError('INVALID_SCOPE');
  if(!Array.isArray(r.evidence)||r.evidence.length!==r.scope.sampledRows+2||r.evidence.some(e=>!e||typeof e!=='object'||Array.isArray(e))||new Set(r.evidence.map(e=>e.id)).size!==r.evidence.length)throw new AiError('INVALID_EVIDENCE');
  for(const e of r.evidence)if(!exact(e,['id','kind','content','sha256'])||typeof e.id!=='string'||!/^[A-Z][A-Z0-9_-]{0,39}$/.test(e.id)||!['RULE_SUMMARY','INPUT_SCOPE','DATA_ROW'].includes(e.kind)||typeof e.content!=='string'||Buffer.byteLength(e.content)>2400||!hex(e.sha256)||sha(e.content)!==e.sha256)throw new AiError('INVALID_EVIDENCE');
  if(r.evidence.filter(e=>e.kind==='RULE_SUMMARY').length!==1||r.evidence.filter(e=>e.kind==='INPUT_SCOPE').length!==1||r.evidence.filter(e=>e.kind==='DATA_ROW').length!==r.scope.sampledRows||!hex(r.requestDigest)||requestHash(r)!==r.requestDigest)throw new AiError('REQUEST_DIGEST_MISMATCH');
  return r;
}
// A heuristic signal, not a complete prompt-injection defence. No tools or final approvals are exposed.
export function suspiciousInstruction(text:string){return /ignore[\s\S]{0,60}(?:instructions|rules)|(?:system|developer)\s*(?:prompt|message)|忽略[\s\S]{0,30}(?:指令|规则)|跳过[\s\S]{0,20}(?:审批|审核)|直接[\s\S]{0,15}(?:批准|关单)|(?:reveal|print)[\s\S]{0,30}(?:secret|token|password)/i.test(text.normalize('NFKC'));}
export const outputSchema={type:'object',additionalProperties:false,required:['decision','risk','evidenceIds','findingCodes','confidence'],properties:{decision:{type:'string',enum:['NO_OBJECTION','REVIEW_REQUIRED']},risk:{type:'string',enum:['LOW','MEDIUM','HIGH']},evidenceIds:{type:'array',minItems:1,maxItems:14,items:{type:'string'}},findingCodes:{type:'array',minItems:1,maxItems:5,items:{type:'string',enum:[...findingCodes]}},confidence:{type:'number',minimum:0,maximum:1}}};
export function validateModelOutput(value:unknown,request:ReviewRequest):ModelReview {
  const o=value as ModelReview;
  if(!exact(o,['decision','risk','evidenceIds','findingCodes','confidence'])||!['NO_OBJECTION','REVIEW_REQUIRED'].includes(o.decision)||!['LOW','MEDIUM','HIGH'].includes(o.risk)||typeof o.confidence!=='number'||!Number.isFinite(o.confidence)||o.confidence<0||o.confidence>1)throw new AiError('MODEL_SCHEMA_INVALID');
  if(!Array.isArray(o.evidenceIds)||o.evidenceIds.length<1||o.evidenceIds.length>request.evidence.length||new Set(o.evidenceIds).size!==o.evidenceIds.length||o.evidenceIds.some(id=>!request.evidence.some(e=>e.id===id)))throw new AiError('MODEL_EVIDENCE_INVALID');
  if(!Array.isArray(o.findingCodes)||!o.findingCodes.length||o.findingCodes.length>5||new Set(o.findingCodes).size!==o.findingCodes.length||o.findingCodes.some(c=>!(findingCodes as readonly string[]).includes(c)))throw new AiError('MODEL_SCHEMA_INVALID');
  if(o.decision==='NO_OBJECTION'&&(o.risk!=='LOW'||o.findingCodes.length!==1||o.findingCodes[0]!=='NO_SEMANTIC_ISSUE')||o.decision==='REVIEW_REQUIRED'&&o.findingCodes.includes('NO_SEMANTIC_ISSUE'))throw new AiError('MODEL_POLICY_CONFLICT');
  if(request.scope.totalRows>request.scope.sampledRows&&(o.decision!=='REVIEW_REQUIRED'||!o.findingCodes.includes('INCOMPLETE_COVERAGE')))throw new AiError('MODEL_COVERAGE_CONFLICT');
  return o;
}
export function signReceipt(receipt:Omit<ReviewReceipt,'signature'>|ReviewReceipt,token:string){const {signature,...body}=receipt as ReviewReceipt;return createHmac('sha256',token).update(stable(body)).digest('hex');}
export function validateReceipt(input:unknown,request:ReviewRequest,token:string):ReviewReceipt {
  const r=input as ReviewReceipt;
  if(!exact(r,['version','receiptId','requestId','tenantId','objectId','requestDigest','snapshotDigest','status','provenance','reason','model','promptVersion','policyVersion','output','evidence','rawOutputDigest','completedAt','mode','requiresHumanReview','confidenceCalibrated','usage','signature'])||r.version!==1||!uuid(r.receiptId)||r.requestId!==request.requestId||r.tenantId!==request.tenantId||r.objectId!==request.objectId||r.requestDigest!==request.requestDigest||r.snapshotDigest!==request.snapshotDigest||r.promptVersion!==request.promptVersion||r.policyVersion!==request.policyVersion||r.mode!=='SHADOW'||r.requiresHumanReview!==true||r.confidenceCalibrated!==false||!hex(r.signature))throw new AiError('RECEIPT_INVALID');
  const expected=signReceipt(r,token);if(!timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(r.signature,'hex')))throw new AiError('RECEIPT_SIGNATURE_INVALID');
  if(!['SHADOW_REVIEWED','HUMAN_REQUIRED'].includes(r.status)||!['LOCAL_MODEL','POLICY'].includes(r.provenance)||typeof r.reason!=='string'||r.reason.length>100||!exact(r.model,['name','digest'])||typeof r.model.name!=='string'||!/^sha256:[a-f0-9]{64}$/.test(r.model.digest)||!Number.isFinite(Date.parse(r.completedAt)))throw new AiError('RECEIPT_INVALID');
  if(r.output!==null){validateModelOutput(r.output,request);if(r.provenance!=='LOCAL_MODEL'||!hex(r.rawOutputDigest))throw new AiError('RECEIPT_INVALID');}
  if(r.provenance==='POLICY'&&(r.status!=='HUMAN_REQUIRED'||r.output!==null||r.usage!==null)||r.provenance==='LOCAL_MODEL'&&r.output===null||r.rawOutputDigest!==null&&!hex(r.rawOutputDigest))throw new AiError('RECEIPT_INVALID');
  if(r.provenance==='LOCAL_MODEL'&&(!exact(r.usage,['inputTokens','outputTokens','durationMs'])||!Number.isInteger(r.usage!.inputTokens)||r.usage!.inputTokens<1||!Number.isInteger(r.usage!.outputTokens)||r.usage!.outputTokens<1||!Number.isFinite(r.usage!.durationMs)||r.usage!.durationMs<0))throw new AiError('RECEIPT_USAGE_INVALID');
  if(r.status==='SHADOW_REVIEWED'&&(!r.output||r.provenance!=='LOCAL_MODEL'))throw new AiError('RECEIPT_INVALID');
  const expectedEvidence=(r.output?.evidenceIds||request.evidence.map(e=>e.id)).map(id=>{const e=request.evidence.find(e=>e.id===id)!;return {id:e.id,sha256:e.sha256};});
  if(stable(r.evidence)!==stable(expectedEvidence))throw new AiError('RECEIPT_EVIDENCE_INVALID');
  return r;
}
export async function readLimited(stream:AsyncIterable<Uint8Array>|null,max:number){const parts:Buffer[]=[];let size=0;if(!stream)throw new AiError('EMPTY_BODY',400);for await(const part of stream){size+=part.length;if(size>max)throw new AiError('BODY_TOO_LARGE',413);parts.push(Buffer.from(part));}return Buffer.concat(parts).toString('utf8');}
export const findingLabels:Record<string,string>={NO_SEMANTIC_ISSUE:'抽样材料未发现语义问题；不代表整批正确',INCOMPLETE_COVERAGE:'仅抽样审阅，未覆盖全部行',SEMANTIC_REVIEW:'需要人工语义复核',CROSS_FIELD_CONFLICT:'可能存在跨字段冲突，需人工核实',SUSPECTED_INSTRUCTION:'材料疑似包含指令内容'};
