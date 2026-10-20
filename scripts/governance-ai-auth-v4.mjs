import {createServer} from 'node:http';
import {loadGovernanceAiAuthRuntimeV4} from '../server/governance-ai-auth-runtime-v4.ts';
import {GovernanceConsoleReadV4} from '../server/governance-console-read-v4.ts';
import {createGovernanceAiHttpV4} from '../server/governance-ai-http-v4.ts';
import {GovernanceConsoleJobApiV4} from '../server/governance-console-job-api-v4.ts';
import {GovernanceAiWorkerV4} from '../server/governance-ai-worker-v4.ts';
async function main(){
if(process.argv.length!==3)throw Error('Usage: node scripts/governance-ai-auth-v4.mjs <private-runtime.json>');
const runtime=await loadGovernanceAiAuthRuntimeV4(process.argv[2]),{config,queue,crypto,auth,provider}=runtime;let stopping=false,server;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;server?.close();});
process.on('message',message=>{if(message?.type==='GOVERNANCE_STOP'){stopping=true;server?.close();}});
try{
 if(config.mode==='HTTP'){
  if(!['127.0.0.1','::1'].includes(config.host)||!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error('HTTP binds loopback behind the configured trusted public origin');const api=new GovernanceConsoleJobApiV4({queue,crypto,auth:provider,readAccount:config.business.account,readBinding:config.business.binding});const handler=await createGovernanceAiHttpV4({auth,jobs:api,read:new GovernanceConsoleReadV4(config.business.account,config.business.binding,auth.auditCursors)});server=createServer((req,res)=>handler(req,res));server.requestTimeout=30000;server.headersTimeout=15000;await new Promise((ok,no)=>{server.once('error',no);server.listen(config.port,config.host,ok);});console.log(JSON.stringify({event:'GOVERNANCE_CONSOLE_HTTP_READY',tenant:config.business.binding.tenantId,port:config.port}));await new Promise(ok=>server.once('close',ok));
 }else{
  if(!Array.isArray(config.sources)||!config.sources.length)throw Error('Worker requires the frozen configured source registry');if(!runtime.ai)throw Error('AI_IMPORT_RUNTIME_REQUIRED');const worker=new GovernanceAiWorkerV4({queue,ai:runtime.ai.source,queueAccount:config.queue.account,crypto,auth:provider,account:config.business.account,binding:config.business.binding,sources:config.sources,onError:async error=>process.send?.({type:"CONSOLE_WORKER_ERROR",message:error.message})});console.log(JSON.stringify({event:'GOVERNANCE_CONSOLE_WORKER_READY',tenant:config.business.binding.tenantId}));while(!stopping){try{const job=await worker.runOne();if(job)console.log(JSON.stringify({event:'GOVERNANCE_JOB_STATE',id:job.id,status:job.status}));}catch{console.error('GOVERNANCE_WORKER_RETRY');}if(!stopping)await new Promise(ok=>setTimeout(ok,500));}
 }
}finally{if(server?.listening)await new Promise(ok=>server.close(ok));await runtime.close();if(process.connected)process.disconnect();}

}
main().catch(()=>{console.error('GOVERNANCE_CONSOLE_AUTH_RUNTIME_FAILED');process.exitCode=1;});
