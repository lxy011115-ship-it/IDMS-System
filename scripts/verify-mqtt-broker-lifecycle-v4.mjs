import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,basename,dirname} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer,createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import mqtt from 'mqtt';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {mqttBrokerMaterialsFixtureQaV1} from './fixtures/mqtt-broker-materials-v1-qa.mjs';
import {fieldMqttClientId,fieldMqttTopic} from '../integrations/field-profile.ts';
import {launchMqttBrokerLifecycleV3,bindMqttBrokerLifecycleV3,stopMqttBrokerLifecycleV3,inspectMqttBrokerLifecycleV3,mqttBrokerSourcePinsV3} from './mqtt-broker-lifecycle-v3.mjs';
import {mqttBrokerMaterialsV1} from './mqtt-broker-runtime-v1.mjs';

assert.equal(process.argv.length,2);
const root=resolve('.'),nonce=randomBytes(6).toString('hex'),work=resolve('work/mqtt-broker-lifecycle-v4-20261024',nonce),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const handles=[],clients=[],servers=[],restorations=new Map();let fixture,probeCertificate;
const report={format:'IDMS_MQTT_BROKER_NATIVE_QA_V4',nonce,startedAt:new Date().toISOString(),checks:[],processes:[],passed:false,cleanupComplete:false,originalDatabaseContacted:false,originalBrokerAdopted:false,businessMessageDrainProven:false};
const note=async name=>{report.checks.push(name);await writeFile(join(work,'current.private.json'),JSON.stringify(report));console.log(JSON.stringify({nonce,check:report.checks.length,name}));};
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,no)=>timer=setTimeout(()=>no(Error(label)),ms))]);}finally{clearTimeout(timer);}}
async function port(){const server=createServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});const result=server.address().port;await new Promise(ok=>server.close(ok));assert(![1883,1884,4010,4012,45432].includes(result));return result;}
async function create(label,selectedPort){
  const directory=join(work,label);await privateDirectory(directory);
  const config={format:1,purpose:'MQTT_BROKER_SERVICE_V1',toolingDirectory:await realpath(process.platform==='win32'?join(process.env.LOCALAPPDATA,'IDMS/runtime/mosquitto-2.1.2'):process.env.IDMS_QA_MOSQUITTO_BIN??'/usr/sbin'),host:'127.0.0.1',port:selectedPort??await port(),server:{caFile:join(fixture.directory,'ca.pem'),certificateFile:join(fixture.directory,'broker.pem'),keyFile:join(fixture.directory,'broker.key')},probe:{clientId:probeCertificate.clientId,certificateFile:join(fixture.directory,'health.pem'),keyFile:join(fixture.directory,'health.key')},channels:[{tenantId:'alpha',edgeId:'edge-'+nonce}]};
  const runtimeFile=join(directory,'runtime.private.json');await privateNewFile(runtimeFile,JSON.stringify(config));
  const handle=await launchMqttBrokerLifecycleV3({runtimeFile,workDirectory:directory}),item={label,handle,config,runtimeFile};handles.push(item);report.processes.push({label,pid:handle.process.pid,directory:handle.directory,runtimeFile,port:config.port});await writeFile(join(work,'current.private.json'),JSON.stringify(report));return item;
}
async function rawClient(item,role){
  const credentials=role==='probe'?{certificate:probeCertificate.certificate,privateKey:probeCertificate.privateKey}:role==='edge'?fixture.edge:fixture.platform;
  const client=mqtt.connect('mqtts://127.0.0.1:'+item.config.port,{clientId:role==='probe'?probeCertificate.clientId:fieldMqttClientId(item.config.channels[0],role==='edge'?'EDGE':'PLATFORM'),protocolVersion:5,clean:true,reconnectPeriod:0,connectTimeout:3000,rejectUnauthorized:true,minVersion:'TLSv1.2',servername:'localhost',ca:fixture.ca.certificate,cert:credentials.certificate,key:credentials.privateKey});
  const closed=new Promise(ok=>client.once('close',ok));const entry={client,closed};clients.push(entry);client.on('error',()=>{});
  await within(new Promise((ok,no)=>{client.once('connect',ok);client.once('error',()=>no(Error('MQTT_BROKER_QA_CONNECT_FAILED')));client.once('close',()=>no(Error('MQTT_BROKER_QA_CLOSED_BEFORE_CONNECT')));}),5000,'MQTT_BROKER_QA_CONNECT_TIMEOUT');return entry;
}
async function closeClient(entry){if(!entry.client.disconnecting)entry.client.end(false);await entry.closed;}
async function subscribe(client,topic){await new Promise((ok,no)=>client.subscribe(topic,{qos:1},(error,grants)=>{if(error||grants?.length!==1||grants[0].topic!==topic||grants[0].qos!==1)no(Error('MQTT_BROKER_QA_SUBSCRIBE_FAILED'));else ok();}));}
async function publish(client,topic,body){await new Promise((ok,no)=>client.publish(topic,body,{qos:1,retain:false},error=>error?no(Error('MQTT_BROKER_QA_PUBLISH_FAILED')):ok()));}
async function denied(client,topic){
  const received=new Promise(ok=>{const handler=packet=>{if(packet.cmd==='puback'){client.off('packetreceive',handler);ok(packet.reasonCode);}};client.on('packetreceive',handler);});
  client.publish(topic,Buffer.from('synthetic-acl-negative'),{qos:1,retain:false},()=>{});assert.equal(await within(received,5000,'MQTT_BROKER_QA_NO_DENIED_PUBACK'),0x87);assert(client.connected);
}
async function nativeWrongCreation(item){
  if(process.platform!=='win32')return;
  const launch=await json(join(item.handle.directory,'launch-intent.private.json')),owner=basename(item.handle.directory).slice('mqtt-broker-process-'.length),requestFile=join(item.handle.directory,'control-'+randomUUID()+'.request.private.json'),resultFile=requestFile.replace('.request.private.json','.result.private.json');
  const request={format:'IDMS_MQTT_BROKER_WIN_CONTROL_V1',action:'SHUTDOWN',owner,challenge:launch.challenge,parentPid:process.pid,pid:item.handle.process.pid,expectedCreatedFileTime:String(BigInt(item.handle.binding.identity.createdFileTime)+1n),program:launch.program,configFile:join(item.handle.directory,'mosquitto.conf'),configSha256:item.handle.binding.configurationSha256,port:item.config.port,resultFile};
  await privateNewFile(requestFile,JSON.stringify(request));
  const helper=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./mqtt-broker-windows-control-v1.ps1',import.meta.url)),requestFile],{windowsHide:true,stdio:['ignore','pipe','pipe']});helper.stdout.resume();helper.stderr.resume();
  const exit=await new Promise((ok,no)=>{helper.once('error',no);helper.once('close',(code,signal)=>ok({code,signal}));});const result=await json(resultFile);
  assert.deepEqual(exit,{code:1,signal:null});assert.equal(result.errorCode,'MQTT_BROKER_WIN_CONTROL_REJECTED');assert.equal(result.delivered,false);assert.equal(result.helperPid,helper.pid);assert.equal(item.handle.process.exitCode,null);
  report.wrongCreationTimeRejectedWithoutDelivery=true;
}

async function main(){
  await privateDirectory(work);
  const parentBytes=await readFile('docs/validation/mqtt-broker-parent-v1.json');assert.equal(hash(parentBytes),'e117e950e58cb604caef7521b9823741cd1337c2878518f7ab0e8e511742d0d2');
  const parent=JSON.parse(parentBytes);assert.equal(parent.parentCommit,'f499648b0f470fe56b7f8ce4308e809d8a7daccc');assert.equal(parent.blobs.length,785);
  const pins=new Map();for(const pin of parent.blobs){assert.equal(hash(await readFile(pin.path)),pin.sha256);pins.set(pin.path,pin.sha256);}
  for(const pin of await mqttBrokerSourcePinsV3()){const path=relative(root,pin.path).replaceAll('\\','/');assert(path&&!path.startsWith('..')&&!isAbsolute(path));pins.set(path,pin.sha256);}
  for(const path of ['scripts/mqtt-broker-lifecycle-v2.mjs','scripts/verify-mqtt-broker-lifecycle-v3.mjs','scripts/verify-mqtt-broker-lifecycle-cleanup-v3.mjs','scripts/verify-mqtt-broker-lifecycle-windows-v3.ps1','scripts/mqtt-broker-lifecycle-v1.mjs','scripts/fixtures/mqtt-broker-materials-v1-qa.mjs','scripts/verify-mqtt-broker-lifecycle-v2.mjs','scripts/verify-mqtt-broker-lifecycle-cleanup-v2.mjs','scripts/verify-mqtt-broker-lifecycle-windows-v2.ps1','scripts/verify-mqtt-broker-lifecycle-v1.mjs','scripts/verify-mqtt-broker-lifecycle-cleanup-v1.mjs','scripts/verify-mqtt-broker-lifecycle-windows-v1.ps1','scripts/verify-mqtt-broker-lifecycle-v4.mjs','scripts/verify-mqtt-broker-lifecycle-cleanup-v4.mjs','scripts/verify-mqtt-broker-lifecycle-windows-v4.ps1','tests/mqtt-broker-runtime-v1.test.mjs','tests/mqtt-broker-windows-control-v1.test.mjs','docs/validation/mqtt-broker-parent-v1.json','docs/superpowers/specs/2026-10-24--mqtt-broker-owned-lifecycle.md','docs/superpowers/plans/2026-10-24--mqtt-broker-owned-lifecycle.md'])pins.set(path,hash(await readFile(path)));
  report.sourcePins=[...pins].map(([path,sha256])=>({path,sha256}));await privateNewFile(join(work,'native-input-pins.json'),JSON.stringify({nonce,sourcePins:report.sourcePins}));console.log(JSON.stringify({nativeStarted:true,nonce,pid:process.pid,sourcePins:report.sourcePins.length,expectedChecks:9}));
  const source={tenantId:'alpha',edgeId:'edge-'+nonce};fixture=await mqttBrokerMaterialsFixtureQaV1(source,{directory:join(work,'materials')});const probeId='idms-broker-probe-'+randomBytes(8).toString('hex');probeCertificate={...await fixture.leaf('health',probeId),clientId:probeId};
  await note('785 declared parent files and fixed new broker source sealed; fresh mTLS materials created without touching original broker or database');
  const positive=await create('positive'),binding=await bindMqttBrokerLifecycleV3(positive.handle);assert.equal(binding.pid,positive.handle.process.pid);assert.equal(binding.parentPid,process.pid);assert(binding.health.pubackReceived&&binding.health.echoReceived&&binding.health.clientClosed);
  await note('actual owned Mosquitto listener and creation identity match; pinned mTLS MQTT5 subscribe, QoS1 echo, PUBACK and normal probe disconnect verified');
  const edge=await rawClient(positive,'edge'),platform=await rawClient(positive,'platform'),health=await rawClient(positive,'probe'),channel=positive.config.channels[0],topic=fieldMqttTopic(channel,'telemetry'),body=randomBytes(20);
  await subscribe(platform.client,topic);const incoming=new Promise(ok=>platform.client.once('message',(actual,bytes,packet)=>ok({actual,bytes:bytes.toString('hex'),qos:packet.qos,retain:packet.retain})));await publish(edge.client,topic,body);assert.deepEqual(await within(incoming,5000,'MQTT_BROKER_QA_NO_TELEMETRY'),{actual:topic,bytes:body.toString('hex'),qos:1,retain:false});
  await denied(edge.client,fieldMqttTopic(channel,'ack'));await denied(platform.client,topic);await denied(health.client,topic);await Promise.all([edge,platform,health].map(closeClient));report.actualQos1BusinessRoundTrip=true;report.healthCannotPublishBusiness=true;
  await note('real field edge publishes QoS1 to its platform; edge ACK writes, platform telemetry writes and health business writes receive actual not-authorized PUBACK while valid clients stay connected');
  assert.throws(()=>stopMqttBrokerLifecycleV3({...positive.handle}),/MQTT_BROKER_LIFECYCLE_HANDLE/);assert.throws(()=>stopMqttBrokerLifecycleV3(positive.handle,{pid:positive.handle.process.pid}),/MQTT_BROKER_STOP_REQUEST/);await nativeWrongCreation(positive);assert((await inspectMqttBrokerLifecycleV3(positive.handle)).ownListener);
  await note('cloned handles and PID fields rejected; Windows wrong actual creation time sends no shutdown event and leaves the same broker available');
  const original=await readFile(positive.runtimeFile),requestId=randomUUID();restorations.set(positive.runtimeFile,original);await writeFile(positive.runtimeFile,Buffer.concat([original,Buffer.from('\n')]));await assert.rejects(stopMqttBrokerLifecycleV3(positive.handle,{requestId}),/MQTT_BROKER_INPUT_CHANGED/);await assert.rejects(lstat(join(positive.handle.directory,'stop-intent.json')),{code:'ENOENT'});assert.equal(positive.handle.process.exitCode,null);await writeFile(positive.runtimeFile,original);restorations.delete(positive.runtimeFile);
  const closing=stopMqttBrokerLifecycleV3(positive.handle,{requestId});assert.equal(stopMqttBrokerLifecycleV3(positive.handle,{requestId}),closing);assert.throws(()=>stopMqttBrokerLifecycleV3(positive.handle,{requestId:randomUUID()}),/MQTT_BROKER_STOP_REQUEST_CHANGED/);const proof=await closing;assert(proof.normalClose&&proof.controlDelivered);assert.equal(proof.requestId,requestId);assert.equal(proof.helperAttempts,1);assert.deepEqual(await stopMqttBrokerLifecycleV3(positive.handle),proof);
  await note('configuration drift prevents any stop intent; restoration permits the same request, single native shutdown and actual exit0 with closed pipes, repeated stop reuses its proof');
  const early=await create('early'),earlyProof=await stopMqttBrokerLifecycleV3(early.handle);assert(earlyProof.startupCancelled&&earlyProof.listenerWasStarted&&earlyProof.normalClose);assert.equal(early.handle.bound,false);
  await note('creation-stage cancellation normally retires the actual broker without claiming full readiness or a never-started listener');
  const conflictPort=await port(),sentinel=createServer(socket=>socket.end('owned-sentinel'));servers.push(sentinel);await new Promise(ok=>sentinel.listen(conflictPort,'127.0.0.1',ok));const failed=await create('occupied',conflictPort),failedExit=await within(failed.handle.terminal,15000,'MQTT_BROKER_QA_CONFLICT_EXIT_TIMEOUT');assert.equal(failedExit.code,1);assert.equal(failedExit.signal,null);await assert.rejects(bindMqttBrokerLifecycleV3(failed.handle),/MQTT_BROKER_NOT_RUNNING/);assert.equal(await new Promise((ok,no)=>{const c=createConnection({host:'127.0.0.1',port:conflictPort});let text='';c.on('data',part=>text+=part);c.once('end',()=>ok(text));c.once('error',no);}), 'owned-sentinel');await new Promise(ok=>sentinel.close(ok));servers.splice(servers.indexOf(sentinel),1);
  await note('occupied port yields the actual new broker failure and closed pipes; the pre-existing owned sentinel remains unchanged');
  const first=await create('separate-first'),second=await create('separate-second');await bindMqttBrokerLifecycleV3(first.handle);await bindMqttBrokerLifecycleV3(second.handle);await stopMqttBrokerLifecycleV3(first.handle);assert.equal(second.handle.process.exitCode,null);const secondBinding=await bindMqttBrokerLifecycleV3(second.handle);assert(secondBinding.health.pubackReceived&&secondBinding.health.clientClosed);await stopMqttBrokerLifecycleV3(second.handle);
  await note('two independently created brokers stay separate; closing the first does not disturb the second authenticated listener');
  for(const pin of report.sourcePins)assert.equal(hash(await readFile(pin.path)),pin.sha256);for(const item of handles){const exit=await item.handle.terminal;assert(exit.proofSaved&&exit.stdoutClosed&&exit.stderrClosed);assert.equal(item.handle.process.signalCode,null);}
  await note('all five actual broker handles and pipes terminal, four native normal shutdowns and one expected startup failure; all sealed source bytes preserved');report.passed=true;
}
main().catch(error=>{report.errorCode=/^[A-Z][A-Z0-9_]{3,120}$/.test(error.message)?error.message:'MQTT_BROKER_NATIVE_QA_FAILED';report.errorName=error.name;process.exitCode=1;}).finally(async()=>{
  try{
    for(const[path,bytes]of restorations)await writeFile(path,bytes);
    for(const entry of clients)if(!entry.client.disconnected)await closeClient(entry);
    for(const item of [...handles].reverse())if(item.handle.process.exitCode===null&&item.handle.process.signalCode===null)await stopMqttBrokerLifecycleV3(item.handle);
    for(const server of servers)await new Promise(ok=>server.close(ok));
    report.outcomes=[];for(const item of handles){const exit=await item.handle.terminal;report.outcomes.push({label:item.label,pid:item.handle.process.pid,directory:item.handle.directory,exit,normalClose:!!item.handle.stopProof,proof:item.handle.stopProof});}
    report.cleanupComplete=report.outcomes.every(item=>item.exit.proofSaved&&item.exit.stdoutClosed&&item.exit.stderrClosed&&item.exit.signal===null);
  }catch{report.cleanupError='MQTT_BROKER_NATIVE_CLEANUP_UNPROVEN';process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await privateNewFile(join(work,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({nonce,passed:report.passed,checks:report.checks.length,cleanupComplete:report.cleanupComplete,ownedRoots:report.outcomes?.length??handles.length,errorCode:report.errorCode??null,cleanupError:report.cleanupError??null}));
});
