import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {createPlatformDependenciesV6} from '../platform-dependency-controller-v6.mjs';
import {stopPredictorLifecycleV1} from '../predictor-lifecycle-v1.mjs';
import {exercisePlatformCoreFaultsQaV4} from './platform-core-faults-v4-qa.mjs';

const json=async file=>JSON.parse(await readFile(file,'utf8')),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(probe,label){const end=Date.now()+300000;for(;;){const v=await probe();if(v)return v;assert(Date.now()<end,label);await sleep(25);}}

/** New faults apply to the actual sixth dependency, after all previous core cases. */
export async function exercisePlatformCorePredictorQaV1(options){
 const {work,nonce,report,children,site,note}=options,ctx=await exercisePlatformCoreFaultsQaV4(options),capture=ctx.capture,close=ctx.cancelBeforeChildCleanup,cleanup=ctx.prepareLegacyCleanup;
 const items=[],cases=[],input=join(work,'predictor-fault-input');await privateDirectory(input);
 ctx.capture=()=>{
  capture();
  for(const item of items)for(const e of item.api.resources())if(e.kind==='APPLICATIONS'&&!ctx.rootsRegistered.has(e.handle.process.pid)){
   const h={process:e.handle.process,script:'scripts/runtime-application-suite-v2.mjs',stopType:'APPLICATION_SUITE_STOP',lifecycle:e.handle,lifecycleVersion:2,terminal:e.handle.terminal.then(p=>p.exit)};h.terminal.catch(()=>{});ctx.rootsRegistered.add(h.process.pid);children.push(h);report.children.push({pid:h.process.pid,script:h.script});
  }
  report.corePredictorFaultResources=items.flatMap(item=>item.api.resources().map(e=>({stage:item.stage,id:e.id,kind:e.kind,pid:e.handle.process.pid,directory:e.handle.directory,binding:e.handle.binding??null,registryDirectory:item.registryDirectory,retirementProof:e.kind==='APPLICATIONS'?e.handle.retirementProof:e.handle.stopProof??null})));
 };
 ctx.cancelBeforeChildCleanup=async()=>{
  for(const[file,bytes]of ctx.faultRestorations){await writeFile(file,bytes);ctx.faultRestorations.delete(file);}
  for(const item of [...items].reverse()){const done=await item.api.close();assert(done.allOwnedResourcesRetired,'CORE_PREDICTOR_FAULT_CLEANUP_BLOCKED');}
  ctx.capture();await close();
 };
 ctx.prepareLegacyCleanup=async()=>{await ctx.cancelBeforeChildCleanup();await cleanup();};
 report.platformPredictorFaults={cases,completed:false,allProductionDependenciesRegistered:false,originalRuntimeSwitched:false};
 const manifest=await json(ctx.config.applicationManifestFile);
 async function ingressClosed(){try{await fetch(site.origin+'/api/v4/site/context',{redirect:'error',signal:AbortSignal.timeout(1000)});return false;}catch(error){return error.cause?.code==='ECONNREFUSED';}}
 for(const stage of ['predictor-config','unexpected-predictor']){
  const label=stage==='predictor-config'?'pc':'up',records=resolve('work/pc-'+nonce+'-'+label),registryDirectory=resolve('work/pr-'+nonce+'-'+label);await privateDirectory(records);
  const applicationManifestFile=join(input,label+'-applications.private.json'),runtimeFile=join(input,label+'-predictor.private.json');await privateNewFile(applicationManifestFile,canonical({...manifest,registryDirectory}));await privateNewFile(runtimeFile,await readFile(ctx.config.predictor.runtimeFile));
  const config={...ctx.config,workDirectory:records,applicationManifestFile,predictor:{...ctx.config.predictor,runtimeFile,workDirectory:records}},api=await createPlatformDependenciesV6(config),item={stage,api,registryDirectory};items.push(item);
  const ready=await api.ready;ctx.capture();assert.equal(ready.components.length,6);assert.equal(ready.phase,'READY');
  const resources=api.resources(),predictor=resources.find(e=>e.kind==='PREDICTOR'),app=resources.find(e=>e.kind==='APPLICATIONS'),parents=resources.filter(e=>['POSTGRES','IDENTITY','WORKFLOW'].includes(e.kind));let blocked=null,original=null,actorProof=null;
  try{
   if(stage==='predictor-config'){
    original=await readFile(runtimeFile);ctx.faultRestorations.set(runtimeFile,original);await writeFile(runtimeFile,Buffer.concat([original,Buffer.from('\n')]));
    blocked=await until(()=>api.status().phase==='BLOCKED'?api.status().lastResult:null,'CORE_PREDICTOR_BLOCK_NOT_OBSERVED');assert.equal(blocked.blocked.length,1);assert.equal(blocked.blocked[0].id,predictor.id);assert.equal(blocked.blocked[0].errorCode,'PREDICTOR_INPUT_CHANGED');
    assert.equal(app.handle.process.exitCode,0);assert.equal(predictor.handle.process.exitCode,null);await until(ingressClosed,'CORE_PREDICTOR_DRIFT_INGRESS_STILL_OPEN');
    await assert.rejects(lstat(join(predictor.handle.directory,'stop-intent.json')),{code:'ENOENT'});await assert.rejects(lstat(join(predictor.handle.directory,'child-stop-accepted.private.json')),{code:'ENOENT'});
    for(const e of parents){assert.equal(e.handle.helperAttempts,0);assert.equal(e.handle.process.exitCode,null);await assert.rejects(lstat(join(e.handle.directory,'stop-intent.json')),{code:'ENOENT'});}
    const names=(await readdir(api.directory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort();assert.equal((await json(join(api.directory,names.at(-1)))).event,'BLOCKED');
    await writeFile(runtimeFile,original);ctx.faultRestorations.delete(runtimeFile);const done=await api.close({requestId:blocked.requestId});assert(done.allOwnedResourcesRetired);assert.equal(done.requestId,blocked.requestId);
   }else{
    actorProof=await stopPredictorLifecycleV1(predictor.handle);assert(actorProof.normalClose&&actorProof.allOwnedTerminalProven&&!actorProof.genericKillUsed);
   }
   const result=await api.closed;ctx.capture();assert(result.allOwnedResourcesRetired&&!result.normal&&result.fullyReady);assert.equal(result.phase,'FAILED');assert.equal(result.componentsCreated,6);await until(ingressClosed,'CORE_PREDICTOR_FAULT_INGRESS_STILL_OPEN');
   const events=[];for(const file of(await readdir(api.directory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort())events.push(await json(join(api.directory,file)));
   const retired=events.filter(e=>e.event==='COMPONENT_RETIRED');assert.deepEqual(retired.map(e=>e.id),resources.map(e=>e.id).reverse());assert.deepEqual(retired.filter(e=>!e.normal).map(e=>e.kind),stage==='unexpected-predictor'?['PREDICTOR']:[]);
   assert.equal(api.status().failure,stage==='predictor-config'?'PLATFORM_DEPENDENCY_INPUT_CHANGED':'PLATFORM_DEPENDENCY_UNEXPECTED_EXIT');assert.equal(events.at(-1).event,'FAILED');
   const entry={stage,controllerDirectory:api.directory,registryDirectory,result,blockedResult:blocked,actorProof,ingressActuallyClosed:true,originalRuntimeBytesRestored:!original||(await readFile(runtimeFile)).equals(original),allEarlierDependenciesUnsignalledWhileBlocked:!!blocked,sameRequestRetained:!blocked||result.requestId===blocked.requestId,normalPlatformShutdownClaimed:false,genericKillUsed:false};cases.push(entry);await privateNewFile(join(work,'platform-predictor-fault-'+label+'.json'),canonical(entry));
   note('actual '+stage+' fault withdraws application ingress, preserves owned reverse-order retirement and same-request retry, and records the platform FAILED without generic signals');
  }finally{
   if(original&&ctx.faultRestorations.has(runtimeFile)){await writeFile(runtimeFile,original);ctx.faultRestorations.delete(runtimeFile);}
   const result=await api.close();assert(result.allOwnedResourcesRetired,'CORE_PREDICTOR_FAULT_FINALLY_BLOCKED');ctx.capture();
  }
 }
 report.platformPredictorFaults.completed=true;await privateNewFile(join(work,'platform-predictor-faults.json'),canonical(report.platformPredictorFaults));return ctx;
}
