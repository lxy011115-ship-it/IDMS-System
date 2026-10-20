import {createServer} from 'node:http';
import {loadMaintenanceConsoleAuthRuntimeV4} from '../server/maintenance-console-auth-runtime-v4.ts';
import {MaintenanceConsoleReadV4} from '../server/maintenance-console-read-v4.ts';
import {MaintenanceConsoleJobApiV4} from '../server/maintenance-console-job-api-v4.ts';
import {createMaintenanceConsoleHttpV4} from '../server/maintenance-console-http-v4.ts';
import {MaintenanceCommandWorkerV4} from '../server/maintenance-command-worker-v4.ts';
import {MaintenanceFlowStoreV4} from '../server/maintenance-flow-store-v4.ts';
import {MaintenanceFlowWorkerV4} from '../server/maintenance-flow-worker-v4.ts';
async function main(){
 if(process.argv.length!==3)throw Error('MAINTENANCE_RUNTIME_ARGUMENT');
 const runtime=await loadMaintenanceConsoleAuthRuntimeV4(process.argv[2]),{config,queue,crypto,auth,provider,transport}=runtime;let stopping=false,server;
 const stop=()=>{stopping=true;server?.close();};for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);process.on('message',m=>{if(m?.type==='MAINTENANCE_STOP')stop();});
 try{
  if(config.mode==='HTTP'){
   if(!['127.0.0.1','::1'].includes(config.host)||!Number.isInteger(config.port)||config.port<1||config.port>65535)throw Error('MAINTENANCE_LOOPBACK_REQUIRED');
   const read=new MaintenanceConsoleReadV4(config.business.account,config.business.binding,auth.auditCursors,queue.binding.deployment),jobs=new MaintenanceConsoleJobApiV4({queue,crypto,auth:provider,read,readAccount:config.business.account,readBinding:config.business.binding});
   server=createServer(createMaintenanceConsoleHttpV4({auth,jobs,read}));server.requestTimeout=30000;server.headersTimeout=15000;await new Promise((ok,no)=>{server.once('error',no);server.listen(config.port,config.host,ok);});console.log(JSON.stringify({event:'MAINTENANCE_HTTP_READY',tenant:config.business.binding.tenantId,port:config.port}));await new Promise(ok=>server.once('close',ok));
  }else{
   if(!transport)throw Error('MAINTENANCE_WORKFLOW_REQUIRED');
   const options={queue,crypto,auth:provider,account:config.business.account,binding:config.business.binding,workflowBinding:transport.binding},commands=new MaintenanceCommandWorkerV4(options),flows=new MaintenanceFlowWorkerV4({...options,flows:new MaintenanceFlowStoreV4(queue),transport});
   console.log(JSON.stringify({event:'MAINTENANCE_WORKER_READY',tenant:config.business.binding.tenantId}));
   while(!stopping){try{const c=await commands.runOne();if(c)console.log(JSON.stringify({event:'MAINTENANCE_COMMAND_STATE',id:c.id,status:c.status}));if(!stopping){const f=await flows.runOne();if(f)console.log(JSON.stringify({event:'MAINTENANCE_FLOW_STATE',status:f.status}));}}catch{console.error('MAINTENANCE_WORKER_RETRY');}if(!stopping)await new Promise(ok=>setTimeout(ok,500));}
  }
 }finally{if(server?.listening)await new Promise(ok=>server.close(ok));await runtime.close();if(process.connected)process.disconnect();}
}
main().catch(()=>{console.error('MAINTENANCE_AUTH_RUNTIME_FAILED');process.exitCode=1;});
