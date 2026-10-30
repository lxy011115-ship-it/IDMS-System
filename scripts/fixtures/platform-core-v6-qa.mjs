import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {createPlatformDependenciesV4} from '../platform-dependency-controller-v4.mjs';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
import {exercisePlatformCoreQaV5} from './platform-core-v5-qa.mjs';

const json=async p=>JSON.parse(await readFile(p,'utf8'));
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function within(p,ms,label){let timer;try{return await Promise.race([p,new Promise((_,no)=>timer=setTimeout(()=>no(Error(label)),ms))]);}finally{clearTimeout(timer);}}

/** Extend the accepted core QA with cancellation of actual owned services. */
export async function exercisePlatformCoreQaV6(options){
 const {work,nonce,children,report,note}=options,ctx=await exercisePlatformCoreQaV5(options);
 ctx.cancellationEntries=[];
 const originalCapture=ctx.capture,originalCleanup=ctx.prepareLegacyCleanup;
 ctx.capture=()=>{
  originalCapture();
  for(const item of ctx.cancellationEntries)for(const e of item.api.resources())if(e.kind==='APPLICATIONS'&&!ctx.rootsRegistered.has(e.handle.process.pid)){
   const h={process:e.handle.process,script:'scripts/runtime-application-suite-v2.mjs',stopType:'APPLICATION_SUITE_STOP',lifecycle:e.handle,lifecycleVersion:2,terminal:e.handle.terminal.then(p=>p.exit)};
   h.terminal.catch(()=>{});ctx.rootsRegistered.add(h.process.pid);children.push(h);report.children.push({pid:h.process.pid,script:h.script});
  }
  report.coreCancellationResources=ctx.cancellationEntries.flatMap(item=>item.api.resources().map(e=>({stage:item.stage,id:e.id,kind:e.kind,pid:e.handle.process.pid,directory:e.handle.directory,binding:e.handle.binding??null,registryDirectory:item.registryDirectory,stopProof:e.handle.stopProof??null})));
 };
 ctx.cancelBeforeChildCleanup=async()=>{
  ctx.capture();
  for(const item of [...ctx.cancellationEntries].reverse()){
   const done=await item.api.close();assert(done.allOwnedResourcesRetired,'CORE_CANCEL_OWNED_RESOURCES_NOT_RETIRED');
  }
 };
 ctx.prepareLegacyCleanup=async()=>{
  await ctx.cancelBeforeChildCleanup();
  await originalCleanup();
 };
 const manifest=await json(ctx.config.applicationManifestFile),cases=[];
 report.platformCoreCancellation={cases,realServicesCreated:true,completed:false,wholeStackIntegrated:false,originalRuntimeSwitched:false};
 for(const stage of ['pg','id','app']){
  const controllerRecords=resolve('work/cc-'+nonce+'-'+stage),registryDirectory=resolve('work/cr-'+nonce+'-'+stage);
  await privateDirectory(controllerRecords);
  const manifestFile=join(work,'core-input','cancel-'+stage+'.private.json');
  await privateNewFile(manifestFile,canonical({...manifest,registryDirectory}));
  const config={...ctx.config,workDirectory:controllerRecords,applicationManifestFile:manifestFile};
  await privateNewFile(join(work,'core-input','cancel-'+stage+'-platform.private.json'),canonical(config));
  const abort=new AbortController(),api=await createPlatformDependenciesV4(config,{startupSignal:abort.signal}),item={stage,api,registryDirectory};
  ctx.cancellationEntries.push(item);
  let readyResolved=false,readyRejected=null;const readiness=api.ready.then(()=>{readyResolved=true;},e=>{readyRejected=e.message;});
  const end=Date.now()+300000;let observed=null;
  for(;;){
   ctx.capture();const status=api.status(),resources=api.resources();
   assert(!readyResolved&&!status.fullyReady,'CORE_CANCEL_MISSED_PARTIAL_START');
   assert(!readyRejected,'CORE_CANCEL_START_FAILED_BEFORE_REQUEST');
   if(stage==='pg'&&resources.length===1){observed={components:resources.map(e=>({id:e.id,kind:e.kind,pid:e.handle.process.pid})),applicationMembersCreated:0};break;}
   if(stage==='id'&&resources.some(e=>e.kind==='IDENTITY')){assert.equal(resources.length,3);observed={components:resources.map(e=>({id:e.id,kind:e.kind,pid:e.handle.process.pid})),applicationMembersCreated:0};break;}
   if(stage==='app'&&resources.some(e=>e.kind==='APPLICATIONS')){
    assert.equal(resources.length,5);
    const exists=await lstat(join(registryDirectory,'trust.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(exists){
     const trust=await json(join(registryDirectory,'trust.json')),registry=await readApplicationRegistryV1(trust),launched=registry.events.filter(e=>e.event==='LAUNCH_INTENT');
     assert(!registry.lifecycle.groupReady&&launched.length<9,'CORE_CANCEL_MISSED_APPLICATION_PARTIAL_START');
     if(launched.length>0){assert(!launched.some(e=>e.componentId==='site'));observed={components:resources.map(e=>({id:e.id,kind:e.kind,pid:e.handle.process.pid})),applicationMembersCreated:launched.length,applicationRegistryTrust:trust};break;}
    }
   }
   assert(Date.now()<end,'CORE_CANCEL_STAGE_OBSERVATION_TIMEOUT');await sleep(20);
  }
  assert(observed.components.every(e=>Number.isInteger(e.pid)&&e.pid>0));
  const method=stage==='pg'?'ABORT_SIGNAL':'EXPLICIT_CLOSE',requestId=stage==='pg'?null:randomUUID();
  if(stage==='pg')abort.abort();
  else{const stopping=api.close({requestId});assert.equal(api.close({requestId}),stopping);assert.throws(()=>api.close({requestId:randomUUID()}),/PLATFORM_DEPENDENCY_STOP_REQUEST_CHANGED/);}
  const result=await within(api.closed,300000,'CORE_CANCEL_RETIREMENT_OBSERVATION');await readiness;ctx.capture();
  assert.equal(readyRejected,'PLATFORM_DEPENDENCY_START_CANCELLED');assert(!readyResolved);
  assert(result.normal&&result.startupCancelled&&result.allOwnedResourcesRetired&&!result.fullyReady);assert.equal(result.phase,'CLOSED');
  if(requestId)assert.equal(result.requestId,requestId);
  assert.equal(result.componentsCreated,observed.components.length);assert.deepEqual(await api.close({requestId:result.requestId}),result);
  const resources=[];
  for(const e of api.resources()){
   const proof=e.kind==='APPLICATIONS'?await e.handle.terminal:e.handle.stopProof;
   assert(proof);assert.equal(e.handle.process.exitCode,0);assert.equal(e.handle.process.signalCode,null);
   if(e.kind==='APPLICATIONS'){assert(proof.startupCancelled&&!proof.normalFullGroup&&proof.allOwnedTerminalProven);assert(proof.membersCreated>=observed.applicationMembersCreated&&proof.membersCreated<9);}
   else assert.equal(e.handle.helperAttempts,1);
   resources.push({id:e.id,kind:e.kind,pid:e.handle.process.pid,directory:e.handle.directory,binding:e.handle.binding??null,proof});
  }
  const events=[];for(const name of (await readdir(api.directory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort())events.push(await json(join(api.directory,name)));
  assert(!events.some(e=>e.event==='PLATFORM_READY'));assert.equal(events.at(-1).event,'CLOSED');
  assert.deepEqual(events.filter(e=>e.event==='COMPONENT_CREATED').map(e=>e.id),observed.components.map(e=>e.id));
  assert.deepEqual(events.filter(e=>e.event==='COMPONENT_RETIRED').map(e=>e.id),observed.components.map(e=>e.id).reverse());
  const entry={stage,method,controllerDirectory:api.directory,registryDirectory,observedBeforeCancellation:observed,readyResolved,readyRejected,result,resources,noFurtherComponentsCreated:true,noPlatformReadyEvent:true,reverseNormalRetirement:true,genericKillUsed:false};
  cases.push(entry);await privateNewFile(join(work,'platform-core-cancellation-'+stage+'.json'),canonical(entry));
  note('actual core startup cancellation at '+stage+' stage retires '+resources.length+' already-created components normally in reverse order; no later component or full READY, fixed request retained and no generic kill');
 }
 report.platformCoreCancellation.completed=true;
 await privateNewFile(join(work,'platform-core-cancellation.json'),canonical(report.platformCoreCancellation));
 return ctx;
}
