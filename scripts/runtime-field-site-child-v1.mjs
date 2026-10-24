import {createServer} from 'node:http';
import {resolve,dirname,basename} from 'node:path';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {applicationBindingV1,assertApplicationPinsV1,applicationHashV1,readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {createFieldMapSiteRuntimeV1} from './field-map-site-runtime-v1.mjs';

const need=(value,code)=>{if(!value)throw Error(code);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const errorCode=e=>/^[A-Z][A-Z0-9_]{3,120}$/.test(e?.message??'')?e.message:'FIELD_SITE_CHILD_RUNTIME_FAILED';

/** Only a newly forked SITE slot. The parent holds the fork before it authorizes START. */
async function main(){
 need(process.argv.length===3&&process.connected,'FIELD_SITE_CHILD_PARENT');
 const launch=await readApplicationFileV1(process.argv[2]),e=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(launch.bytes));
 need(exact(e,['format','ownerId','parentPid','component','runtimeFile','configSha256','manifestSha256','challenge','binding','expectedTenantIds','pins','resultFile'])&&e.format==='RUNTIME_FIELD_SITE_CHILD_V1'&&uuid(e.ownerId)&&e.parentPid===process.ppid&&digest(e.challenge)&&digest(e.configSha256)&&digest(e.manifestSha256),'FIELD_SITE_CHILD_ENVELOPE');
 need(exact(e.component,['id','kind','tenantId','runtimeFile'])&&/^[a-z][a-z0-9_-]{0,63}$/.test(e.component.id)&&e.component.kind==='SITE'&&e.component.tenantId===null,'FIELD_SITE_CHILD_COMPONENT');
 need(typeof e.runtimeFile==='string'&&resolve(e.runtimeFile)===e.runtimeFile&&typeof e.resultFile==='string'&&resolve(e.resultFile)===e.resultFile&&dirname(e.resultFile)===dirname(launch.path)&&basename(e.resultFile)===e.component.id+'-result.private.json','FIELD_SITE_CHILD_PATH');
 need(Array.isArray(e.pins)&&e.pins.length>0&&e.pins.length<=256&&Array.isArray(e.expectedTenantIds)&&e.expectedTenantIds.length>0&&e.expectedTenantIds.every(v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v))&&new Set(e.expectedTenantIds).size===e.expectedTenantIds.length,'FIELD_SITE_CHILD_PINS_OR_TENANTS');
 need(exact(e.binding,['controlId','sourceHash','authorityHash'])&&uuid(e.binding.controlId)&&digest(e.binding.sourceHash)&&digest(e.binding.authorityHash),'FIELD_SITE_CHILD_BINDING');
 const common={ownerId:e.ownerId,componentId:e.component.id,challenge:e.challenge,pid:process.pid,configSha256:e.configSha256,manifestSha256:e.manifestSha256};
 let runtime=null,server=null,closing=false,requestId=null,reason=null,problem=null,ready=false,started=false,wake=null,serverCloseJob=null,fieldStopJob=null,closeJob=null,terminal=null,rejectedStopRequests=0;
 let releaseStart;const startGate=new Promise(ok=>releaseStart=ok);
 const send=async value=>{if(process.connected)await new Promise((ok,no)=>process.send({...common,...value},error=>error?no(error):ok()));};
 function sameMessage(m){return m?.ownerId===e.ownerId&&m.componentId===e.component.id&&m.challenge===e.challenge;}
 function stopField(){if(runtime&&!fieldStopJob){fieldStopJob=Promise.resolve().then(()=>runtime.requestStop(requestId?{requestId}:{}));void fieldStopJob.catch(error=>problem??=error);}return fieldStopJob??Promise.resolve();}
 function closeServer(){if(serverCloseJob)return serverCloseJob;if(!server?.listening)return Promise.resolve();serverCloseJob=new Promise((ok,no)=>server.close(error=>error?no(error):ok()));server.closeIdleConnections();return serverCloseJob;}
 function stop(id,why){
  if(closing){if(id&&id!==requestId)rejectedStopRequests++;return;}
  closing=true;requestId=id;reason=why;releaseStart(false);
  // Cancel field HTTP/SQL before waiting for HTTP server.close, which waits for those requests.
  stopField();void closeServer().catch(error=>problem??=error);wake?.();
  if(ready)void send({event:'APPLICATION_COMPONENT_DRAINING',requestId}).catch(error=>problem??=error);
 }
 async function check(requireReady=false){need(!closing,'FIELD_SITE_CHILD_CLOSING');await assertApplicationPinsV1(e.pins);need((await readApplicationFileV1(e.runtimeFile)).sha256===e.configSha256,'FIELD_SITE_CHILD_RUNTIME_CHANGED');const current=await runtime.assertCurrent();need(canonical(applicationBindingV1(current))===canonical(e.binding),'FIELD_SITE_CHILD_BINDING_CHANGED');if(requireReady)need(runtime.state().ready,'FIELD_SITE_CHILD_NOT_READY');return current;}
 async function drain(){return closeJob??=(async()=>{const early=stopField(),http=closeServer();const result=await Promise.allSettled([early,http]);if(runtime){try{terminal=await runtime.close(requestId?{requestId}:{});}catch(error){problem??=error;}}const failed=result.find(r=>r.status==='rejected');if(failed)problem??=failed.reason;})();}
 process.on('message',m=>{if(!sameMessage(m))return;if(m.type==='APPLICATION_COMPONENT_START'&&!closing&&!started){started=true;releaseStart(true);}else if(m.type==='APPLICATION_COMPONENT_STOP'&&uuid(m.requestId))stop(m.requestId,'REQUESTED');});
 process.once('disconnect',()=>stop(null,'PARENT_DISCONNECTED'));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stop(null,signal));
 try{
  await send({event:'APPLICATION_COMPONENT_CREATED',kind:'SITE'});if(!process.connected)stop(null,'PARENT_DISCONNECTED');
  if(await startGate){
   await assertApplicationPinsV1(e.pins);need((await readApplicationFileV1(e.runtimeFile)).sha256===e.configSha256,'FIELD_SITE_CHILD_RUNTIME_CHANGED');
   if(!closing){runtime=createFieldMapSiteRuntimeV1(e.runtimeFile);await runtime.ready;}
   if(!closing){const current=await check(true),tenants=[...runtime.base.members.keys()].sort();need(canonical(tenants)===canonical([...e.expectedTenantIds].sort()),'FIELD_SITE_CHILD_TENANTS');server=createServer((req,res)=>{if(closing){req.resume();res.writeHead(503,{'cache-control':'no-store'});res.end();return;}void runtime.handleHttp(req,res).catch(error=>{if(!closing){problem??=error;stop(null,'FAILED');}if(!res.destroyed&&!res.writableEnded){if(!res.headersSent)res.writeHead(503,{'cache-control':'no-store'});res.end();}});});server.requestTimeout=30000;server.headersTimeout=15000;
    await new Promise((ok,no)=>{server.once('error',no);server.listen(runtime.config.port,runtime.config.host,ok);});
    if(!closing){await check(true);ready=true;await send({event:'APPLICATION_COMPONENT_READY',kind:'SITE',tenantIds:tenants,binding:applicationBindingV1(current)});}
   }
   // Runtime owns MQTT reconnection; continued identity/config checks do not end that retry loop.
   while(!closing){await check();await new Promise(ok=>{const timer=setTimeout(()=>{wake=null;ok();},500);wake=()=>{clearTimeout(timer);wake=null;ok();};});}
  }
 }catch(error){const cancelled=closing&&requestId&&runtime?.state().failure===null&&['FIELD_SITE_CANCELLED','FIELD_GATEWAY_CANCELLED','FIELD_MAP_CANCELLED','FIELD_SITE_CHILD_CLOSING'].includes(errorCode(error));if(!cancelled)problem??=error;if(!closing)stop(null,'FAILED');}
 finally{
  await drain();const normalClose=!problem&&reason==='REQUESTED'&&uuid(requestId),result={format:'RUNTIME_FIELD_SITE_CHILD_RESULT_V1',ownerId:e.ownerId,componentId:e.component.id,pid:process.pid,parentPid:e.parentPid,requestId,reason,ready,started,normalClose,startupCancelled:normalClose&&!ready,rejectedStopRequests,configSha256:e.configSha256,manifestSha256:e.manifestSha256,challengeSha256:applicationHashV1(e.challenge),errorCode:problem?errorCode(problem):null,runtimeTerminal:terminal};
  await privateNewFile(e.resultFile,canonical(result));if(normalClose)await send({event:'APPLICATION_COMPONENT_CLOSED',requestId,normalClose:true,startupCancelled:!ready,runtimeTerminal:terminal}).catch(()=>{});else console.error('FIELD_SITE_CHILD_FAILED');if(process.connected)process.disconnect();if(!normalClose)process.exitCode=1;
 }
}
main().catch(()=>{console.error('FIELD_SITE_CHILD_FAILED');if(process.connected)process.disconnect();process.exitCode=1;});
