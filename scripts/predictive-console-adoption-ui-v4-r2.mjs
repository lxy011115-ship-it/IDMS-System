import {createServer} from 'node:http';
import {loadPredictiveConsoleAuthRuntimeV4} from '../server/predictive-console-auth-runtime-v4.ts';
import {PredictiveConsoleReadV4} from '../server/predictive-console-http-v4.ts';
import {PredictiveConsoleQueryV4} from '../server/predictive-console-query-v4.ts';
import {PredictiveLegacyReadV4,PredictiveAdoptionStoreV4} from '../server/predictive-legacy-adoption-v4.ts';
import {createPredictiveAdoptionUiHttpV4R2} from '../server/predictive-adoption-ui-http-v4-r2.ts';
import {PredictiveAdoptingJobStoreV4} from '../server/predictive-adopting-job-store-v4.ts';
import {PredictiveCommandWorkerV4} from '../server/predictive-command-worker-v4.ts';
async function main(){
 if(process.argv.length!==3)throw Error('PREDICTIVE_ADOPTION_ARGUMENT');
 const runtime=await loadPredictiveConsoleAuthRuntimeV4(process.argv[2]),{config,queue,crypto,auth,provider,transport,predictor,sources}=runtime;let stopping=false,server;
 const stop=()=>{stopping=true;server?.close();};for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);process.on('message',m=>{if(m?.type==='PREDICTIVE_STOP')stop();});
 try{
  const read=new PredictiveConsoleReadV4(config.business.account,config.business.binding),query=new PredictiveConsoleQueryV4({account:config.business.account,binding:config.business.binding,codec:auth.auditCursors,queue,proof:read}),legacy=new PredictiveLegacyReadV4(config.business.account,config.business.binding,query),adoption=new PredictiveAdoptionStoreV4(queue);await adoption.probe(config.mode==='WORKER');
  if(config.mode==='HTTP'){
   if(!['127.0.0.1','::1'].includes(config.host)||!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error('PREDICTIVE_LOOPBACK_REQUIRED');
   server=createServer(await createPredictiveAdoptionUiHttpV4R2({auth,provider,queue,crypto,read,query,legacy,adoption,tenantId:config.business.binding.tenantId}));server.requestTimeout=30000;server.headersTimeout=15000;await new Promise((ok,no)=>{server.once('error',no);server.listen(config.port,config.host,ok);});console.log(JSON.stringify({event:'PREDICTIVE_ADOPTION_UI_HTTP_READY',tenant:config.business.binding.tenantId,port:config.port}));await new Promise(ok=>server.once('close',ok));
  }else{
   if(!transport||!predictor||!sources)throw Error('PREDICTIVE_SERVICES_REQUIRED');const adopting=new PredictiveAdoptingJobStoreV4({account:config.business.account,binding:config.business.binding,queueAccount:config.queue.account,queueBinding:config.queue.binding,crypto,auth:provider,read:legacy});const worker=new PredictiveCommandWorkerV4({queue:adopting,crypto,auth:provider,account:config.business.account,binding:config.business.binding,predictor,workflow:transport,sources});
   console.log(JSON.stringify({event:'PREDICTIVE_ADOPTION_UI_WORKER_READY',tenant:config.business.binding.tenantId}));while(!stopping){try{const job=await worker.runOne();if(job)console.log(JSON.stringify({event:'PREDICTIVE_JOB_STATE',id:job.id,status:job.status}));}catch{console.error('PREDICTIVE_ADOPTION_WORKER_RETRY');}if(!stopping)await new Promise(ok=>setTimeout(ok,500));}
  }
 }finally{if(server?.listening)await new Promise(ok=>server.close(ok));await runtime.close();if(process.connected)process.disconnect();}
}
main().catch(()=>{console.error('PREDICTIVE_ADOPTION_RUNTIME_FAILED');process.exitCode=1;});
