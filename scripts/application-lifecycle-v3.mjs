import {fork} from 'node:child_process';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {backupDirectory} from './field-backup-io.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {readApplicationFileV1,assertApplicationPinsV1,applicationHashV1 as hash,applicationOutsideV1} from './runtime-application-config-v1.mjs';
import {applicationManifestV2,inspectApplicationFieldSlotV2} from './runtime-application-config-v2.mjs';
import {fieldSiteChildRetirementV1} from './runtime-field-site-retirement-v1.mjs';
import {readApplicationRegistryV2} from './runtime-application-registry-v2.mjs';
import {observeOwnedForkTerminalV1} from './owned-fork-terminal-v1.mjs';

const owned=new WeakMap(),need=(v,c)=>{if(!v)throw Error(c);};
const entry=fileURLToPath(new URL('./runtime-application-suite-v3.mjs',import.meta.url));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const sourceNames=['runtime-application-suite-v3.mjs','runtime-application-manager-v3.mjs','runtime-application-child-v2.mjs','runtime-application-config-v1.mjs','runtime-application-registry-v2.mjs','runtime-application-config-v2.mjs','runtime-field-site-child-v1.mjs','runtime-field-site-retirement-v1.mjs','field-map-site-runtime-v1.mjs','field-map-authority-gateway-v1.mjs','field-map-authority-host-v1.mjs','owned-fork-terminal-v1.mjs','application-lifecycle-v3.mjs'];
async function registry(s){
 const t=JSON.parse((await readApplicationFileV1(join(s.registryDirectory,'trust.json'))).bytes.toString('utf8'));
 const r=await readApplicationRegistryV2(t);need(r.header.ownerPid===s.child.pid&&canonical(r.header.manifest)===canonical(s.manifest),'APPLICATION_LIFECYCLE_REGISTRY_BINDING');return r;
}
function live(s){need(s.child.pid>0&&s.child.exitCode===null&&s.child.signalCode===null&&!s.exit,'APPLICATION_LIFECYCLE_NOT_RUNNING');}
async function terminalProof(s,exit){
 await assertApplicationPinsV1(s.pins);let r=null;
 try{r=await registry(s);}catch(error){if(error.code!=='ENOENT')throw Error('APPLICATION_LIFECYCLE_REGISTRY_UNPROVEN');}
 let membersCreated=0,membersNormalExit=0,membersTerminal=0,full=false,cancelled=false;
 let siteResourcesRetired=false;
 if(r){
  const site=s.manifest.components.find(c=>c.kind==='SITE'),launch=r.events.find(e=>e.event==='LAUNCH_INTENT'&&e.componentId===site.id);
  siteResourcesRetired=!launch;
  if(launch){
   const retired=r.events.find(e=>e.event==='RETIRED'&&e.componentId===site.id),exited=r.events.find(e=>e.event==='EXIT'&&e.componentId===site.id),intent=r.events.find(e=>e.event==='STOP_INTENT'&&e.componentId===site.id);
   if(retired&&exited){
    const e=JSON.parse((await readApplicationFileV1(join(s.registryDirectory,site.id+'-launch.private.json'))).bytes.toString('utf8')),result=JSON.parse((await readApplicationFileV1(join(s.registryDirectory,site.id+'-result.private.json'))).bytes.toString('utf8'));
    need(e.ownerId===r.header.ownerId&&e.parentPid===s.child.pid&&e.component.id===site.id&&e.configSha256===launch.configSha256&&hash(e.challenge)===launch.challengeSha256&&e.manifestSha256===hash(canonical(s.manifest)),'APPLICATION_LIFECYCLE_FIELD_ENVELOPE');
    const proof=fieldSiteChildRetirementV1(result,{ownerId:r.header.ownerId,componentId:site.id,pid:exited.pid,parentPid:s.child.pid,configSha256:launch.configSha256,manifestSha256:hash(canonical(s.manifest)),challenge:e.challenge,enabled:s.manifest.field.enabled,requestId:intent?.requestId??null});
    need(canonical(proof)===canonical(retired.proof),'APPLICATION_LIFECYCLE_FIELD_PROOF');siteResourcesRetired=true;
   }
  }
  const launched=r.events.filter(e=>e.event==='LAUNCH_INTENT'),exits=r.events.filter(e=>e.event==='EXIT');membersCreated=launched.length;
  for(const launch of launched){const e=exits.find(e=>e.componentId===launch.componentId),closed=r.events.find(e=>e.event==='CLOSED'&&e.componentId===launch.componentId),intent=r.events.find(e=>e.event==='STOP_INTENT'&&e.componentId===launch.componentId);if(e&&(Number.isInteger(e.code)||typeof e.signal==='string'))membersTerminal++;if(e?.code===0&&e.signal===null&&closed&&intent&&closed.requestId===intent.requestId)membersNormalExit++;}
  const all=siteResourcesRetired&&membersNormalExit===membersCreated&&exits.length===membersCreated&&r.lifecycle.terminal;
  full=all&&r.events.at(-1)?.event==='GROUP_CLOSED'&&s.closedMessage?.normal===true&&s.closedMessage.requestId===s.requestId;
  cancelled=all&&r.events.at(-1)?.event==='FAILED'&&r.events.at(-1)?.errorCode==='APPLICATION_SUITE_START_CANCELLED'&&s.cancelMessage?.requestId===s.requestId&&s.cancelMessage.allOwnedChildrenTerminal===true&&s.cancelMessage.allOwnedResourcesRetired===true&&s.cancelMessage.components===membersCreated;
 }else cancelled=s.cancelMessage?.requestId===s.requestId&&s.cancelMessage.allOwnedChildrenTerminal===true&&s.cancelMessage.allOwnedResourcesRetired===true&&s.cancelMessage.components===0;
 const actualNormal=exit.code===0&&exit.signal===null&&!s.logFailed;
 return{format:'IDMS_APPLICATION_GROUP_TERMINAL_V2',owner:s.owner,pid:s.child.pid,exit,registryChecked:!!r,membersCreated,membersTerminal,membersNormalExit,normalFullGroup:actualNormal&&full,startupCancelled:actualNormal&&cancelled,allOwnedTerminalProven:!!r&&r.lifecycle.terminal&&membersTerminal===membersCreated||actualNormal&&cancelled,allOwnedResourcesRetired:siteResourcesRetired&&!!r&&r.lifecycle.terminal&&membersTerminal===membersCreated||actualNormal&&cancelled,genericKillUsed:false};
}

/** Return the actual fork handle before the application manager becomes READY. */
export async function launchApplicationLifecycleV3(options){
 need(options&&Object.keys(options).sort().join(',')==='manifestFile,workDirectory'&&typeof options.manifestFile==='string'&&typeof options.workDirectory==='string','APPLICATION_LIFECYCLE_INPUT');
 let file,manifest;try{file=await readApplicationFileV1(options.manifestFile);}catch{throw Error('APPLICATION_LIFECYCLE_MANIFEST_READ');}
 try{manifest=applicationManifestV2(JSON.parse(file.bytes.toString('utf8').replace(/^\uFEFF/,'')));}catch(error){throw Error(/^APPLICATION_[A-Z_]+$/.test(error.message)?error.message:'APPLICATION_LIFECYCLE_MANIFEST_INVALID');}
 const fieldSlot=await inspectApplicationFieldSlotV2(file.path,manifest);
 const parent=await backupDirectory(options.workDirectory),registryDirectory=resolve(dirname(file.path),manifest.registryDirectory);
 need(applicationOutsideV1(parent,registryDirectory)&&applicationOutsideV1(registryDirectory,parent),'APPLICATION_LIFECYCLE_RECORD_OVERLAP');
 const pins=[{path:file.path,sha256:file.sha256},fieldSlot.pin];for(const name of sourceNames){const p=await readApplicationFileV1(fileURLToPath(new URL('./'+name,import.meta.url)));pins.push({path:p.path,sha256:p.sha256});}
 const owner=randomUUID(),directory=join(parent,'application-process-'+owner);await mkdir(directory,{mode:0o700});await privateDirectory(directory);
 await privateNewFile(join(directory,'launch-intent.json'),canonical({format:'IDMS_APPLICATION_GROUP_LAUNCH_V2',owner,manifestSha256:hash(canonical(manifest)),pins,entry,registryDirectory}));
 const logFile=join(directory,'process.private.log');await privateNewFile(logFile,'');const fd=openSync(logFile,'a');
 await assertApplicationPinsV1(pins);
 const child=fork(entry,[file.path],{execArgv:[],windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe','ipc']});
 const s={owner,directory,child,manifest,registryDirectory,pins,requestId:null,stopPromise:null,stopAccepted:false,exit:null,closedMessage:null,cancelMessage:null,logFailed:false,logBytes:0,ready:false};
 let readyOk,readyNo;const ready=new Promise((ok,no)=>{readyOk=ok;readyNo=no;});ready.catch(()=>{});s.readyPromise=ready;
 child.on('message',m=>{
  if(m?.event==='APPLICATION_SUITE_READY')void(async()=>{live(s);need(!s.ready&&!s.requestId&&m.pid===child.pid&&uuid(m.ownerId)&&m.components===manifest.components.length&&m.manifestSha256===hash(canonical(manifest)),'APPLICATION_LIFECYCLE_READY_BINDING');const r=await registry(s);need(r.header.ownerId===m.ownerId&&r.lifecycle.groupReady&&!r.lifecycle.stopping,'APPLICATION_LIFECYCLE_NOT_READY');await assertApplicationPinsV1(pins);live(s);need(!s.requestId,'APPLICATION_LIFECYCLE_STOPPING');s.ready=true;readyOk({owner,pid:child.pid,registryOwnerId:m.ownerId,components:m.components});})().catch(()=>readyNo(Error('APPLICATION_LIFECYCLE_READY_UNPROVEN')));
  else if(m?.event==='APPLICATION_SUITE_CLOSED')s.closedMessage=m;
  else if(m?.event==='APPLICATION_SUITE_START_CANCELLED')s.cancelMessage=m;
 });
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{s.logBytes+=b.length;if(s.logBytes>1024**2){s.logFailed=true;return;}try{writeSync(fd,b);}catch{s.logFailed=true;}});
 const terminal=observeOwnedForkTerminalV1(child).then(async exit=>{
  s.exit=exit;try{fsyncSync(fd);closeSync(fd);}catch{s.logFailed=true;}
  readyNo(Error('APPLICATION_LIFECYCLE_EXIT_BEFORE_READY'));
  const observation={format:'IDMS_APPLICATION_GROUP_EXIT_V1',owner,pid:child.pid,...exit,observedAt:new Date().toISOString()};await privateNewFile(join(directory,'exit-observation.json'),canonical(observation));
  let proof;try{proof=await terminalProof(s,exit);}catch{proof={format:'IDMS_APPLICATION_GROUP_TERMINAL_V2',owner,pid:child.pid,exit,allOwnedTerminalProven:false,errorCode:'APPLICATION_LIFECYCLE_TERMINAL_UNPROVEN'};}
  await privateNewFile(join(directory,'terminal-proof.json'),canonical(proof));s.originalProof=proof;return proof;
 },async()=>{try{closeSync(fd);}catch{}readyNo(Error('APPLICATION_LIFECYCLE_SPAWN_FAILED'));throw Error('APPLICATION_LIFECYCLE_SPAWN_FAILED');});terminal.catch(()=>{});s.terminal=terminal;
 const handle=Object.freeze({process:child,directory,terminal,get ready(){return s.ready;},get retirementProof(){return s.reinspectionProof??s.originalProof??null;}});owned.set(handle,s);return handle;
}

export async function bindApplicationLifecycleV3(handle){const s=owned.get(handle);need(s&&!s.requestId,'APPLICATION_LIFECYCLE_HANDLE');live(s);return s.readyPromise;}

/** Repeated calls use one correlated IPC request and its actual terminal proof. */
export function stopApplicationLifecycleV3(handle,{requestId}={}){
 const s=owned.get(handle);need(s,'APPLICATION_LIFECYCLE_HANDLE');need(requestId===undefined||uuid(requestId),'APPLICATION_LIFECYCLE_REQUEST_ID');
 if(s.stopPromise){need(!requestId||requestId===s.requestId,'APPLICATION_LIFECYCLE_REQUEST_CHANGED');return s.stopPromise;}
 live(s);s.requestId=requestId??randomUUID();
 const attempt=(async()=>{await assertApplicationPinsV1(s.pins);await privateNewFile(join(s.directory,'stop-intent.json'),canonical({owner:s.owner,pid:s.child.pid,requestId:s.requestId}));s.stopAccepted=true;
  const deliver=()=>{if(!s.child.connected||s.exit)return;try{s.child.send({type:'APPLICATION_SUITE_STOP',requestId:s.requestId},()=>{});}catch{}};
  deliver();const timer=setInterval(deliver,250);let proof;try{proof=await s.terminal;}finally{clearInterval(timer);}
  need(proof.allOwnedTerminalProven&&proof.allOwnedResourcesRetired&&(proof.normalFullGroup||proof.startupCancelled),'APPLICATION_LIFECYCLE_STOP_UNPROVEN');await privateNewFile(join(s.directory,'normal-stop-proof.json'),canonical(proof));return proof;
 })();s.stopPromise=attempt;attempt.catch(()=>{if(!s.stopAccepted&&s.stopPromise===attempt){s.stopPromise=null;s.requestId=null;}});return attempt;
}

/** Recheck only a retained fork whose actual close has already been observed. */
export async function inspectApplicationRetirementV3(handle){
 const s=owned.get(handle);need(s,'APPLICATION_LIFECYCLE_HANDLE');
 need(s.exit&&s.child.exitCode!==null||s?.exit&&s.child.signalCode!==null,'APPLICATION_LIFECYCLE_NOT_TERMINAL');
 const original=await s.terminal;await assertApplicationPinsV1(s.pins);
 if(original.allOwnedTerminalProven&&original.allOwnedResourcesRetired)return original;
 if(s.reinspectionProof)return s.reinspectionProof;
 const proof=await terminalProof(s,s.exit);need(proof.allOwnedTerminalProven&&proof.allOwnedResourcesRetired,'APPLICATION_LIFECYCLE_TERMINAL_UNPROVEN');
 await privateNewFile(join(s.directory,'retirement-reinspection.private.json'),canonical({format:'IDMS_APPLICATION_RETIREMENT_REINSPECTION_V1',owner:s.owner,pid:s.child.pid,observedExit:s.exit,originalProofSha256:hash(canonical(original)),proof}));
 s.reinspectionProof=proof;return proof;
}
