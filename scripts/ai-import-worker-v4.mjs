import {loadAiImportRuntimeV4} from '../server/ai-import-runtime-v4.ts';
import {AiReviewWorkerV4} from '../server/ai-review-worker-v4.ts';
import {AiImportApplicationWorkerV4} from '../server/ai-import-application-worker-v4.ts';
async function main(){
 if(process.argv.length!==3)throw Error('AI_IMPORT_RUNTIME_ARGUMENT');const runtime=await loadAiImportRuntimeV4(process.argv[2]),{source,config,sources}=runtime;let stopping=false;
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});process.on('message',m=>{if(m?.type==='AI_IMPORT_STOP')stopping=true;});
 const transport=new AiReviewWorkerV4({source,account:config.source.account,admit:header=>source.admitTransport(header)}),application=new AiImportApplicationWorkerV4({source,account:config.source.account,sources,onError:async()=>{console.error('AI_IMPORT_APPLICATION_RETRY');}});
 console.log(JSON.stringify({event:'AI_IMPORT_WORKER_READY',tenant:source.binding.tenantId}));try{while(!stopping){try{const a=await application.runOne();if(a?.status==='APPLIED')console.log(JSON.stringify({event:'AI_IMPORT_APPLIED',requestId:a.requestId}));if(stopping)break;const r=await transport.runOne();if(r?.status==='RESULT_READY')console.log(JSON.stringify({event:'AI_IMPORT_RESULT_READY',requestId:r.requestId}));}catch{console.error('AI_IMPORT_WORKER_RETRY');}if(!stopping)await new Promise(ok=>setTimeout(ok,500));}}finally{if(process.connected)process.disconnect();}
}
main().catch(()=>{console.error('AI_IMPORT_RUNTIME_FAILED');process.exitCode=1;});
