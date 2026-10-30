import {mqttBrokerLinuxControlV1} from './mqtt-broker-linux-control-v1.mjs';
import {mqttBrokerWindowsHostV1,assertMqttBrokerWindowsHostV1} from './mqtt-broker-windows-host-v1.mjs';
import {spawn} from 'node:child_process';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {readFile,readlink,readdir} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,X509Certificate} from 'node:crypto';
import {checkServerIdentity} from 'node:tls';
import mqtt from 'mqtt';
import {backupDirectory} from './field-backup-io.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {mqttBrokerNeedV1 as need,mqttBrokerHashV1 as hash,inspectMqttBrokerRuntimeV1,readMqttBrokerFileV1,assertMqttBrokerPinsV1,mqttBrokerFilesV1} from './mqtt-broker-runtime-v1.mjs';

const owned=new WeakMap(),root=fileURLToPath(new URL('../',import.meta.url)),controlFile=fileURLToPath(new URL('./mqtt-broker-windows-control-v1.ps1',import.meta.url));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const alive=s=>need(s&&s.child.pid>0&&s.child.exitCode===null&&s.child.signalCode===null&&!s.exit,'MQTT_BROKER_NOT_RUNNING');
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
const sourceNames=['mqtt-broker-runtime-v1.mjs','mqtt-broker-lifecycle-v5.mjs','mqtt-broker-windows-control-v1.ps1','mqtt-broker-windows-host-v1.mjs'];
export async function mqttBrokerSourcePinsV5(){
  const pins=new Map();let total=0;
  async function visit(file){
    const name=resolve(file);if(pins.has(name))return;const rel=relative(root,name);need(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'MQTT_BROKER_SOURCE_PATH');
    const entry=await readMqttBrokerFileV1(name);total+=entry.bytes.length;need(pins.size<512&&total<=32*1024**2,'MQTT_BROKER_SOURCE_LIMIT');pins.set(name,{path:name,sha256:entry.sha256});
    if(/\.(?:mjs|ts)$/.test(name))for(const match of entry.bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g))await visit(resolve(dirname(name),match[1]));
  }
  for(const name of sourceNames)await visit(fileURLToPath(new URL('./'+name,import.meta.url)));
  for(const name of ['package.json','package-lock.json']){const item=await readMqttBrokerFileV1(resolve(root,name));pins.set(item.path,{path:item.path,sha256:item.sha256});}
  return [...pins.values()];
}

async function windowsControl(s,action){
  await assertMqttBrokerWindowsHostV1(s.controlHost);
  const requestFile=join(s.directory,'control-'+randomUUID()+'.request.private.json'),resultFile=requestFile.replace('.request.private.json','.result.private.json');
  const request={format:'IDMS_MQTT_BROKER_WIN_CONTROL_V1',action,owner:s.owner,challenge:s.challenge,parentPid:process.pid,pid:s.child.pid,expectedCreatedFileTime:s.identity?.createdFileTime??null,program:s.inspected.program,configFile:s.configFile,configSha256:s.configSha256,port:s.inspected.config.port,resultFile};
  await privateNewFile(requestFile,JSON.stringify(request));alive(s);
  const helper=spawn(s.powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',controlFile,requestFile],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  helper.stdout.resume();helper.stderr.resume();
  const exit=await new Promise((ok,no)=>{helper.once('error',()=>no(Error('MQTT_BROKER_CONTROL_START_FAILED')));helper.once('close',(code,signal)=>ok({code,signal}));});
  let result;try{result=JSON.parse((await readMqttBrokerFileV1(resultFile,65536)).bytes.toString('utf8'));}catch{throw Error('MQTT_BROKER_CONTROL_RESULT_UNPROVEN');}
  need(result.format==='IDMS_MQTT_BROKER_WIN_CONTROL_RESULT_V1'&&result.owner===s.owner&&result.challengeSha256===hash(s.challenge)&&result.parentPid===process.pid&&result.pid===s.child.pid&&result.helperPid===helper.pid&&result.action===action,'MQTT_BROKER_CONTROL_BINDING');
  need(exit.signal===null&&exit.code===(result.errorCode?1:0),'MQTT_BROKER_CONTROL_EXIT');
  return {...result,helperExit:exit};
}

async function linuxIdentity(s){
  alive(s);const text=await readFile('/proc/'+s.child.pid+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
  need(Number(fields[1])===process.pid&&/^[0-9]+$/.test(fields[19]),'MQTT_BROKER_PROCESS_BINDING');
  need(await readlink('/proc/'+s.child.pid+'/exe')===s.inspected.program,'MQTT_BROKER_PROGRAM_BINDING');
  const command=(await readFile('/proc/'+s.child.pid+'/cmdline','utf8')).split('\0');if(command.at(-1)==='')command.pop();
  need(command.length===3&&command[0]===s.inspected.program&&command[1]==='-c'&&command[2]===s.configFile,'MQTT_BROKER_COMMAND_BINDING');
  const sockets=new Set();for(const name of await readdir('/proc/'+s.child.pid+'/fd'))try{const link=await readlink('/proc/'+s.child.pid+'/fd/'+name),match=/^socket:\[([0-9]+)\]$/.exec(link);if(match)sockets.add(match[1]);}catch(error){if(error.code!=='ENOENT')throw error;}
  const local='0100007F:'+s.inspected.config.port.toString(16).toUpperCase().padStart(4,'0');
  const ownListener=(await readFile('/proc/'+s.child.pid+'/net/tcp','utf8')).trim().split('\n').slice(1).some(row=>{const parts=row.trim().split(/\s+/);return parts[1]===local&&parts[3]==='0A'&&sockets.has(parts[9]);});
  const control=mqttBrokerLinuxControlV1(await readFile('/proc/'+s.child.pid+'/status','utf8'));
  alive(s);return {createdFileTime:null,startTicks:fields[19],ownListener,eventAvailable:control.ready,sigintCaught:control.sigintCaught,sigtermCaught:control.sigtermCaught,commandLineBound:true};
}

async function inspectNative(s){
  const value=process.platform==='win32'?await windowsControl(s,'INSPECT'):await linuxIdentity(s);alive(s);
  need(!value.errorCode&&value.commandLineBound,'MQTT_BROKER_NATIVE_BINDING');
  if(s.identity)need(process.platform==='win32'?value.createdFileTime===s.identity.createdFileTime:value.startTicks===s.identity.startTicks,'MQTT_BROKER_PROCESS_CHANGED');
  else s.identity={createdFileTime:value.createdFileTime,startTicks:value.startTicks??null};
  return value;
}

async function probe(s){
  const m=s.inspected.materials,payload=randomBytes(32),topic=s.probeTopic;
  const client=mqtt.connect('mqtts://127.0.0.1:'+s.inspected.config.port,{clientId:s.inspected.config.probe.clientId,protocolVersion:5,clean:true,reconnectPeriod:0,resubscribe:false,connectTimeout:3000,queueQoSZero:false,rejectUnauthorized:true,minVersion:'TLSv1.2',servername:'localhost',ca:m.ca,cert:m.probe,key:m.probeKey,checkServerIdentity:(_host,certificate)=>{
    const error=checkServerIdentity('127.0.0.1',certificate);if(error)return error;
    return hash(new X509Certificate(certificate.raw).raw)===s.inspected.materialBinding.serverCertificateSha256?undefined:Error('MQTT_BROKER_PEER_CHANGED');
  },properties:{maximumPacketSize:32768,receiveMaximum:1,sessionExpiryInterval:0}});
  const closed=new Promise(ok=>client.once('close',ok));let timer,finished=false,ack=false,echo=false,subscribed=false;
  try{
    await new Promise((ok,no)=>{
      const fail=()=>no(Error('MQTT_BROKER_PROBE_FAILED')),complete=()=>{if(ack&&echo){finished=true;ok();}};
      client.on('error',fail);client.once('close',()=>{if(!finished)fail();});timer=setTimeout(fail,5000);
      client.on('message',(actual,bytes,packet)=>{if(actual!==topic||!bytes.equals(payload)||packet.qos!==1||packet.retain){fail();return;}echo=true;complete();});
      client.once('connect',()=>client.subscribe(topic,{qos:1},(error,grants)=>{
        if(error||grants?.length!==1||grants[0].topic!==topic||grants[0].qos!==1){fail();return;}subscribed=true;
        client.publish(topic,payload,{qos:1,retain:false},publishError=>{if(publishError){fail();return;}ack=true;complete();});
      }));
    });
    clearTimeout(timer);client.end(false);await closed;alive(s);return {subscribed,pubackReceived:ack,echoReceived:echo,clientClosed:true,payloadSha256:hash(payload)};
  }finally{clearTimeout(timer);if(!finished){client.end(true);client.stream?.destroy();await closed;}}
}

/** Creates a real Mosquitto instance from fixed generated config; never adopts a supplied PID. */
export async function launchMqttBrokerLifecycleV5(options){
  need(exact(options,['runtimeFile','workDirectory'])&&typeof options.runtimeFile==='string'&&typeof options.workDirectory==='string','MQTT_BROKER_LIFECYCLE_INPUT');
  need(['win32','linux'].includes(process.platform),'MQTT_BROKER_PLATFORM');
  const inspected=await inspectMqttBrokerRuntimeV1(options.runtimeFile),parent=await backupDirectory(options.workDirectory),sourcePins=await mqttBrokerSourcePinsV5(),owner=randomUUID(),challenge=randomBytes(32).toString('hex'),requestedDirectory=join(parent,'mqtt-broker-process-'+owner);let directory=requestedDirectory;
  // Keep original creator-only native control and fixed broker/config binding.
  // Windows private ACL tooling and .NET control requests need a bounded path.
  const controlName='control-00000000-0000-0000-0000-000000000000.request.private.json';
  if(process.platform==='win32'&&join(directory,controlName).length>240){const compact=join(root,'work','mqtt-broker-compact-v1');await privateDirectory(compact);directory=join(compact,'mqtt-broker-process-'+owner);}
  need(process.platform!=='win32'||join(directory,controlName).length<=240,'MQTT_BROKER_CONTROL_PATH_LIMIT');await privateDirectory(directory);

  const configFile=join(directory,'mosquitto.conf'),aclFile=join(directory,'mqtt-acl'),generated=mqttBrokerFilesV1(inspected.config,{owner,aclFile});
  await privateNewFile(configFile,generated.configuration);await privateNewFile(aclFile,generated.acl);
  const pins=[...inspected.pins,...sourcePins,{path:configFile,sha256:hash(generated.configuration)},{path:aclFile,sha256:hash(generated.acl)}];
  const controlHost=process.platform==='win32'?await mqttBrokerWindowsHostV1():null,powershell=controlHost?.path??null;
  await privateNewFile(join(directory,'launch-intent.private.json'),JSON.stringify({format:'IDMS_MQTT_BROKER_LAUNCH_V1',owner,parentPid:process.pid,challenge,runtime:inspected.runtime,program:inspected.program,pins,controlHost,port:inspected.config.port,normalStop:process.platform==='win32'?'BOUND_NAMED_EVENT':'OWNED_CHILD_SIGINT'}));
  await assertMqttBrokerPinsV1(pins);const log=join(directory,'process.private.log');await privateNewFile(log,'');const fd=openSync(log,'a');
  const env=process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,PATH:inspected.config.toolingDirectory+';'+join(process.env.SystemRoot,'System32')}:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'};
  const child=spawn(inspected.program,['-c',configFile],{cwd:inspected.config.toolingDirectory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const s={owner,challenge,directory,child,inspected,pins,powershell,controlHost,configFile,configSha256:hash(generated.configuration),probeTopic:generated.probeTopic,identity:null,bound:false,binding:null,exit:null,stopPromise:null,requestId:null,stopAccepted:false,stopProof:null,helperAttempts:0,logFailed:false,logBytes:0};
  for(const stream of [child.stdout,child.stderr])stream.on('data',part=>{s.logBytes+=part.length;if(s.logBytes>1024**2){s.logFailed=true;return;}try{writeSync(fd,part);}catch{s.logFailed=true;}});
  const terminal=new Promise(ok=>{
    let settled=false;const finish=(code,signal,spawnFailed)=>{if(settled)return;settled=true;s.exit={code,signal,spawnFailed};try{fsyncSync(fd);closeSync(fd);}catch{s.logFailed=true;}
      void privateNewFile(join(directory,'exit-observation.json'),JSON.stringify({format:'IDMS_MQTT_BROKER_EXIT_V1',owner,pid:child.pid??null,parentPid:process.pid,...s.exit,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed})).then(()=>ok({...s.exit,proofSaved:true,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed}),()=>ok({...s.exit,proofSaved:false,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed}));};
    child.once('error',()=>finish(null,null,true));child.once('close',(code,signal)=>finish(code,signal,false));
  });s.terminal=terminal;
  s.createdRecord=privateNewFile(join(directory,'created.private.json'),JSON.stringify({owner,pid:child.pid??null,parentPid:process.pid,program:inspected.program,configurationSha256:s.configSha256}));s.createdRecord.catch(()=>{s.logFailed=true;});
  const handle=Object.freeze({process:child,directory,terminal,get bound(){return s.bound;},get binding(){return s.binding?structuredClone(s.binding):null;},get stopProof(){return s.stopProof?structuredClone(s.stopProof):null;}});owned.set(handle,s);return handle;
}

export async function bindMqttBrokerLifecycleV5(handle){
  const s=owned.get(handle);need(s&&!s.requestId,'MQTT_BROKER_LIFECYCLE_HANDLE');alive(s);await s.createdRecord;await assertMqttBrokerPinsV1(s.pins);const deadline=Date.now()+30000;
  for(;;){const native=await inspectNative(s);if(native.ownListener&&native.eventAvailable)break;need(Date.now()<deadline,'MQTT_BROKER_READY_TIMEOUT');await sleep(50);}
  const health=await probe(s);await assertMqttBrokerPinsV1(s.pins);const native=await inspectNative(s);need(native.ownListener&&native.eventAvailable,'MQTT_BROKER_LISTENER_CHANGED');
  const binding={owner:s.owner,pid:s.child.pid,parentPid:process.pid,identity:s.identity,runtimeSha256:s.inspected.runtime.sha256,configurationSha256:s.configSha256,port:s.inspected.config.port,health};
  if(s.bound)need(JSON.stringify({...s.binding,health})===JSON.stringify(binding),'MQTT_BROKER_BINDING_CHANGED');
  else{await privateNewFile(join(s.directory,'bound.private.json'),JSON.stringify(binding));s.binding=binding;s.bound=true;}
  return structuredClone(binding);
}

export async function inspectMqttBrokerLifecycleV5(handle){const s=owned.get(handle);need(s&&!s.stopAccepted,'MQTT_BROKER_LIFECYCLE_HANDLE');await assertMqttBrokerPinsV1(s.pins);const native=await inspectNative(s);return {owner:s.owner,pid:s.child.pid,bound:s.bound,identity:{...s.identity},ownListener:native.ownListener,eventAvailable:native.eventAvailable,requestId:s.requestId,stopAccepted:s.stopAccepted};}

export function stopMqttBrokerLifecycleV5(handle,options={}){
  const s=owned.get(handle);need(s,'MQTT_BROKER_LIFECYCLE_HANDLE');need(options&&typeof options==='object'&&!Array.isArray(options)&&Object.keys(options).every(key=>key==='requestId')&&(options.requestId===undefined||uuid(options.requestId)),'MQTT_BROKER_STOP_REQUEST');
  if(s.requestId)need(!options.requestId||s.requestId===options.requestId,'MQTT_BROKER_STOP_REQUEST_CHANGED');else s.requestId=options.requestId??randomUUID();
  if(s.stopPromise)return s.stopPromise;
  const attempt=(async()=>{
    await assertMqttBrokerPinsV1(s.pins);const deadline=Date.now()+30000;let native;
    for(;;){native=await inspectNative(s);if(native.ownListener&&native.eventAvailable)break;need(Date.now()<deadline,'MQTT_BROKER_CANCEL_BIND_TIMEOUT');await sleep(50);}
    await assertMqttBrokerPinsV1(s.pins);alive(s);await privateNewFile(join(s.directory,'stop-intent.json'),JSON.stringify({format:'IDMS_MQTT_BROKER_STOP_V1',owner:s.owner,pid:s.child.pid,identity:s.identity,requestId:s.requestId,startupCancelled:!s.bound}));
    s.stopAccepted=true;s.helperAttempts++;
    let control;
    if(process.platform==='win32')control=await windowsControl(s,'SHUTDOWN');
    else{alive(s);need(s.child.kill('SIGINT'),'MQTT_BROKER_SIGNAL_FAILED');control={delivered:true,completed:false,signal:'SIGINT'};}
    await privateNewFile(join(s.directory,'stop-control.private.json'),JSON.stringify({owner:s.owner,requestId:s.requestId,...control}));need(control.delivered&&!control.errorCode,'MQTT_BROKER_STOP_DELIVERY_UNPROVEN');
    const exit=await s.terminal;need(exit.code===0&&exit.signal===null&&!exit.spawnFailed&&exit.proofSaved&&exit.stdoutClosed&&exit.stderrClosed&&!s.logFailed,'MQTT_BROKER_STOP_UNPROVEN');
    if(process.platform==='win32')need(control.completed&&control.nativeExitCode===0,'MQTT_BROKER_NATIVE_EXIT_UNPROVEN');
    await assertMqttBrokerPinsV1(s.pins);
    const proof={format:'IDMS_MQTT_BROKER_NORMAL_STOP_V1',owner:s.owner,pid:s.child.pid,requestId:s.requestId,identity:s.identity,normalClose:true,startupCancelled:!s.bound,listenerWasStarted:true,actualOwnedProcessExit:exit,helperAttempts:s.helperAttempts,controlDelivered:true,windowsOriginalHandleWaitCompleted:process.platform==='win32'?control.completed:null,businessMessageDrainProven:false,linuxSigintHandlerObservedBeforeStop:process.platform==='linux'?native.sigintCaught:null,genericKillUsed:false};
    await privateNewFile(join(s.directory,'normal-stop-proof.json'),JSON.stringify(proof));s.stopProof=proof;s.inspected.materials.serverKey.fill(0);s.inspected.materials.probeKey.fill(0);return structuredClone(proof);
  })();s.stopPromise=attempt;attempt.catch(()=>{if(!s.stopAccepted&&s.stopPromise===attempt)s.stopPromise=null;});return attempt;
}
