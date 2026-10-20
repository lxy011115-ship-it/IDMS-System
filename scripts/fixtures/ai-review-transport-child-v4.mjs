import {readFile} from 'node:fs/promises';
import {AiReviewCryptoV4} from '../../server/ai-review-crypto-v4.ts';
import {AiReviewSourceV4} from '../../server/ai-review-source-v4.ts';
import {AiReviewWorkerV4} from '../../server/ai-review-worker-v4.ts';
import {aiReviewConfigDigestV4} from '../../server/ai-review-request-v4.ts';
const input=JSON.parse(await readFile(process.argv[2],'utf8')),crypto=new AiReviewCryptoV4(Buffer.from(input.key,'base64url'),input.binding,input.config),source=new AiReviewSourceV4(input.account,input.binding,crypto);
const worker=new AiReviewWorkerV4({source,account:input.account,admit:async()=>({active:true,configDigest:aiReviewConfigDigestV4(input.config)}),onPhase:async phase=>{if(phase==='RESPONSE_VALIDATED'){process.send?.({phase});process.exit(0);}}});
await worker.runOne();throw Error('AI_REVIEW_CHILD_EXPECTED_EXIT');
