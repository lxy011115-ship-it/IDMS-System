import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {applicationNeedV1 as need,applicationBindingV1,assertApplicationPinsV1,applicationHashV1 as hash} from './runtime-application-config-v1.mjs';
import {loadRuntimeColdBackgroundV1} from './runtime-cold-background-v1.mjs';
import {loadRuntimeColdSiteV1,createRuntimeColdSiteHttpV1,loadRuntimeColdReconciliationV1} from './runtime-cold-portable-entry-v1.mjs';

async function main(){
 need(process.argv.length===3&&process.connected,'APPLICATION_CHILD_PARENT');
 const e=JSON.parse(await readFile(process.argv[2],'utf8'));
 need(e.format==='RUNTIME_APPLICATION_CHILD_V1'&&typeof e.challenge==='string'&&/^[a-f0-9]{64}$/.test(e.challenge)&&Number.isInteger(e.parentPid)&&e.parentPid===process.ppid,'APPLICATION_CHILD_ENVELOPE');
 const common={ownerId:e.ownerId,componentId:e.component.id,challenge:e.challenge,pid:process.pid,configSha256:e.configSha256,manifestSha256:e.manifestSha256};
 let runtime,server,closing=false,wake,requestId=null,reason='FAILURE',problem,ready=false,closePromise,serverClosePromise;
 const send=async value=>{if(process.connected)await new Promise((ok,no)=>process.send({...common,...value},error=>error?no(error):ok()));};
 const check=async()=>{if(closing)return null;await assertApplicationPinsV1(e.pins);if(closing)return null;const state=e.component.kind==='SITE'||e.component.kind==='RECONCILIATION'?await runtime.coldGuard.assertCurrent():await runtime.assertCurrent();need(canonical(applicationBindingV1(state))===canonical(e.binding),'APPLICATION_CHILD_BINDING_CHANGED');return state;};
 const closeServer=()=>{if(serverClosePromise)return serverClosePromise;if(!server?.listening)return Promise.resolve();serverClosePromise=new Promise((ok,no)=>server.close(error=>error?no(error):ok()));server.closeIdleConnections();return serverClosePromise;};
 const drain=()=>closePromise??=(async()=>{try{await closeServer();}finally{await runtime?.close();}})();
 const stop=(id,why)=>{if(closing)return;closing=true;requestId=id;reason=why;if(ready)send({event:'APPLICATION_COMPONENT_DRAINING',requestId}).catch(()=>{});if(e.component.kind!=='SITE'&&e.component.kind!=='RECONCILIATION'&&runtime)runtime.close().catch(error=>problem??=error);closeServer().catch(error=>problem??=error);wake?.();};
 process.on('message',m=>{if(m?.type==='APPLICATION_COMPONENT_STOP'&&m.ownerId===e.ownerId&&m.componentId===e.component.id&&m.challenge===e.challenge&&/^[a-f0-9-]{36}$/.test(m.requestId))stop(m.requestId,'REQUESTED');});
 process.once('disconnect',()=>stop(null,'PARENT_DISCONNECTED'));for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>stop(null,s));if(!process.connected)stop(null,'PARENT_DISCONNECTED');
 try{
  await assertApplicationPinsV1(e.pins);
  if(e.component.kind==='SITE')runtime=await loadRuntimeColdSiteV1(e.runtimeFile);
  else if(e.component.kind==='RECONCILIATION')runtime=await loadRuntimeColdReconciliationV1(e.runtimeFile);
  else{runtime=await loadRuntimeColdBackgroundV1(e.runtimeFile);need(runtime.kind===e.component.kind,'APPLICATION_CHILD_KIND');}
  await check();const tenantIds=e.component.kind==='SITE'?[...runtime.base.members.keys()].sort():[e.component.kind==='RECONCILIATION'?runtime.config.business.binding.tenantId:runtime.tenantId];
  need(canonical(tenantIds)===canonical(e.expectedTenantIds),'APPLICATION_CHILD_TENANTS');
  if(!closing&&e.component.kind==='SITE'){
   const handler=await createRuntimeColdSiteHttpV1(runtime);server=createServer((req,res)=>{(async()=>{try{need(!closing,'APPLICATION_CHILD_CLOSING');await check();await handler(req,res);}catch{if(!res.headersSent)res.writeHead(503,{'cache-control':'no-store'});res.end();}})();});
   server.requestTimeout=30000;server.headersTimeout=15000;await new Promise((ok,no)=>{server.once('error',no);server.listen(runtime.config.port,runtime.config.host,ok);});
  }
  if(!closing){const current=await check();if(!closing){ready=true;await send({event:'APPLICATION_COMPONENT_READY',kind:e.component.kind,tenantIds,binding:applicationBindingV1(current)});}}
  if(e.component.kind==='SITE'){
   while(!closing){await check();if(closing)break;await new Promise(ok=>{const timer=setTimeout(()=>{wake=null;ok();},500);wake=()=>{clearTimeout(timer);wake=null;ok();};});}
  }else{
   while(!closing){await check();if(closing)break;let worked;try{worked=e.component.kind==='RECONCILIATION'?await runtime.worker.runOne():await runtime.runOne();}catch(error){if(closing)break;await check();console.error('APPLICATION_COMPONENT_JOB_RETRY');}if(!closing&&!worked)await new Promise(ok=>{const timer=setTimeout(()=>{wake=null;ok();},500);wake=()=>{clearTimeout(timer);wake=null;ok();};});}
  }
 }catch(error){problem=error;closing=true;reason='FAILED';}
 finally{
  try{await drain();}catch(error){problem??=error;}
  const result={format:'RUNTIME_APPLICATION_CHILD_RESULT_V2',ownerId:e.ownerId,componentId:e.component.id,pid:process.pid,parentPid:e.parentPid,configSha256:e.configSha256,manifestSha256:e.manifestSha256,requestId,reason,normalClose:!problem,errorCode:problem?(/^[A-Z][A-Z0-9_]{3,120}$/.test(problem.message)?problem.message:'APPLICATION_CHILD_RUNTIME_FAILURE'):null,ready,challengeSha256:hash(e.challenge)};
  await privateNewFile(e.resultFile,canonical(result));
  if(!problem)await send({event:'APPLICATION_COMPONENT_CLOSED',requestId,normalClose:true}).catch(()=>{});
  else console.error('APPLICATION_COMPONENT_FAILED');
  if(process.connected)process.disconnect();if(problem)process.exitCode=1;
 }
}
main().catch(()=>{console.error('APPLICATION_COMPONENT_FAILED');if(process.connected)process.disconnect();process.exitCode=1;});
