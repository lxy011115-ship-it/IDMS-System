import {fork} from 'node:child_process';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupDirectory} from './field-backup-io.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {observeOwnedForkTerminalV1} from './owned-fork-terminal-v1.mjs';
import {readPredictorFileV1,predictorRuntimeV1,assertPredictorPinsV1,predictorSourcePinsV1,predictorNodeIdentityV1,predictorHashV1 as hash,predictorNeedV1 as need,predictorUuidV1 as uuid} from './predictor-runtime-v1.mjs';
const owned=new WeakMap(),entry=fileURLToPath(new URL('./predictor-managed-entry-v1.mjs',import.meta.url));
const live=s=>need(s?.child.pid>0&&s.child.exitCode===null&&s.child.signalCode===null&&!s.exit,'PREDICTOR_NOT_RUNNING');
const boundMessage=(s,m)=>m&&m.owner===s.owner&&m.pid===s.child.pid&&m.parentPid===process.pid&&m.challengeSha256===hash(s.challenge)&&m.envelopeSha256===s.envelopeSha&&m.runtimeSha256===s.runtime.sha256&&m.nodeSha256===s.node.sha256;
function deliver(s,type,details={}){if(!s.child.connected||s.exit)return;try{s.child.send({type,owner:s.owner,challenge:s.challenge,envelopeSha256:s.envelopeSha,...details},()=>{});}catch{}}
export async function launchPredictorLifecycleV1(options){
 need(options&&typeof options==='object'&&Object.keys(options).sort().join(',')==='runtimeFile,workDirectory'&&typeof options.runtimeFile==='string'&&typeof options.workDirectory==='string','PREDICTOR_LIFECYCLE_INPUT');
 let runtime,config;try{runtime=await readPredictorFileV1(options.runtimeFile,65536);config=predictorRuntimeV1(JSON.parse(runtime.bytes.toString('utf8')));}catch(error){throw Error(/^PREDICTOR_CONFIG_[A-Z_]+$/.test(error.message)?error.message:'PREDICTOR_RUNTIME_READ');}
 const parent=await backupDirectory(options.workDirectory),pins=await predictorSourcePinsV1(),node=await predictorNodeIdentityV1();pins.push({path:runtime.path,sha256:runtime.sha256});
 const owner=randomUUID(),challenge=randomBytes(32).toString('hex'),directory=join(parent,'predictor-process-'+owner);await privateDirectory(directory);
 const envelope={format:'IDMS_PREDICTOR_LAUNCH_V1',owner,parentPid:process.pid,challenge,directory,runtime:{path:runtime.path,sha256:runtime.sha256},pins,node};const envelopeFile=join(directory,'launch.private.json');await privateNewFile(envelopeFile,JSON.stringify(envelope));const envelopeSha=hash(JSON.stringify(envelope));
 const log=join(directory,'process.private.log');await privateNewFile(log,'');const fd=openSync(log,'a');let child;try{child=fork(entry,[envelopeFile],{execArgv:[],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});}catch{closeSync(fd);throw Error('PREDICTOR_SPAWN_FAILED');}
 let readyOk,readyNo;const ready=new Promise((ok,no)=>{readyOk=ok;readyNo=no;});ready.catch(()=>{});
 const s={owner,challenge,directory,child,runtime,config,pins,node,envelopeSha,envelopeFile,ready,readyOk,readyNo,created:false,startRequested:false,bound:false,requestId:null,stopPromise:null,stopAccepted:false,closedMessage:null,exit:null,logFailed:false,logBytes:0,activity:{started:0,finished:0,aborted:0,active:0}};
 const createdRecord=privateNewFile(join(directory,'created.private.json'),JSON.stringify({owner,pid:child.pid,parentPid:process.pid,envelopeSha256:envelopeSha}));createdRecord.catch(()=>{s.logFailed=true;readyNo(Error('PREDICTOR_CREATION_RECORD_UNPROVEN'));});s.createdRecord=createdRecord;
 for(const stream of[child.stdout,child.stderr])stream.on('data',part=>{s.logBytes+=part.length;if(s.logBytes>1024**2){s.logFailed=true;return;}try{writeSync(fd,part);}catch{s.logFailed=true;}});
 child.on('message',message=>{
  if(!boundMessage(s,message))return;
  if(message.event==='PREDICTOR_CREATED_V1'){s.created=true;if(s.stopIntent)deliver(s,'PREDICTOR_STOP_V1',{requestId:s.requestId});else if(s.startRequested&&!s.requestId)deliver(s,'PREDICTOR_START_V1');}
  else if(message.event==='PREDICTOR_READY_V1'&&!s.requestId){void(async()=>{await createdRecord;await assertPredictorPinsV1(pins);live(s);need(!s.requestId&&message.origin==='http://127.0.0.1:'+config.port,'PREDICTOR_READY_BINDING');readyOk(message);})().catch(()=>readyNo(Error('PREDICTOR_READY_UNPROVEN')));}
  else if(message.event==='PREDICTOR_STOP_ACCEPTED_V1'&&message.requestId===s.requestId)s.stopAccepted=true;
  else if(message.event==='PREDICTOR_ACTIVITY_V1'&&message.stats&&Object.values(message.stats).every(v=>Number.isInteger(v)&&v>=0))s.activity=message.stats;
  else if(message.event==='PREDICTOR_CLOSED_V1'&&message.requestId===s.requestId)s.closedMessage=message;
 });
 const terminal=observeOwnedForkTerminalV1(child).then(async exit=>{
  s.exit=exit;readyNo(Error('PREDICTOR_EXIT_BEFORE_READY'));try{fsyncSync(fd);closeSync(fd);}catch{s.logFailed=true;}
  await privateNewFile(join(directory,'exit-observation.json'),JSON.stringify({owner,pid:child.pid,...exit,observedAt:new Date().toISOString()}));
  let proof={format:'IDMS_PREDICTOR_TERMINAL_V1',owner,pid:child.pid,exit,normalClose:false,allOwnedTerminalProven:true,genericKillUsed:false};
  try{await createdRecord;await assertPredictorPinsV1(pins);const file=await readPredictorFileV1(join(directory,'child-terminal.private.json')),value=JSON.parse(file.bytes.toString('utf8'));need(boundMessage(s,value)&&value.requestId===s.requestId&&value.normalClose&&value.serverClosed&&s.stopAccepted&&boundMessage(s,s.closedMessage)&&s.closedMessage.requestId===s.requestId&&JSON.stringify(value)===JSON.stringify(Object.fromEntries(Object.entries(s.closedMessage).filter(([key])=>key!=='event')))&&value.stats.active===0&&value.stats.started===value.stats.finished+value.stats.aborted&&exit.code===0&&exit.signal===null&&!s.logFailed,'PREDICTOR_STOP_UNPROVEN');proof={...proof,normalClose:true,requestId:s.requestId,startupCancelled:!value.listenerStarted,listenerStarted:value.listenerStarted,readyBeforeStop:value.readyBeforeStop,serverClosed:true,stats:value.stats,childTerminalSha256:file.sha256,stopAccepted:true};}catch{proof.errorCode='PREDICTOR_TERMINAL_UNPROVEN';}
  await privateNewFile(join(directory,'terminal-proof.json'),JSON.stringify(proof));s.proof=proof;return proof;
 },async()=>{try{closeSync(fd);}catch{}readyNo(Error('PREDICTOR_SPAWN_FAILED'));throw Error('PREDICTOR_SPAWN_FAILED');});terminal.catch(()=>{});s.terminal=terminal;
 const handle=Object.freeze({process:child,directory,terminal,get bound(){return s.bound;},get stopProof(){return s.stopProof??null;}});owned.set(handle,s);return handle;
}
export async function bindPredictorLifecycleV1(handle){const s=owned.get(handle);need(s&&!s.requestId,'PREDICTOR_LIFECYCLE_HANDLE');live(s);s.startRequested=true;if(s.created)deliver(s,'PREDICTOR_START_V1');const ready=await s.ready;live(s);need(!s.requestId,'PREDICTOR_STOPPING');s.bound=true;return ready;}
export function inspectPredictorLifecycleV1(handle){const s=owned.get(handle);need(s,'PREDICTOR_LIFECYCLE_HANDLE');live(s);return{owner:s.owner,pid:s.child.pid,bound:s.bound,created:s.created,stopAccepted:s.stopAccepted,requestId:s.requestId,activity:{...s.activity}};}
export function stopPredictorLifecycleV1(handle,options={}){
 const s=owned.get(handle);need(s,'PREDICTOR_LIFECYCLE_HANDLE');need(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(key=>key==='requestId'),'PREDICTOR_STOP_REQUEST');const{requestId}=options;need(requestId===undefined||uuid(requestId),'PREDICTOR_STOP_REQUEST');if(s.requestId)need(!requestId||requestId===s.requestId,'PREDICTOR_STOP_REQUEST_CHANGED');if(s.stopPromise)return s.stopPromise;live(s);s.requestId??=requestId??randomUUID();
 const attempt=(async()=>{await assertPredictorPinsV1(s.pins);await privateNewFile(join(s.directory,'stop-intent.json'),JSON.stringify({owner:s.owner,pid:s.child.pid,requestId:s.requestId}));s.stopIntent=true;
  const send=()=>deliver(s,'PREDICTOR_STOP_V1',{requestId:s.requestId});send();const timer=setInterval(send,250);let proof;try{proof=await s.terminal;}finally{clearInterval(timer);}need(proof.normalClose&&proof.requestId===s.requestId,'PREDICTOR_STOP_UNPROVEN');await privateNewFile(join(s.directory,'normal-stop-proof.json'),JSON.stringify(proof));s.stopProof=proof;return proof;
 })();s.stopPromise=attempt;attempt.catch(()=>{if(!s.stopIntent&&s.stopPromise===attempt)s.stopPromise=null;});return attempt;
}
