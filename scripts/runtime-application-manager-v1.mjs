import {fork} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {applicationManifestV1,collectApplicationJsonGraphV1,readApplicationFileV1,assertApplicationPinsV1,applicationBindingV1,applicationOutsideV1,applicationHashV1 as hash,applicationNeedV1 as need} from './runtime-application-config-v1.mjs';
import {createApplicationRegistryV1,appendApplicationRegistryV1,readApplicationRegistryV1} from './runtime-application-registry-v1.mjs';
import {RuntimeColdGuardV1} from './runtime-cold-portable-entry-v1.mjs';
import {IdentityAuthorityGuardV1,authorityRuntimeV1} from '../server/identity-authority-live-v1.ts';

const childScript=fileURLToPath(new URL('./runtime-application-child-v1.mjs',import.meta.url));
const errorCode=error=>/^[A-Z][A-Z0-9_]{3,120}$/.test(error?.message??'')?error.message:'APPLICATION_COMPONENT_FAILURE';
const deadline=(promise,ms,code)=>new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error(code)),ms);promise.then(value=>{clearTimeout(timer);ok(value);},error=>{clearTimeout(timer);no(error);});});
export async function launchApplicationSuiteV1(file){
 const path=resolve(file),raw=await readApplicationFileV1(path),manifest=applicationManifestV1(JSON.parse(raw.bytes.toString('utf8').replace(/^\uFEFF/,''))),from=p=>resolve(dirname(path),p),root=from(manifest.registryDirectory);
 const normalize=p=>process.platform==='win32'?p.toLowerCase():p,runtimeFiles=manifest.components.map(c=>normalize(from(c.runtimeFile)));need(new Set(runtimeFiles).size===runtimeFiles.length&&!runtimeFiles.includes(normalize(path)),'APPLICATION_COMPONENT_FILE_ALIAS');
 const graph=await collectApplicationJsonGraphV1([path]),sourcePaths=['runtime-application-config-v1.mjs','runtime-application-registry-v1.mjs','runtime-application-manager-v1.mjs','runtime-application-child-v1.mjs','runtime-application-suite-v1.mjs'].map(n=>fileURLToPath(new URL('./'+n,import.meta.url))),sources=await Promise.all(sourcePaths.map(async p=>{const f=await readApplicationFileV1(p);return{path:f.path,sha256:f.sha256};})),pins=[...graph,...sources];
 need(pins.length<=256,'APPLICATION_PINS');
 const trust=JSON.parse((await readApplicationFileV1(from(manifest.trustFile))).bytes.toString('utf8')),authority=authorityRuntimeV1(JSON.parse((await readApplicationFileV1(from(manifest.authorityRuntimeFile))).bytes.toString('utf8'))),guard=new RuntimeColdGuardV1(trust,new IdentityAuthorityGuardV1(authority));
 async function check(){await assertApplicationPinsV1(pins);const state=await guard.assertCurrent();need(canonical(applicationBindingV1(state))===canonical(manifest.binding),'APPLICATION_MANAGER_BINDING');need([root,...graph.map(p=>p.path)].every(p=>applicationOutsideV1(p,state.source.inventory.identity.directory)&&applicationOutsideV1(p,state.details.targetDirectory)),'APPLICATION_REGISTRY_IN_PGDATA');return state;}
 await check();const registry=await createApplicationRegistryV1(root,manifest,pins),manifestSha256=hash(canonical(manifest)),handles=[];let journal=Promise.resolve(),stopping=false,stopPromise,failure=null,monitor;
 const record=(event,details)=>journal=journal.catch(()=>{}).then(()=>appendApplicationRegistryV1(registry,event,details));
 const shutdownRecord=async(event,details)=>{try{await record(event,details);}catch{failure??=Error('APPLICATION_REGISTRY_FAILURE');}};
 let resolveClosed;const closed=new Promise(ok=>resolveClosed=ok);
 const api={registry,manifestSha256,closed,status(){return{ownerId:registry.ownerId,stopping,failure:failure?errorCode(failure):null,components:handles.map(h=>({id:h.component.id,kind:h.component.kind,pid:h.process.pid,ready:h.ready,closed:h.closed,exit:h.exit??null}))};},async inspect(){await journal;return readApplicationRegistryV1(registry);},close({requestId=randomUUID()}={}){
  if(stopPromise)return stopPromise;stopping=true;clearInterval(monitor);
  stopPromise=(async()=>{await shutdownRecord('GROUP_STOPPING',{requestId});const order=[...handles].sort((a,b)=>(a.component.kind==='SITE'?-1:0)-(b.component.kind==='SITE'?-1:0));
   for(const h of order){
    if(h.exit)continue;h.stopRequestId=randomUUID();await shutdownRecord('STOP_INTENT',{componentId:h.component.id,pid:h.process.pid??null,requestId:h.stopRequestId});
    if(h.process.connected)await new Promise(ok=>h.process.send({type:'APPLICATION_COMPONENT_STOP',ownerId:registry.ownerId,componentId:h.component.id,challenge:h.challenge,requestId:h.stopRequestId},()=>ok()));
    await h.terminal;
   }
   await journal.catch(()=>{failure??=Error('APPLICATION_REGISTRY_FAILURE');});
   const normal=handles.every(h=>h.exit?.code===0&&h.exit.signal===null&&h.closed&&h.closedRequestId===h.stopRequestId);
   if(!normal)failure??=Error('APPLICATION_COMPONENT_ABNORMAL_CLOSE');await shutdownRecord(normal&&!failure?'GROUP_CLOSED':'FAILED',normal&&!failure?{}:{errorCode:errorCode(failure)});
   const result={normal:normal&&!failure,ownerId:registry.ownerId,components:handles.length,allOwnedChildrenTerminal:handles.every(h=>!!h.exit),failure:failure?errorCode(failure):null};resolveClosed(result);return result;
  })();stopPromise.catch(error=>{failure??=error;resolveClosed({normal:false,allOwnedChildrenTerminal:handles.every(h=>!!h.exit),failure:'APPLICATION_REGISTRY_FAILURE'});});return stopPromise;
 }};
 const failed=error=>{failure??=error;api.close().catch(()=>{});};
 async function launch(component){
  need(!stopping,'APPLICATION_SUITE_STOPPING');await check();const runtimeFile=from(component.runtimeFile),configSha256=(await readApplicationFileV1(runtimeFile)).sha256,challenge=randomBytes(32).toString('hex'),resultFile=join(root,component.id+'-result.private.json'),envelopeFile=join(root,component.id+'-launch.private.json');
  const expectedTenantIds=component.kind==='SITE'?[...manifest.tenantIds].sort():[component.tenantId],envelope={format:'RUNTIME_APPLICATION_CHILD_V1',ownerId:registry.ownerId,parentPid:process.pid,component,runtimeFile,configSha256,manifestSha256,challenge,binding:manifest.binding,expectedTenantIds,pins,resultFile};
  await privateNewFile(envelopeFile,canonical(envelope));await record('LAUNCH_INTENT',{componentId:component.id,kind:component.kind,configSha256});
  const p=fork(childScript,[envelopeFile],{execArgv:[],windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe','ipc']}),h={component,process:p,challenge,ready:false,closed:false,stopRequestId:null,closedRequestId:null};handles.push(h);p.stdout.resume();p.stderr.resume();
  let readyOk,readyNo;const ready=new Promise((ok,no)=>{readyOk=ok;readyNo=no;});ready.catch(()=>{});
  h.terminal=new Promise(ok=>p.once('close',(code,signal)=>{h.exit={code,signal};record('EXIT',{componentId:component.id,pid:p.pid??null,code,signal}).catch(failed);readyNo(Error('APPLICATION_CHILD_EXIT_BEFORE_READY'));ok(h.exit);if(!stopping)failed(Error('APPLICATION_CHILD_UNEXPECTED_EXIT'));}));
  p.once('error',error=>{readyNo(error);failed(Error('APPLICATION_CHILD_SPAWN_FAILED'));});
  p.on('message',m=>{(async()=>{
   need(m&&m.ownerId===registry.ownerId&&m.componentId===component.id&&m.challenge===challenge&&m.pid===p.pid&&m.configSha256===configSha256&&m.manifestSha256===manifestSha256,'APPLICATION_CHILD_REPLY_BINDING');
   if(m.event==='APPLICATION_COMPONENT_READY'){
    need(!h.ready&&!stopping&&m.kind===component.kind&&canonical(m.tenantIds)===canonical(expectedTenantIds)&&canonical(m.binding)===canonical(manifest.binding),'APPLICATION_CHILD_READY');h.ready=true;await record('READY',{componentId:component.id,pid:p.pid,configSha256,kind:component.kind,tenantIds:m.tenantIds,binding:m.binding});readyOk(h);
   }else if(m.event==='APPLICATION_COMPONENT_DRAINING'){
    need(stopping&&m.requestId===h.stopRequestId,'APPLICATION_CHILD_DRAIN_REQUEST');await record('DRAINING',{componentId:component.id,pid:p.pid,requestId:m.requestId});
   }else if(m.event==='APPLICATION_COMPONENT_CLOSED'){
    need(stopping&&m.requestId===h.stopRequestId&&m.normalClose===true&&!h.closed,'APPLICATION_CHILD_CLOSE_REQUEST');h.closed=true;h.closedRequestId=m.requestId;await record('CLOSED',{componentId:component.id,pid:p.pid,requestId:m.requestId});
   }else throw Error('APPLICATION_CHILD_REPLY_EVENT');
  })().catch(error=>{readyNo(error);failed(error);});});
  return deadline(ready,60000,'APPLICATION_CHILD_READY_TIMEOUT');
 }
 try{
  for(const component of [...manifest.components].sort((a,b)=>(a.kind==='SITE'?1:0)-(b.kind==='SITE'?1:0)))await launch(component);
  await check();await record('GROUP_READY');let checking=false;
  monitor=setInterval(()=>{if(checking||stopping)return;checking=true;check().catch(error=>{if(!stopping)failed(error);}).finally(()=>checking=false);},1000);return api;
 }catch(error){failure??=error;await api.close();throw error;}
}
