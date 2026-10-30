import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {backupDirectory} from './field-backup-io.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {inspectPlatformDependencyFilesV1} from './platform-dependency-config-v1.mjs';
import {collectApplicationJsonGraphV1,readApplicationFileV1,applicationHashV1 as hash} from './runtime-application-config-v1.mjs';
import {launchPostgresLifecycleV1,bindPostgresLifecycleV1,stopPostgresLifecycleV1} from './postgres-lifecycle-v1.mjs';
import {buildIdentityLifecycleToolsV1} from './identity-lifecycle-portable-tools-v1.mjs';
import {launchIdentityLifecycleV1,bindIdentityLifecycleV1,stopIdentityLifecycleV1} from './identity-lifecycle-portable-v1.mjs';
import {buildWorkflowLifecycleToolsV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {launchWorkflowLifecycleV2,bindWorkflowLifecycleV2,stopWorkflowLifecycleV2} from './workflow-lifecycle-portable-v2.mjs';
import {launchApplicationLifecycleV2,bindApplicationLifecycleV2,stopApplicationLifecycleV2,inspectApplicationRetirementV2} from './application-lifecycle-v2.mjs';

const need=(v,c)=>{if(!v)throw Error(c);},code=e=>/^[A-Z][A-Z0-9_]{3,120}$/.test(e?.message??'')?e.message:'PLATFORM_DEPENDENCY_FAILURE';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,no)=>timer=setTimeout(()=>no(Error(label)),ms))]);}finally{clearTimeout(timer);}}

/** Core dependencies only. Callers keep this API before any service is created. */
export async function createPlatformDependenciesV5(input,{startupSignal}={}){
 need(startupSignal===undefined||startupSignal instanceof AbortSignal,'PLATFORM_DEPENDENCY_ABORT_SIGNAL');
 let inspected,graph;try{inspected=await inspectPlatformDependencyFilesV1(input);graph=await collectApplicationJsonGraphV1([inspected.config.applicationManifestFile]);}catch(error){throw Error(code(error));}
 const config=inspected.config,byPath=new Map([...inspected.pins,...graph].map(p=>[p.path,p]));
 need(![...config.postgres.map(p=>p.id),config.identity.id,...config.workflows.map(w=>w.id)].includes('applications'),'PLATFORM_DEPENDENCY_RESERVED_ID');
 for(const name of ['platform-dependency-controller-v5.mjs','platform-dependency-config-v1.mjs']){const item=await readApplicationFileV1(fileURLToPath(new URL('./'+name,import.meta.url)));byPath.set(item.path,{path:item.path,sha256:item.sha256});}
 const pins=[...byPath.values()];need(pins.length<=512,'PLATFORM_DEPENDENCY_PIN_LIMIT');
 const parent=await backupDirectory(config.workDirectory),owner=randomUUID(),directory=join(parent,'platform-'+owner);await mkdir(directory,{mode:0o700});await privateDirectory(directory);
 const entries=[];let sequence=0,journal=Promise.resolve(),journalFailed=false,phase='STARTING',failure=null,stopping=false,requestId=null,closePromise=null,fullyReady=false,lastResult=null,monitor;
 await privateNewFile(join(directory,'launch-intent.json'),canonical({format:'IDMS_PLATFORM_DEPENDENCY_LAUNCH_V1',owner,configurationSha256:hash(canonical(config)),pins,componentOrder:[...config.postgres.map(p=>({id:p.id,kind:'POSTGRES'})),{id:config.identity.id,kind:'IDENTITY'},...config.workflows.map(w=>({id:w.id,kind:'WORKFLOW'})),{id:'applications',kind:'APPLICATIONS'}]}));
 function record(event,details={}){const item={owner,sequence:++sequence,event,at:new Date().toISOString(),...details};journal=journal.then(()=>privateNewFile(join(directory,String(item.sequence).padStart(6,'0')+'.private.json'),canonical(item)));return journal;}
 async function shutdownRecord(event,details){try{await record(event,details);}catch{journalFailed=true;}}
 async function checkInputs(){for(const p of pins)need((await readApplicationFileV1(p.path)).sha256===p.sha256,'PLATFORM_DEPENDENCY_INPUT_CHANGED');}
 function checkCancel(){need(!stopping&&!startupSignal?.aborted,'PLATFORM_DEPENDENCY_START_CANCELLED');}
 let resolveClosed,ready;const closed=new Promise(ok=>resolveClosed=ok);
 const api={owner,directory,closed,get ready(){return ready;},status(){return{owner,phase,fullyReady,stopping,failure:failure?code(failure):null,lastResult,components:entries.map(e=>({id:e.id,kind:e.kind,pid:e.handle.process.pid??null,bound:e.bound,retiredProven:e.retiredProven,normal:e.normal,blocked:e.blocked??null}))};},resources(){return entries.map(e=>({id:e.id,kind:e.kind,handle:e.handle}));},close(options={}){
  need(options&&Object.keys(options).every(k=>k==='requestId')&&(options.requestId===undefined||uuid(options.requestId)),'PLATFORM_DEPENDENCY_STOP_REQUEST');
  if(requestId)need(!options.requestId||options.requestId===requestId,'PLATFORM_DEPENDENCY_STOP_REQUEST_CHANGED');else requestId=options.requestId??randomUUID();
  if(closePromise)return closePromise;stopping=true;clearInterval(monitor);phase='STOPPING';for(const e of entries)cancelApplicationStartup(e);
  const attempt=(async()=>{
   await ready.catch(()=>{});await shutdownRecord('STOP_INTENT',{requestId});
   for(const e of [...entries].reverse()){
    if(e.retiredProven)continue;
    try{
     let proof;
     if(e.kind==='APPLICATIONS'&&e.earlyStop){
      try{proof=await e.earlyStop;e.normal=proof.normalFullGroup||proof.startupCancelled;}
      catch(error){if(e.handle.process.exitCode===null&&e.handle.process.signalCode===null){e.earlyStop=null;throw error;}let terminal=await e.handle.terminal;if(!terminal.allOwnedTerminalProven)terminal=await inspectApplicationRetirementV2(e.handle);if(terminal.allOwnedTerminalProven&&!terminal.normalFullGroup&&!terminal.startupCancelled){proof=terminal;e.normal=false;failure??=Error('PLATFORM_APPLICATION_ABNORMAL_RETIREMENT');}else throw error;}
     }else if(e.handle.process.exitCode!==null||e.handle.process.signalCode!==null){
      const terminal=await e.handle.terminal;
      if(e.kind==='APPLICATIONS'){const checked=terminal.allOwnedTerminalProven?terminal:await inspectApplicationRetirementV2(e.handle);need(checked.allOwnedTerminalProven,'PLATFORM_APPLICATION_MEMBERS_UNPROVEN');proof=checked;e.normal=checked.normalFullGroup||checked.startupCancelled;if(!e.normal)failure??=Error('PLATFORM_APPLICATION_ABNORMAL_RETIREMENT');}
      else if(e.kind==='POSTGRES')throw Error('PLATFORM_POSTGRES_UNEXPECTED_TERMINAL');
      else{const file=await readApplicationFileV1(join(e.handle.directory,'exit-observation.json')),observed=JSON.parse(file.bytes.toString('utf8'));need(observed.pid===e.handle.process.pid&&observed.owner===e.handle.binding.owner&&observed.code===terminal.code&&observed.signal===terminal.signal,'PLATFORM_JVM_EXIT_UNPROVEN');proof={terminal,exitObservationSha256:file.sha256,normalStopProven:false};e.normal=false;failure??=Error('PLATFORM_JVM_UNEXPECTED_TERMINAL');}
     }else{
      if(!e.bound&&e.kind!=='APPLICATIONS'){if(e.kind==='IDENTITY')await bindIdentityLifecycleV1(e.handle);else if(e.kind==='WORKFLOW')await bindWorkflowLifecycleV2(e.handle);else await bindPostgresLifecycleV1(e.handle);e.bound=true;await shutdownRecord('COMPONENT_BOUND_FOR_STOP',{id:e.id,kind:e.kind,pid:e.handle.process.pid});}
      if(e.kind==='APPLICATIONS')proof=await stopApplicationLifecycleV2(e.handle,{requestId});
      else if(e.kind==='WORKFLOW')proof=await stopWorkflowLifecycleV2(e.handle);
      else if(e.kind==='IDENTITY')proof=await stopIdentityLifecycleV1(e.handle);
      else proof=await stopPostgresLifecycleV1(e.handle,{requestId});
      e.normal=true;
     }
     await privateNewFile(join(directory,e.id+'-retirement.private.json'),canonical(proof));e.retiredProven=true;e.blocked=null;await shutdownRecord('COMPONENT_RETIRED',{id:e.id,kind:e.kind,pid:e.handle.process.pid,normal:e.normal,proofSha256:hash(canonical(proof))});
    }catch(error){e.blocked=code(error);await shutdownRecord('STOP_BLOCKED',{id:e.id,errorCode:e.blocked});break;}
   }
   const allOwnedResourcesRetired=entries.every(e=>e.retiredProven),normal=allOwnedResourcesRetired&&entries.every(e=>e.normal)&&!journalFailed&&!failure;
   const outcomePhase=allOwnedResourcesRetired?(normal?'CLOSED':'FAILED'):'BLOCKED';lastResult={owner,requestId,phase:outcomePhase,fullyReady,startupCancelled:!fullyReady&&stopping&&!failure,normal,allOwnedResourcesRetired,componentsCreated:entries.length,blocked:entries.filter(e=>e.blocked).map(e=>({id:e.id,errorCode:e.blocked})),journalFailed};
   await shutdownRecord(outcomePhase,lastResult);lastResult.journalFailed=journalFailed;if(journalFailed){lastResult.normal=false;if(allOwnedResourcesRetired)lastResult.phase='FAILED';}
   // A visible BLOCKED state must already be retryable: its journal write has
   // completed and the prior attempt no longer occupies the single-flight slot.
   if(!allOwnedResourcesRetired)closePromise=null;phase=lastResult.phase;
   if(allOwnedResourcesRetired){startupSignal?.removeEventListener('abort',onAbort);resolveClosed(structuredClone(lastResult));}return structuredClone(lastResult);
  })();closePromise=attempt;attempt.then(result=>{if(!result.allOwnedResourcesRetired&&closePromise===attempt)closePromise=null;},()=>{if(closePromise===attempt)closePromise=null;});return attempt;
 }};
 function onAbort(){api.close().catch(()=>{});}startupSignal?.addEventListener('abort',onAbort,{once:true});
 function cancelApplicationStartup(e){if(e.kind!=='APPLICATIONS'||e.earlyStop||e.handle.process.exitCode!==null||e.handle.process.signalCode!==null)return;e.earlyStop=stopApplicationLifecycleV2(e.handle,{requestId});e.earlyStop.catch(()=>{});}
 function keep(id,kind,handle,settings){const e={id,kind,handle,settings,bound:false,retiredProven:false,normal:false};entries.push(e);if(stopping)cancelApplicationStartup(e);handle.terminal.then(()=>{if(!stopping){failure??=Error('PLATFORM_DEPENDENCY_UNEXPECTED_EXIT');api.close().catch(()=>{});}},()=>{if(!stopping){failure??=Error('PLATFORM_DEPENDENCY_PROCESS_UNPROVEN');api.close().catch(()=>{});}});return e;}
 async function waitFor(e,probe,label){const end=Date.now()+180000;for(;;){need(e.handle.process.exitCode===null&&e.handle.process.signalCode===null,'PLATFORM_DEPENDENCY_EXIT_BEFORE_READY');if(await probe())return;need(Date.now()<end,label);await sleep(250);}}
 async function bind(e){
  if(e.kind==='POSTGRES')await bindPostgresLifecycleV1(e.handle);
  else if(e.kind==='IDENTITY'){
   await waitFor(e,async()=>{try{const r=await fetch(e.handle.origin+'/realms/master/.well-known/openid-configuration',{redirect:'error',signal:AbortSignal.timeout(2000)});return r.ok&&(await r.json()).issuer===e.handle.origin+'/realms/master';}catch{return false;}},'PLATFORM_IDENTITY_READY_TIMEOUT');await bindIdentityLifecycleV1(e.handle);
  }else if(e.kind==='WORKFLOW'){
   const runtime=JSON.parse((await readApplicationFileV1(e.settings.runtimeFile)).bytes.toString('utf8'));
   await waitFor(e,async()=>{try{for(const[t,a]of Object.entries(runtime.tenants)){const r=await fetch('http://127.0.0.1:'+e.settings.port+'/v1/status',{headers:{Authorization:'Bearer '+a.serviceToken,'X-IDMS-Tenant':t},redirect:'error',signal:AbortSignal.timeout(2000)});if(!r.ok)return false;const v=await r.json();if(v.engine!=='Flowable'||v.version!=='7.2.0'||!v.definitionId)return false;}return true;}catch{return false;}},'PLATFORM_WORKFLOW_READY_TIMEOUT');await bindWorkflowLifecycleV2(e.handle);
  }else await bounded(bindApplicationLifecycleV2(e.handle),180000,'PLATFORM_APPLICATION_READY_OBSERVATION');
  e.bound=true;await record('COMPONENT_READY',{id:e.id,kind:e.kind,pid:e.handle.process.pid});
 }
 async function start(){
  for(const p of config.postgres){checkCancel();await checkInputs();const{id,...options}=p,e=keep(id,'POSTGRES',await launchPostgresLifecycleV1(options),p);await record('COMPONENT_CREATED',{id,kind:e.kind,pid:e.handle.process.pid});await bind(e);}
  checkCancel();await checkInputs();const i=config.identity,identityTools=await buildIdentityLifecycleToolsV1(i.workDirectory,{javaHome:i.javaHome});checkCancel();const ie=keep(i.id,'IDENTITY',await launchIdentityLifecycleV1({tools:identityTools,workDirectory:i.workDirectory,port:i.port,database:i.database,admin:i.admin,keycloakDirectory:i.keycloakDirectory}),i);await record('COMPONENT_CREATED',{id:ie.id,kind:ie.kind,pid:ie.handle.process.pid});await bind(ie);
  for(const w of config.workflows){checkCancel();await checkInputs();const tools=await buildWorkflowLifecycleToolsV1(w.workDirectory,{javaHome:w.javaHome});checkCancel();const e=keep(w.id,'WORKFLOW',await launchWorkflowLifecycleV2({tools,workDirectory:w.workDirectory,jarFile:w.jarFile,jarSha256:w.jarSha256,runtimeFile:w.runtimeFile,cancelFile:w.cancelFile??undefined,reservationFile:w.reservationFile??undefined,port:w.port}),w);await record('COMPONENT_CREATED',{id:e.id,kind:e.kind,pid:e.handle.process.pid});await bind(e);}
  // Keep application records beside controller records, avoiding an extra UUID directory in Windows ACL paths.
  checkCancel();await checkInputs();const app=keep('applications','APPLICATIONS',await launchApplicationLifecycleV2({manifestFile:config.applicationManifestFile,workDirectory:parent}),{});await record('COMPONENT_CREATED',{id:app.id,kind:app.kind,pid:app.handle.process.pid});await bind(app);checkCancel();await checkInputs();await record('PLATFORM_READY',{components:entries.length});checkCancel();fullyReady=true;phase='READY';let checking=false;monitor=setInterval(()=>{if(stopping||checking)return;checking=true;checkInputs().catch(error=>{if(!stopping){failure??=Error(code(error));api.close().catch(()=>{});}}).finally(()=>checking=false);},1000);return api.status();
 }
 ready=Promise.resolve().then(start).catch(error=>{const reason=stopping&&!fullyReady&&!failure?'PLATFORM_DEPENDENCY_START_CANCELLED':code(error);if(reason!=='PLATFORM_DEPENDENCY_START_CANCELLED')failure??=Error(reason);queueMicrotask(()=>api.close().catch(()=>{}));throw Error(reason);});ready.catch(()=>{});
 return Object.freeze(api);
}
