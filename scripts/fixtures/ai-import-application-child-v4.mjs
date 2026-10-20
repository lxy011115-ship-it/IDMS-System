import {readFile} from 'node:fs/promises';
import {AiReviewCryptoV4} from '../../server/ai-review-crypto-v4.ts';
import {AiImportSourceV4} from '../../server/ai-import-source-v4.ts';
import {AiImportApplicationWorkerV4} from '../../server/ai-import-application-worker-v4.ts';
const input=JSON.parse(await readFile(process.argv[2],'utf8')),crypto=new AiReviewCryptoV4(Buffer.from(input.key,'base64url'),input.binding,input.gateway),source=new AiImportSourceV4(input.account,input.binding,crypto,input.stateBinding);
const worker=new AiImportApplicationWorkerV4({source,account:input.account,sources:input.sources,onPhase:async phase=>{if(phase==='STAGED'){process.send?.({phase});process.exit(0);}},onError:async()=>{throw Error('AI_IMPORT_CHILD_APPLICATION_FAILED');}});
await worker.runOne();throw Error('AI_IMPORT_CHILD_EXPECTED_EXIT');
