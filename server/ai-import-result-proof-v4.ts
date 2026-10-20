import {AiImportSourceV4,type AiImportApplicationClaimV4} from './ai-import-source-v4.ts';
import {aiImportApplicationIdentityV4,type AiImportIntentV4} from './ai-import-contract-v4.ts';
import type {AiReviewOutcomeV4} from './ai-review-crypto-v4.ts';
import {aiReviewNeedV4 as need} from './ai-review-request-v4.ts';
type ProofData={intent:AiImportIntentV4;outcome:AiReviewOutcomeV4;outcomeDigest:string;identity:ReturnType<typeof aiImportApplicationIdentityV4>};
const brand=new WeakSet<object>();
export class VerifiedAiImportResultV4 {
 #data:ProofData;
 private constructor(data:ProofData){this.#data=structuredClone(data);brand.add(this);}
 static async verify(source:AiImportSourceV4,claim:AiImportApplicationClaimV4){need(source instanceof AiImportSourceV4,'AI_IMPORT_SOURCE_REQUIRED');await source.checkApplicationClaim(claim);const task=await source.read(claim.requestId);need(task?.status==='RESULT_READY'&&task.outcomeDigest===claim.outcomeDigest,'AI_IMPORT_RESULT_REQUIRED');const intent=await source.intent(task.header),outcome=source.outcome(task);return new VerifiedAiImportResultV4({intent,outcome,outcomeDigest:claim.outcomeDigest,identity:aiImportApplicationIdentityV4(task.header.tenantId,claim.requestId,task.header.objectId,claim.outcomeDigest)});}
 data(){need(brand.has(this),'AI_IMPORT_VERIFIED_PROOF_REQUIRED');return structuredClone(this.#data);}
}
