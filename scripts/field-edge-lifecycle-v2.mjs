import {fork} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,join,isAbsolute} from 'node:path';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory} from './field-backup-io.mjs';
import {loadActivationMaterialSet,readActivationMaterialFile} from './field-activation-material-files.mjs';
import {fieldEdgeMaterialMacV1} from './field-edge-material-binding-v1.mjs';
import {observeOwnedForkTerminalV1} from './owned-fork-terminal-v1.mjs';

const owned=new WeakMap(),entry=fileURLToPath(new URL('./field-edge-managed-entry-v2.mjs',import.meta.url));
const need=(v,c)=>{if(!v)throw Error(c);},hash=b=>createHash('sha256').update(b).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const live=s=>s.child.exitCode===null&&s.child.signalCode===null&&!s.exit;
const bound=(s,m)=>m?.owner===s.owner&&m.challenge===s.challenge&&m.pid===s.child.pid&&m.parentPid===process.pid;
function send(s,type,details={}){if(s.child.connected&&!s.exit){try{s.child.send({type,owner:s.owner,challenge:s.challenge,...details},()=>{});}catch{}}}
async function sourcePins(){
  const pins=new Map();let bytes=0;
  async function visit(path){
    path=resolve(path);if(pins.has(path))return;need(pins.size<512,'FIELD_EDGE_SOURCE_LIMIT');
    const data=await readActivationMaterialFile(path,2*1024**2);bytes+=data.length;need(bytes<=32*1024**2,'FIELD_EDGE_SOURCE_LIMIT');pins.set(path,{path,sha256:hash(data)});
    if(/\.(mjs|ts)$/.test(path))for(const m of data.toString('utf8').matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"\r\n]+)['"]/g))if(/\.(mjs|ts|sql)$/.test(m[1]))await visit(resolve(dirname(path),m[1]));
  }
  await visit(entry);await visit(fileURLToPath(import.meta.url));return [...pins.values()];
}
async function unchanged(pins){for(const p of pins)need(hash(await readActivationMaterialFile(p.path,2*1024**2))===p.sha256,'FIELD_EDGE_SOURCE_CHANGED');}
/** Material validation performs no network I/O. Return the real fork before START. */
export async function launchFieldEdgeLifecycleV2(options){
  need(options&&Object.keys(options).sort().join(',')==='configurationFile,edgeConfigurationFile,edgeId,registration,workDirectory','FIELD_EDGE_LIFECYCLE_INPUT');
  need([options.configurationFile,options.edgeConfigurationFile,options.workDirectory].every(p=>typeof p==='string'&&isAbsolute(p)),'FIELD_EDGE_LIFECYCLE_PATH');
  const materialKey=randomBytes(32);let loaded,materialMac,configurationSha256;
  try{
    loaded=await loadActivationMaterialSet(options.configurationFile,options.registration,materialKey);
    const c=loaded.channels.find(c=>c.edgeId===options.edgeId);need(c,'FIELD_EDGE_CHANNEL_REQUIRED');
    configurationSha256=c.edgeConfigurationSha256;
    need(hash(await readActivationMaterialFile(options.edgeConfigurationFile,262144))===configurationSha256,'FIELD_EDGE_CONFIGURATION_BINDING');
    materialMac=fieldEdgeMaterialMacV1(c.edge,materialKey);
  }catch(error){materialKey.fill(0);throw Error(/^FIELD_[A-Z0-9_]+$/.test(error?.code??error?.message)?(error.code??error.message):'FIELD_EDGE_MATERIAL_INVALID');}
  finally{loaded?.clear();}
  let fd,child;
  try{
    const parent=await backupDirectory(options.workDirectory),pins=await sourcePins(),owner=randomUUID(),challenge=randomBytes(32).toString('hex'),directory=join(parent,'field-edge-process-'+owner);
    await privateDirectory(directory);
    const envelope={format:'IDMS_FIELD_EDGE_LAUNCH_V2',owner,challenge,parentPid:process.pid,edgeConfigurationFile:resolve(options.edgeConfigurationFile),edgeConfigurationSha256:configurationSha256,materialMac,pins};
    const file=join(directory,'launch.private.json');await privateNewFile(file,JSON.stringify(envelope));
    await privateNewFile(join(directory,'process.private.log'),'');fd=openSync(join(directory,'process.private.log'),'a');
    child=fork(entry,[file],{execArgv:[],windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe','ipc']});
    let readyOk,readyNo;const ready=new Promise((ok,no)=>{readyOk=ok;readyNo=no;});ready.catch(()=>{});
    const s={child,owner,challenge,directory,pins,materialKey,materialMac,created:false,startRequested:false,started:false,readyObserved:false,stopPromise:null,requestId:null,exit:null,closed:null,ready,readyOk,readyNo,logFailed:false,logBytes:0,state:null,probes:new Map()};
    const deliver=()=>{
      if(s.requestId)send(s,'FIELD_EDGE_STOP_V1',{requestId:s.requestId});
      else if(s.startRequested&&s.created&&!s.started){s.started=true;send(s,'FIELD_EDGE_START_V1',{materialKey:s.materialKey.toString('hex')});s.materialKey.fill(0);}
    };s.deliver=deliver;
    child.on('message',m=>{
      if(!bound(s,m))return;
      if(m.event==='FIELD_EDGE_CREATED_V1'){s.created=true;deliver();}
      if(m.localState)s.state=Object.freeze(structuredClone(m.localState));
      if(m.event==='FIELD_EDGE_STATE_V1'&&m.localState?.ready===true&&!s.requestId&&!s.readyObserved){s.readyObserved=true;void unchanged(pins).then(()=>{need(live(s)&&!s.requestId,'FIELD_EDGE_STOPPING');if(s.state?.ready===true)readyOk({owner,pid:child.pid,materialMac,localState:s.state});else s.readyObserved=false;}).catch(()=>readyNo(Error('FIELD_EDGE_READY_UNPROVEN')));}
      if(m.event==='FIELD_EDGE_CLOSED_V1')s.closed=m;
      if(m.event==='FIELD_EDGE_PROBE_V1'&&s.probes.has(m.requestId)){s.probes.get(m.requestId).ok(s.state);s.probes.delete(m.requestId);}
    });
    for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{s.logBytes+=data.length;if(s.logBytes>1024**2){s.logFailed=true;return;}try{writeSync(fd,data);}catch{s.logFailed=true;}});
    const terminal=observeOwnedForkTerminalV1(child).then(async exit=>{
      s.exit=exit;materialKey.fill(0);try{fsyncSync(fd);closeSync(fd);}catch{s.logFailed=true;}
      readyNo(Error('FIELD_EDGE_EXIT_BEFORE_READY'));for(const p of s.probes.values())p.no(Error('FIELD_EDGE_EXIT_DURING_PROBE'));s.probes.clear();
      let pinsUnchanged=false;try{await unchanged(pins);pinsUnchanged=true;}catch{}
      const state=s.closed?.localState,localDrained=s.closed?.normal===true&&state?.closed===true&&state?.ready===false&&(!state.started||state.cleanupErrors===0&&['lockHeld','spoolOpen','readerActive','httpActive','mqttActive','leaseWatching','ackWaiterActive'].every(k=>state[k]===false));
      const normalStop=exit.code===0&&exit.signal===null&&uuid(s.requestId)&&s.closed?.requestId===s.requestId&&localDrained&&pinsUnchanged&&!s.logFailed;
      const proof={format:'IDMS_FIELD_EDGE_LOCAL_TERMINAL_V2',owner,pid:child.pid,requestId:s.requestId,exit,actualExitAndOutputAndIpcClosed:true,pinsUnchanged,normalStop,localDrained:!!localDrained,startupCancelled:s.closed?.startupCancelled===true,localState:state??null,businessIntakeDrainProven:false,fullPlatformIntegrated:false,genericKillUsed:false};
      await privateNewFile(join(directory,'terminal-proof.json'),JSON.stringify(proof));return proof;
    },error=>{materialKey.fill(0);try{closeSync(fd);}catch{}readyNo(Error('FIELD_EDGE_SPAWN_FAILED'));throw Error('FIELD_EDGE_SPAWN_FAILED');});terminal.catch(()=>{});s.terminal=terminal;
    const handle=Object.freeze({process:child,directory,terminal,get lastObservedState(){return s.state?structuredClone(s.state):null;}});owned.set(handle,s);return handle;
  }catch(error){materialKey.fill(0);if(!child&&fd!==undefined)closeSync(fd);throw error;}
}
export function bindFieldEdgeLifecycleV2(handle){
  const s=owned.get(handle);need(s&&live(s)&&!s.requestId,'FIELD_EDGE_HANDLE_NOT_RUNNING');s.startRequested=true;s.deliver();return s.ready;
}
export function probeFieldEdgeLifecycleV2(handle){
  const s=owned.get(handle);need(s&&live(s),'FIELD_EDGE_HANDLE_NOT_RUNNING');
  const requestId=randomUUID(),job=new Promise((ok,no)=>s.probes.set(requestId,{ok,no}));job.catch(()=>{});send(s,'FIELD_EDGE_PROBE_V1',{requestId});return job;
}
export function stopFieldEdgeLifecycleV2(handle,{requestId}={}){
  const s=owned.get(handle);need(s,'FIELD_EDGE_HANDLE_REQUIRED');need(requestId===undefined||uuid(requestId),'FIELD_EDGE_REQUEST_INVALID');
  if(s.stopPromise){need(!requestId||requestId===s.requestId,'FIELD_EDGE_STOP_REQUEST_CHANGED');return s.stopPromise;}
  need(live(s),'FIELD_EDGE_HANDLE_NOT_RUNNING');s.requestId=requestId??randomUUID();s.materialKey.fill(0);s.readyNo(Error('FIELD_EDGE_STOPPING'));
  const attempt=Promise.resolve().then(async()=>{
    let intent=true;try{await privateNewFile(join(s.directory,'stop-intent.json'),JSON.stringify({owner:s.owner,pid:s.child.pid,requestId:s.requestId}));}catch{intent=false;}
    s.deliver();const timer=setInterval(s.deliver,200);let proof;try{proof=await s.terminal;}finally{clearInterval(timer);}
    need(intent&&proof.normalStop,'FIELD_EDGE_STOP_UNPROVEN');return proof;
  });s.stopPromise=attempt;attempt.catch(()=>{});return attempt;
}
