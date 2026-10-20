import {createServer} from 'node:http';
import {loadGovernanceJobRuntimeV4} from '../server/governance-job-runtime-v4.ts';
import {GovernanceJobApiV4} from '../server/governance-job-api-v4.ts';
import {GovernanceJobWorkerV4} from '../server/governance-job-worker-v4.ts';
if(process.argv.length!==3)throw Error('Usage: node scripts/governance-jobs-v4.mjs <private-runtime.json>');
const runtime=await loadGovernanceJobRuntimeV4(process.argv[2]),{config,queue,crypto,auth,provider}=runtime;let stopping=false,server;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;server?.close();});
process.on('message',message=>{if(message?.type==='GOVERNANCE_STOP'){stopping=true;server?.close();}});
try{
 if(config.mode==='HTTP'){
  if(!['127.0.0.1','::1'].includes(config.host)||!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error('HTTP binds loopback behind the configured trusted public origin');const api=new GovernanceJobApiV4({queue,crypto,auth:provider,readAccount:config.business.account,readBinding:config.business.binding});server=createServer(async(req,res)=>{try{if(await auth.handle(req,res,new URL(req.url||'/',config.auth.origin)))return;if(await api.handle(req,res))return;res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"NOT_FOUND"}');}catch{if(res.headersSent)res.destroy();else{res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"GOVERNANCE_UNAVAILABLE"}');}}});server.requestTimeout=30000;server.headersTimeout=15000;await new Promise((ok,no)=>{server.once('error',no);server.listen(config.port,config.host,ok);});console.log(JSON.stringify({event:'GOVERNANCE_JOBS_HTTP_READY',tenant:config.business.binding.tenantId,port:config.port}));await new Promise(ok=>server.once('close',ok));
 }else{
  if(!Array.isArray(config.sources)||!config.sources.length)throw Error('Worker requires the frozen configured source registry');const worker=new GovernanceJobWorkerV4({queue,queueAccount:config.queue.account,crypto,auth:provider,account:config.business.account,binding:config.business.binding,sources:config.sources});console.log(JSON.stringify({event:'GOVERNANCE_JOBS_WORKER_READY',tenant:config.business.binding.tenantId}));while(!stopping){try{const job=await worker.runOne();if(job)console.log(JSON.stringify({event:'GOVERNANCE_JOB_STATE',id:job.id,status:job.status}));}catch{console.error('GOVERNANCE_WORKER_RETRY');}if(!stopping)await new Promise(ok=>setTimeout(ok,500));}
 }
}finally{if(server?.listening)await new Promise(ok=>server.close(ok));await runtime.close();if(process.connected)process.disconnect();}
