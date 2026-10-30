import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {createPlatformDependenciesV5} from '../platform-dependency-controller-v5.mjs';
import {stopWorkflowLifecycleV2} from '../workflow-lifecycle-portable-v2.mjs';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
import {exercisePlatformCoreQaV8} from './platform-core-v8-qa.mjs';

const json=async p=>JSON.parse(await readFile(p,'utf8')),sleep=ms=>new Promise(ok=>setTimeout(ok,ms)),hash=b=>createHash('sha256').update(b).digest('hex');
async function within(p,ms,label){let timer;try{return await Promise.race([p,new Promise((_,no)=>timer=setTimeout(()=>no(Error(label)),ms))]);}finally{clearTimeout(timer);}}
async function until(probe,label,ms=180000){const end=Date.now()+ms;for(;;){const value=await probe();if(value)return value;assert(Date.now()<end,label);await sleep(25);}}

export async function exercisePlatformCoreFaultsQaV3(options){
 const {work,nonce,report,children,note,site}=options,ctx=await exercisePlatformCoreQaV8(options);
 const baseCapture=ctx.capture,baseClose=ctx.cancelBeforeChildCleanup,baseCleanup=ctx.prepareLegacyCleanup;
 ctx.faultEntries=[];ctx.faultRestorations=new Map();
 ctx.capture=()=>{
  baseCapture();
  for(const item of ctx.faultEntries)for(const e of item.api.resources())if(e.kind==='APPLICATIONS'&&!ctx.rootsRegistered.has(e.handle.process.pid)){
   const h={process:e.handle.process,script:'scripts/runtime-application-suite-v2.mjs',stopType:'APPLICATION_SUITE_STOP',lifecycle:e.handle,lifecycleVersion:2,terminal:e.handle.terminal.then(p=>p.exit)};
   h.terminal.catch(()=>{});ctx.rootsRegistered.add(h.process.pid);children.push(h);report.children.push({pid:h.process.pid,script:h.script});
  }
  report.coreFaultResources=ctx.faultEntries.flatMap(item=>item.api.resources().map(e=>({stage:item.stage,id:e.id,kind:e.kind,pid:e.handle.process.pid,directory:e.handle.directory,binding:e.handle.binding??null,registryDirectory:item.registryDirectory,retirementProof:e.kind==='APPLICATIONS'?e.handle.retirementProof:e.handle.stopProof??null})));
 };
 ctx.cancelBeforeChildCleanup=async()=>{
  for(const[file,bytes]of ctx.faultRestorations){await writeFile(file,bytes);ctx.faultRestorations.delete(file);}
  ctx.capture();
  for(const item of [...ctx.faultEntries].reverse()){const result=await item.api.close();assert(result.allOwnedResourcesRetired,'CORE_FAULT_OWNED_RESOURCES_NOT_RETIRED');}
  await baseClose();
 };
 ctx.prepareLegacyCleanup=async()=>{await ctx.cancelBeforeChildCleanup();await baseCleanup();};
 const manifest=await json(ctx.config.applicationManifestFile),cases=[];report.platformCoreFaults={cases,completed:false,sourceProfile:report.sourceBundle.profile,backendSessionsExplicit:true,allFaultMatrixCasesComplete:false,originalRuntimeSwitched:false};
 const input=join(work,'fault-input');await privateDirectory(input);
 async function ingressClosed(){try{await fetch(site.origin+'/api/v4/site/context',{redirect:'error',signal:AbortSignal.timeout(1500)});return false;}catch(error){return error.cause?.code==='ECONNREFUSED';}}
 for(const stage of ['workflow-config','application-config','unexpected-workflow']){
  const label={ 'workflow-config':'wc','application-config':'ac','unexpected-workflow':'uw'}[stage],records=resolve('work/fc-'+nonce+'-'+label),registryDirectory=resolve('work/fr-'+nonce+'-'+label);await privateDirectory(records);
  const manifestFile=join(input,label+'-application.private.json');await privateNewFile(manifestFile,canonical({...manifest,registryDirectory}));
  const flow={...ctx.config.workflows[0]};for(const key of ['runtimeFile','cancelFile','reservationFile'])if(flow[key]){const file=join(input,label+'-'+key+'.private.json');await privateNewFile(file,await readFile(flow[key]));flow[key]=file;}
  const config={...ctx.config,workDirectory:records,workflows:[flow],applicationManifestFile:manifestFile};await privateNewFile(join(input,label+'-platform.private.json'),canonical(config));
  const api=await createPlatformDependenciesV5(config),item={stage,api,registryDirectory};ctx.faultEntries.push(item);
  const ready=await within(api.ready,300000,'CORE_FAULT_READY_OBSERVATION');ctx.capture();assert.equal(ready.phase,'READY');assert.equal(ready.components.length,5);
  const resources=api.resources(),app=resources.find(e=>e.kind==='APPLICATIONS'),workflow=resources.find(e=>e.kind==='WORKFLOW'),pgs=resources.filter(e=>e.kind==='POSTGRES');
  let blocked=null,preflightRejectedWhileApplicationLive=false,firstTerminalUnproven=false,initialProofSha256=null,originalBytes=null,driftedFile=null,actorWorkflowProof=null,ownedCopyFile=null,ownedCopyBytes=null,ownedCopyAudit=null;
  try{
   if(stage==='workflow-config'){
    ownedCopyFile=join(workflow.handle.directory,'runtime.private.json');ownedCopyBytes=await readFile(ownedCopyFile);const ownedPin=(await json(join(workflow.handle.directory,'launch-intent.json'))).files.find(p=>p.path===ownedCopyFile);assert(ownedPin&&hash(ownedCopyBytes)===ownedPin.sha256);ctx.faultRestorations.set(ownedCopyFile,ownedCopyBytes);await writeFile(ownedCopyFile,Buffer.concat([ownedCopyBytes,Buffer.from('\n')]));assert.notEqual(hash(await readFile(ownedCopyFile)),ownedPin.sha256);ownedCopyAudit={path:ownedCopyFile,expectedSha256:ownedPin.sha256,changedBeforeStopPreflight:true};
    driftedFile=flow.runtimeFile;originalBytes=await readFile(driftedFile);ctx.faultRestorations.set(driftedFile,originalBytes);await writeFile(driftedFile,Buffer.concat([originalBytes,Buffer.from('\n')]));
    blocked=await until(()=>api.status().phase==='BLOCKED'?api.status().lastResult:null,'CORE_FAULT_WORKFLOW_BLOCK_OBSERVATION');
    const durableBlockedFiles=(await readdir(api.directory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort();assert.equal((await json(join(api.directory,durableBlockedFiles.at(-1)))).event,'BLOCKED','CORE_FAULT_BLOCKED_NOT_DURABLE');
    assert.equal(blocked.blocked.length,1);assert.equal(blocked.blocked[0].id,'workflow');assert.equal(workflow.handle.helperAttempts,0);
    await assert.rejects(lstat(join(workflow.handle.directory,'stop-intent.json')),{code:'ENOENT'});
    assert.equal(app.handle.process.exitCode,0);await until(ingressClosed,'CORE_FAULT_INGRESS_NOT_WITHDRAWN');
   }else if(stage==='application-config'){
    driftedFile=manifestFile;originalBytes=await readFile(driftedFile);ctx.faultRestorations.set(driftedFile,originalBytes);await writeFile(driftedFile,Buffer.concat([originalBytes,Buffer.from('\n')]));
    const requestId=randomUUID();blocked=await within(api.close({requestId}),5000,'CORE_FAULT_APP_PREFLIGHT_HUNG');
    assert.equal(blocked.phase,'BLOCKED');assert.equal(blocked.blocked.length,1);assert.equal(blocked.blocked[0].id,'applications');
    preflightRejectedWhileApplicationLive=app.handle.process.exitCode===null&&app.handle.process.signalCode===null;assert(preflightRejectedWhileApplicationLive,'CORE_FAULT_LIVE_PREFLIGHT_NOT_EXERCISED');
    await assert.rejects(lstat(join(app.handle.directory,'stop-intent.json')),{code:'ENOENT'});
    const first=await within(app.handle.terminal,180000,'CORE_FAULT_APPLICATION_SELF_EXIT');assert.equal(first.exit.code,1);assert.equal(first.exit.signal,null);assert(!first.allOwnedTerminalProven);
    firstTerminalUnproven=true;initialProofSha256=hash(await readFile(join(app.handle.directory,'terminal-proof.json')));await until(ingressClosed,'CORE_FAULT_APP_INGRESS_NOT_WITHDRAWN');
   }else{
    // An out-of-band, typed normal stop of this exact owned JVM is unexpected to
    // the controller; no target signal or arbitrary PID is used for injection.
    actorWorkflowProof=await stopWorkflowLifecycleV2(workflow.handle);assert(actorWorkflowProof.helperReplyConfirmed&&!actorWorkflowProof.targetSignalSent);
   }
   if(blocked){
    assert(!blocked.allOwnedResourcesRetired);assert(pgs.every(e=>e.handle.helperAttempts===0&&e.handle.process.exitCode===null));
    for(const e of pgs)await assert.rejects(lstat(join(e.handle.directory,'stop-intent.json')),{code:'ENOENT'});
    if(ownedCopyFile){await writeFile(ownedCopyFile,ownedCopyBytes);ctx.faultRestorations.delete(ownedCopyFile);assert.equal(hash(await readFile(ownedCopyFile)),hash(ownedCopyBytes));}
    await writeFile(driftedFile,originalBytes);ctx.faultRestorations.delete(driftedFile);assert.equal(hash(await readFile(driftedFile)),hash(originalBytes));
    const result=await within(api.close({requestId:blocked.requestId}),180000,'CORE_FAULT_SAME_REQUEST_RETRY');assert.equal(result.requestId,blocked.requestId);assert(result.allOwnedResourcesRetired,'CORE_FAULT_RETRY_REUSED_BLOCKED_ATTEMPT');
   }
   const result=await within(api.closed,180000,'CORE_FAULT_RETIREMENT_OBSERVATION');ctx.capture();
   assert(result.allOwnedResourcesRetired&&!result.normal&&result.fullyReady&&!result.startupCancelled);assert.equal(result.phase,'FAILED');assert.equal(result.componentsCreated,5);assert.deepEqual(result.blocked,[]);await until(ingressClosed,'CORE_FAULT_FINAL_INGRESS_NOT_WITHDRAWN');
   const captured=[];
   for(const e of resources){const proof=e.kind==='APPLICATIONS'?e.handle.retirementProof:e.handle.stopProof;assert(proof);assert.equal(e.handle.process.signalCode,null);if(e.kind!=='APPLICATIONS'){assert.equal(e.handle.process.exitCode,0);assert.equal(e.handle.helperAttempts,1);}captured.push({id:e.id,kind:e.kind,pid:e.handle.process.pid,directory:e.handle.directory,binding:e.handle.binding??null,proof});}
   const trust=await json(join(registryDirectory,'trust.json')),registry=await readApplicationRegistryV1(trust);assert.equal(registry.header.ownerPid,app.handle.process.pid);assert(registry.lifecycle.terminal);assert.equal(registry.events.filter(e=>e.event==='EXIT').length,9);
   if(stage==='application-config'){
    assert(app.handle.retirementProof.allOwnedTerminalProven&&!app.handle.retirementProof.normalFullGroup&&!app.handle.retirementProof.startupCancelled);assert.equal(hash(await readFile(join(app.handle.directory,'terminal-proof.json'))),initialProofSha256);
    const reinspection=await json(join(app.handle.directory,'retirement-reinspection.private.json'));assert.equal(reinspection.pid,app.handle.process.pid);assert.deepEqual(reinspection.proof,app.handle.retirementProof);
   }else assert(app.handle.retirementProof.normalFullGroup);
   const events=[];for(const name of(await readdir(api.directory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort())events.push(await json(join(api.directory,name)));
   assert.equal(events.at(-1).event,'FAILED');assert.equal(events.filter(e=>e.event==='COMPONENT_RETIRED').length,5);
   const entry={stage,controllerDirectory:api.directory,registryDirectory,result,failureCode:api.status().failure,blockedResult:blocked,ownedCopyAudit,ownedDeploymentCopyBytesRestored:!ownedCopyFile||hash(await readFile(ownedCopyFile))===hash(ownedCopyBytes),preflightRejectedWhileApplicationLive,firstTerminalUnproven,initialProofSha256,originalConfigurationBytesRestored:!driftedFile||hash(await readFile(driftedFile))===hash(originalBytes),sameRequestRetained:!blocked||result.requestId===blocked.requestId,ingressActuallyClosed:true,pgHelpersBeforeUnblock:blocked?0:null,resources:captured,applicationRegistryTrust:trust,actorWorkflowProof,unexpectedDependencyExit:stage==='unexpected-workflow',normalServiceShutdownClaimed:false,genericKillUsed:false};
   cases.push(entry);await privateNewFile(join(work,'platform-core-fault-'+label+'.json'),canonical(entry));
   note('actual core '+stage+' fault withdraws ingress, keeps PG un-signalled until owned application/JVM retirement is proven, preserves same-request retry where blocked, and ends FAILED with all five resources retired');
  }finally{
   if(ownedCopyFile&&ctx.faultRestorations.has(ownedCopyFile)){await writeFile(ownedCopyFile,ownedCopyBytes);ctx.faultRestorations.delete(ownedCopyFile);}
   if(driftedFile&&ctx.faultRestorations.has(driftedFile)){await writeFile(driftedFile,originalBytes);ctx.faultRestorations.delete(driftedFile);}
   const closed=await api.close();assert(closed.allOwnedResourcesRetired,'CORE_FAULT_FINALLY_OWNED_RESOURCES_NOT_RETIRED');ctx.capture();
  }
 }
 report.platformCoreFaults.completed=true;await privateNewFile(join(work,'platform-core-faults.json'),canonical(report.platformCoreFaults));return ctx;
}
