import {fork} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {collectApplicationJsonGraphV1,readApplicationFileV1,assertApplicationPinsV1,applicationBindingV1,applicationOutsideV1,applicationHashV1 as hash,applicationNeedV1 as need} from './runtime-application-config-v1.mjs';
import {createApplicationRegistryV2,appendApplicationRegistryV2,readApplicationRegistryV2} from './runtime-application-registry-v2.mjs';
import {applicationManifestV2,inspectApplicationFieldSlotV2} from './runtime-application-config-v2.mjs';
import {fieldSiteChildRetirementV1} from './runtime-field-site-retirement-v1.mjs';
import {RuntimeColdGuardV1} from './runtime-cold-portable-entry-v1.mjs';
import {IdentityAuthorityGuardV1,authorityRuntimeV1} from '../server/identity-authority-live-v1.ts';

const fieldChildScript=fileURLToPath(new URL('./runtime-field-site-child-v1.mjs',import.meta.url));
const childScript=fileURLToPath(new URL('./runtime-application-child-v2.mjs',import.meta.url));
const errorCode=error=>/^[A-Z][A-Z0-9_]{3,120}$/.test(error?.message??'')?error.message:'APPLICATION_COMPONENT_FAILURE';
const deadline=(promise,ms,code)=>new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error(code)),ms);promise.then(value=>{clearTimeout(timer);ok(value);},error=>{clearTimeout(timer);no(error);});});
export async function launchApplicationSuiteV3(file,{startupSignal}={}){
 const cancelled=()=>{const e=Error('APPLICATION_SUITE_START_CANCELLED');e.shutdown={allOwnedChildrenTerminal:true,allOwnedResourcesRetired:true,components:0};return e;};
 if(startupSignal?.aborted)throw cancelled();
 let prepared;try{prepared=await(async()=>{
 const path=resolve(file),raw=await readApplicationFileV1(path),manifest=applicationManifestV2(JSON.parse(raw.bytes.toString('utf8').replace(/^\uFEFF/,''))),from=p=>resolve(dirname(path),p),root=from(manifest.registryDirectory);
 const normalize=p=>process.platform==='win32'?p.toLowerCase():p,runtimeFiles=manifest.components.map(c=>normalize(from(c.runtimeFile)));need(new Set(runtimeFiles).size===runtimeFiles.length&&!runtimeFiles.includes(normalize(path)),'APPLICATION_COMPONENT_FILE_ALIAS');
 await inspectApplicationFieldSlotV2(path,manifest);
 const graph=await collectApplicationJsonGraphV1([path]),sourcePaths=['runtime-application-config-v1.mjs','runtime-application-config-v2.mjs','runtime-application-registry-v2.mjs','runtime-application-manager-v3.mjs','runtime-application-child-v2.mjs','runtime-field-site-child-v1.mjs','runtime-field-site-retirement-v1.mjs','field-map-site-runtime-v1.mjs','field-map-authority-gateway-v1.mjs','field-map-authority-host-v1.mjs'].map(n=>fileURLToPath(new URL('./'+n,import.meta.url))),sources=await Promise.all(sourcePaths.map(async p=>{const f=await readApplicationFileV1(p);return{path:f.path,sha256:f.sha256};})),pins=[...graph,...sources];
 need(pins.length<=256,'APPLICATION_PINS');
 const trust=JSON.parse((await readApplicationFileV1(from(manifest.trustFile))).bytes.toString('utf8')),authority=authorityRuntimeV1(JSON.parse((await readApplicationFileV1(from(manifest.authorityRuntimeFile))).bytes.toString('utf8'))),guard=new RuntimeColdGuardV1(trust,new IdentityAuthorityGuardV1(authority));
 async function check(){await assertApplicationPinsV1(pins);const state=await guard.assertCurrent();need(canonical(applicationBindingV1(state))===canonical(manifest.binding),'APPLICATION_MANAGER_BINDING');need([root,...graph.map(p=>p.path)].every(p=>applicationOutsideV1(p,state.source.inventory.identity.directory)&&applicationOutsideV1(p,state.details.targetDirectory)),'APPLICATION_REGISTRY_IN_PGDATA');return state;}
 await check();return{path,manifest,from,root,pins,check};
 })();}catch(error){if(startupSignal?.aborted)throw cancelled();throw error;}
 const {path,manifest,from,root,pins,check}=prepared;const registry=await createApplicationRegistryV2(root,manifest,pins),manifestSha256=hash(canonical(manifest)),handles=[];let journal=Promise.resolve(),stopping=false,stopPromise,failure=null,monitor,closeRequestId=null,launchAllocation=Promise.resolve();
 const record=(event,details)=>journal=journal.catch(()=>{}).then(()=>appendApplicationRegistryV2(registry,event,details));
 const shutdownRecord=async(event,details)=>{try{await record(event,details);}catch{failure??=Error('APPLICATION_REGISTRY_FAILURE');}};
 let resolveClosed;const closed=new Promise(ok=>resolveClosed=ok);
 const api={registry,manifestSha256,closed,status(){return{ownerId:registry.ownerId,stopping,failure:failure?errorCode(failure):null,components:handles.map(h=>({id:h.component.id,kind:h.component.kind,pid:h.process.pid,ready:h.ready,closed:h.closed,exit:h.exit??null}))};},async inspect(){await journal;return readApplicationRegistryV2(registry);},close({requestId=closeRequestId??randomUUID()}={}){
  need(typeof requestId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(requestId),'APPLICATION_SUITE_STOP_REQUEST');if(closeRequestId)need(closeRequestId===requestId,'APPLICATION_SUITE_STOP_REQUEST_CHANGED');else closeRequestId=requestId;
  if(stopPromise)return stopPromise;stopping=true;clearInterval(monitor);
  stopPromise=(async()=>{await launchAllocation;await shutdownRecord('GROUP_STOPPING',{requestId});const order=[...handles].sort((a,b)=>(a.component.kind==='SITE'?-1:0)-(b.component.kind==='SITE'?-1:0));
   for(const h of order){
    if(h.exit){await h.terminal;if(h.component.kind==='SITE'&&!h.retirement){failure??=Error('APPLICATION_FIELD_RETIREMENT_UNPROVEN');break;}continue;}h.stopRequestId=requestId;await shutdownRecord('STOP_INTENT',{componentId:h.component.id,pid:h.process.pid??null,requestId:h.stopRequestId});
    let sending=false;const deliver=()=>{if(sending||h.draining||h.closed||h.exit||!h.process.connected)return;sending=true;try{h.process.send({type:'APPLICATION_COMPONENT_STOP',ownerId:registry.ownerId,componentId:h.component.id,challenge:h.challenge,requestId:h.stopRequestId},()=>{sending=false;});}catch{sending=false;}};
    deliver();const delivery=setInterval(deliver,250);try{await h.terminal;}finally{clearInterval(delivery);}
    if(h.component.kind==='SITE'&&!h.retirement){failure??=Error('APPLICATION_FIELD_RETIREMENT_UNPROVEN');break;}
   }
   await journal.catch(()=>{failure??=Error('APPLICATION_REGISTRY_FAILURE');});
   const resourcesRetired=handles.every(h=>!!h.exit&&(h.component.kind!=='SITE'||!!h.retirement)),normal=handles.every(h=>h.ready&&h.exit?.code===0&&h.exit.signal===null&&h.closed&&h.closedRequestId===h.stopRequestId);
   if(!normal)failure??=Error('APPLICATION_COMPONENT_ABNORMAL_CLOSE');await shutdownRecord(normal&&!failure?'GROUP_CLOSED':'FAILED',normal&&!failure?{}:{errorCode:errorCode(failure)});
   const result={normal:normal&&!failure,ownerId:registry.ownerId,components:handles.length,allOwnedChildrenTerminal:handles.every(h=>!!h.exit),allOwnedResourcesRetired:resourcesRetired,failure:failure?errorCode(failure):null};resolveClosed(result);return result;
  })();stopPromise.catch(error=>{failure??=error;resolveClosed({normal:false,allOwnedChildrenTerminal:handles.every(h=>!!h.exit),allOwnedResourcesRetired:handles.every(h=>!!h.exit&&(h.component.kind!=='SITE'||!!h.retirement)),failure:'APPLICATION_REGISTRY_FAILURE'});});return stopPromise;
 }};
 const failed=error=>{failure??=error;api.close().catch(()=>{});};
 const onAbort=()=>{failure??=Error('APPLICATION_SUITE_START_CANCELLED');const id=startupSignal.reason?.requestId;api.close(typeof id==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)?{requestId:id}:{}).catch(()=>{});};
 startupSignal?.addEventListener('abort',onAbort,{once:true});if(startupSignal?.aborted)onAbort();
 async function launch(component){
  let releaseAllocation;launchAllocation=new Promise(ok=>releaseAllocation=ok);try{
  need(!stopping,'APPLICATION_SUITE_STOPPING');await check();const runtimeFile=from(component.runtimeFile),configSha256=(await readApplicationFileV1(runtimeFile)).sha256,challenge=randomBytes(32).toString('hex'),resultFile=join(root,component.id+'-result.private.json'),envelopeFile=join(root,component.id+'-launch.private.json');
  const expectedTenantIds=component.kind==='SITE'?[...manifest.tenantIds].sort():[component.tenantId],envelope={format:component.kind==='SITE'?'RUNTIME_FIELD_SITE_CHILD_V1':'RUNTIME_APPLICATION_CHILD_V1',ownerId:registry.ownerId,parentPid:process.pid,component,runtimeFile,configSha256,manifestSha256,challenge,binding:manifest.binding,expectedTenantIds,pins,resultFile};
  await privateNewFile(envelopeFile,canonical(envelope));need(!stopping&&!startupSignal?.aborted,'APPLICATION_SUITE_START_CANCELLED');await record('LAUNCH_INTENT',{componentId:component.id,kind:component.kind,configSha256,challengeSha256:hash(challenge)});
  const p=fork(component.kind==='SITE'?fieldChildScript:childScript,[envelopeFile],{execArgv:[],windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe','ipc']}),h={component,process:p,challenge,ready:false,closed:false,stopRequestId:null,closedRequestId:null,created:false,authorized:false,retirement:null,messages:Promise.resolve()};handles.push(h);p.stdout.resume();p.stderr.resume();
  let readyOk,readyNo;const ready=new Promise((ok,no)=>{readyOk=ok;readyNo=no;});ready.catch(()=>{});
  h.terminal=new Promise(ok=>p.once('close',(code,signal)=>{h.exit={code,signal};void(async()=>{
   await h.messages;need(p.stdout.closed&&p.stderr.closed&&!p.connected,'APPLICATION_CHILD_STREAMS_NOT_RETIRED');
   if(component.kind==='SITE'){
    let exitRecorded=false;try{
     const result=JSON.parse((await readApplicationFileV1(resultFile)).bytes.toString('utf8')),proof=fieldSiteChildRetirementV1(result,{ownerId:registry.ownerId,componentId:component.id,pid:p.pid,parentPid:process.pid,configSha256,manifestSha256,challenge,enabled:manifest.field.enabled,requestId:h.stopRequestId});
     if(h.closeMessage){need(result.normalClose&&canonical(result.runtimeTerminal)===canonical(h.closeMessage.runtimeTerminal)&&result.startupCancelled===h.closeMessage.startupCancelled,'APPLICATION_FIELD_CLOSED_RESULT');await record('CLOSED',{componentId:component.id,pid:p.pid,requestId:h.stopRequestId});h.closed=true;h.closedRequestId=h.stopRequestId;}
     await record('EXIT',{componentId:component.id,pid:p.pid??null,code,signal});exitRecorded=true;await record('RETIRED',{componentId:component.id,pid:p.pid,proof});h.retirement=proof;
    }catch(error){failure??=error;if(!exitRecorded)await shutdownRecord('EXIT',{componentId:component.id,pid:p.pid??null,code,signal});}
   }else await shutdownRecord('EXIT',{componentId:component.id,pid:p.pid??null,code,signal});
  })().catch(error=>{failure??=error;}).finally(()=>{readyNo(Error('APPLICATION_CHILD_EXIT_BEFORE_READY'));ok(h.exit);if(!stopping)failed(Error('APPLICATION_CHILD_UNEXPECTED_EXIT'));});}));
  p.once('error',error=>{readyNo(error);failed(Error('APPLICATION_CHILD_SPAWN_FAILED'));});
  p.on('message',m=>{h.messages=h.messages.then(async()=>{
   need(m&&m.ownerId===registry.ownerId&&m.componentId===component.id&&m.challenge===challenge&&m.pid===p.pid&&m.configSha256===configSha256&&m.manifestSha256===manifestSha256,'APPLICATION_CHILD_REPLY_BINDING');
   if(m.event==='APPLICATION_COMPONENT_CREATED'){
    need(component.kind==='SITE'&&!h.created&&m.kind==='SITE','APPLICATION_CHILD_CREATED');h.created=true;await record('CREATED',{componentId:component.id,pid:p.pid,challengeSha256:hash(challenge)});
    if(!stopping){await record('START_AUTHORIZED',{componentId:component.id,pid:p.pid});h.authorized=true;if(!stopping)p.send({type:'APPLICATION_COMPONENT_START',ownerId:registry.ownerId,componentId:component.id,challenge},error=>{if(error)failed(Error('APPLICATION_CHILD_START_DELIVERY'));});}
   }else if(m.event==='APPLICATION_COMPONENT_READY'){
    need(component.kind!=='SITE'||h.authorized,'APPLICATION_CHILD_READY_BEFORE_START');
    need(!h.ready&&m.kind===component.kind&&canonical(m.tenantIds)===canonical(expectedTenantIds)&&canonical(m.binding)===canonical(manifest.binding),'APPLICATION_CHILD_READY');if(stopping)return;h.ready=true;await record('READY',{componentId:component.id,pid:p.pid,configSha256,kind:component.kind,tenantIds:m.tenantIds,binding:m.binding});readyOk(h);
   }else if(m.event==='APPLICATION_COMPONENT_DRAINING'){
    need(stopping&&m.requestId===h.stopRequestId&&!h.draining,'APPLICATION_CHILD_DRAIN_REQUEST');h.draining=true;if(h.ready)await record('DRAINING',{componentId:component.id,pid:p.pid,requestId:m.requestId});
   }else if(m.event==='APPLICATION_COMPONENT_CLOSED'){
    need(stopping&&m.requestId===h.stopRequestId&&m.normalClose===true&&!h.closed,'APPLICATION_CHILD_CLOSE_REQUEST');if(component.kind==='SITE'){need(!h.closeMessage,'APPLICATION_CHILD_CLOSE_DUPLICATE');h.closeMessage=m;}else{h.closed=true;h.closedRequestId=m.requestId;await record('CLOSED',{componentId:component.id,pid:p.pid,requestId:m.requestId});}
   }else throw Error('APPLICATION_CHILD_REPLY_EVENT');
  }).catch(error=>{readyNo(error);failed(error);});});
  return deadline(ready,60000,'APPLICATION_CHILD_READY_TIMEOUT');
  }finally{releaseAllocation();}
 }
 try{
  for(const component of [...manifest.components].sort((a,b)=>(a.kind==='SITE'?1:0)-(b.kind==='SITE'?1:0)))await launch(component);
  await check();need(!stopping&&!startupSignal?.aborted,'APPLICATION_SUITE_START_CANCELLED');await record('GROUP_READY');need(!stopping&&!startupSignal?.aborted,'APPLICATION_SUITE_START_CANCELLED');startupSignal?.removeEventListener('abort',onAbort);let checking=false;
  monitor=setInterval(()=>{if(checking||stopping)return;checking=true;check().catch(error=>{if(!stopping)failed(error);}).finally(()=>checking=false);},1000);return api;
 }catch(error){startupSignal?.removeEventListener('abort',onAbort);failure??=error;const result=await api.close();if(errorCode(failure)==='APPLICATION_SUITE_START_CANCELLED'){const e=Error('APPLICATION_SUITE_START_CANCELLED');e.shutdown=result;e.registry=registry;throw e;}throw error;}
}
