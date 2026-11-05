// Fresh synthetic sources, owned broker, actual edge/simulator processes and real OPC UA reads.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import mqtt from 'mqtt';
import {OPCUAServer,OPCUACertificateManager,DataType,Variant,DataValue,MessageSecurityMode,SecurityPolicy,StatusCodes} from 'node-opcua';
import {createTelemetryRecoveryBrokerQa} from './fixtures/telemetry-recovery-broker-qa.mjs';
import {privateDirectory} from './backup-support.mjs';
import {processFacts,sameProcess,occupied} from './existing-platform-process.mjs';
import {stopControlledNode} from './owned-node-control.mjs';
import {runtimeSourceEvidence} from './existing-platform-binding.mjs';
import {EdgeSpool} from '../services/edge/spool.ts';
import {proposeSpoolRecovery,recoverStoppedSpool} from '../services/edge/spool-maintenance.ts';
import {topicFor,sha,signAck,authenticEvent} from '../integrations/telemetry.ts';
assert.equal(process.platform,'win32','Windows creator identity proof is required');
const nonce=randomBytes(6).toString('hex'),directory=resolve('work/telemetry-edge-control-20261105',nonce);await privateDirectory(directory);
const report={format:'IDMS_ACTUAL_EDGE_CONTROL_QA_V1',passed:false,syntheticOnly:true,enterpriseDatabaseContacted:false,checks:[],cleanup:{}};
const caseFiles=['scripts/verify-telemetry-edge-control.mjs','scripts/fixtures/telemetry-edge-wrapper-qa.mjs','scripts/owned-node-control.mjs','scripts/existing-platform-child.mjs','scripts/existing-platform-process.mjs','scripts/fixtures/telemetry-recovery-broker-qa.mjs'];
const evidence=async()=>({runtime:await runtimeSourceEvidence(),caseSourcePins:await Promise.all(caseFiles.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))});report.sourceBefore=await evidence();
const write=async(name,value)=>{const path=join(directory,name);await writeFile(path,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});return path;};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(task,label,budgetMs=30000){const start=performance.now();for(;;){const value=await task();if(value)return value;if(performance.now()-start>=budgetMs)throw Error('QA_OBSERVATION_UNCONFIRMED_'+label);await wait(100);}}
async function ports(count){const sockets=[];for(let i=0;i<count;i++){const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});sockets.push(s);}const selected=sockets.map(s=>s.address().port);assert(selected.every(p=>![4010,4014,4015,4841,8081,1884].includes(p)));for(const s of sockets)await new Promise(ok=>s.close(ok));return selected;}
const [edgePort,simPort,opcPort,heldPort]=await ports(4),source={tenantId:'sandbox',edgeId:'controlqa-'+nonce,deviceCode:'SIM-QA',origin:'SIMULATOR',mapVersion:'qa-1',signingKey:randomBytes(32).toString('base64url'),acknowledgementKey:randomBytes(32).toString('base64url'),statusKey:randomBytes(32).toString('base64url'),statusUrl:'http://127.0.0.1:'+edgePort+'/status',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',unit:'mm/s'}]};
let broker,core,spool,heldServer,heldCallbacks=[],failed=false;const children=[],packets=[];
async function launch(service,config,label){
 const dir=join(directory,label);await privateDirectory(dir);await writeFile(join(dir,'input.private.json'),JSON.stringify({format:'IDMS_OWNED_EDGE_CONTROL_QA_V1',service,config}),{flag:'wx',mode:0o600});
 const wrapper=spawn(process.execPath,[resolve('scripts/fixtures/telemetry-edge-wrapper-qa.mjs'),dir],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:''},detached:true,windowsHide:true,stdio:'ignore'}),entry={dir,wrapper,service};
 entry.terminal=new Promise(ok=>{wrapper.once('error',error=>ok({error:error.code}));wrapper.once('close',(exitCode,signal)=>{entry.ended={exitCode,signal};ok(entry.ended);});});children.push(entry);
 entry.control=await until(async()=>{try{return JSON.parse(await readFile(join(dir,'capability.private.json'),'utf8')).control;}catch(error){if(error.code!=='ENOENT')throw error;assert(!entry.ended,'QA_WRAPPER_TERMINAL_BEFORE_CAPABILITY');return false;}},'CAPABILITY');return entry;
}
async function close(entry){if(entry.closed)return;assert(entry.control);const result=await stopControlledNode(entry.control,{budgetMs:30000});assert.equal(result.status,'NORMAL_EXIT');assert.deepEqual(await entry.terminal,{exitCode:0,signal:null});const terminal=JSON.parse(await readFile(join(entry.dir,'terminal.private.json'),'utf8'));assert(terminal.end.stdoutClosed&&terminal.end.stderrClosed&&terminal.final.drainCompleted);entry.closed=true;entry.proof={result,terminal};}
async function status(url,key){try{const r=await fetch(url,{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(2000)});assert(r.ok);return await r.json();}catch(error){if(error.code==='ERR_ASSERTION')throw error;return false;}}
const edgeStatus=()=>status(source.statusUrl,source.statusKey),simStatus=()=>status('http://127.0.0.1:'+simPort+'/status',simKey);
const simKey=randomBytes(32).toString('base64url'),sample=()=>({tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',unit:'mm/s',eventTime:new Date().toISOString(),value:2,quality:'GOOD'});
const ack=(event,status='REJECTED',changes={},key=source.acknowledgementKey)=>Buffer.from(JSON.stringify(signAck({version:1,eventId:event.eventId,tenantId:source.tenantId,edgeId:source.edgeId,digest:sha(event),status,...(status==='REJECTED'?{reason:'SEQUENCE_CONFLICT'}:{}),...changes},key)));
const publish=wire=>new Promise((ok,no)=>core.publish(topicFor(source,'ack'),wire,{qos:1},error=>error?no(error):ok()));
try{
 broker=await createTelemetryRecoveryBrokerQa(directory,process.env.IDMS_QA_MQTT_BIN,source);await broker.ready();
 const path=join(directory,'recovery.sqlite');spool=new EdgeSpool(path,source);for(let i=0;i<3;i++)spool.append(sample());const originals=spool.db.prepare('SELECT * FROM pending ORDER BY rowid').all();spool.close();spool=undefined;
 const proposal=proposeSpoolRecovery(path,source,100,'a'.repeat(64));await recoverStoppedSpool(path,source,proposal,{directory,assertStopped:async()=>{assert.equal(children.length,0);}});
 const config={version:1,mqtt:{url:broker.url,...broker.core},sources:[source],edge:{...broker.edge,endpoint:'opc.tcp://127.0.0.1:'+opcPort,securityMode:'None',spool:path,pollMs:500,capacity:10000},simulator:{port:opcPort,statusPort:simPort,statusKey:simKey}},configFile=await write('telemetry.private.json',config);
 core=mqtt.connect(broker.url,{...broker.core,clientId:'qa-observer-'+nonce,protocolVersion:5,clean:true,reconnectPeriod:0,connectTimeout:3000});core.on('error',()=>{});
 await new Promise((ok,no)=>{core.once('connect',ok);core.once('error',no);});await new Promise((ok,no)=>core.subscribe(topicFor(source,'telemetry'),{qos:1},(error,grants)=>error||grants?.[0]?.qos!==1?no(Error('QA_SUBSCRIBE_FAILED')):ok()));
 core.on('message',(_,wire)=>packets.push({wire:wire.toString(),event:JSON.parse(wire.toString())}));
 const sim=await launch('simulator',configFile,'simulator');await until(simStatus,'SIMULATOR_READY');const edge=await launch('edge',configFile,'edge-recovery');
 const paused=await until(async()=>{const s=await edgeStatus();return s?.mqttConnected&&s.ackSubscribed&&s.recoveryPending===3?s:false;},'RECOVERY_PAUSED');await until(()=>packets.length===1,'FIRST_ORIGINAL');await wait(1200);assert.equal(packets.length,1);assert.equal((await simStatus()).readRequests,0);assert.equal(paused.opcConnected,false);assert.equal(paused.capturePaused,true);assert.equal(paused.sequence,100);assert.equal(packets[0].wire,originals[0].payload);report.checks.push('ACTUAL_EDGE_PAUSES_CAPTURE_AND_HOLDS_ONE_BUSINESS_ACK_SLOT');
 await publish(ack(packets[0].event,'REJECTED',{},'wrong-key'));await publish(ack(packets[0].event,'REJECTED',{digest:'0'.repeat(64)}));await wait(600);assert.equal(packets.length,1);assert.equal((await edgeStatus()).recoveryPending,3);report.checks.push('ACTUAL_MQTT_WRONG_SIGNATURE_AND_DIGEST_DO_NOT_RELEASE_SLOT');
 for(let i=0;i<3;i++){await until(()=>packets.length>i,'NEXT_ORIGINAL');assert.equal(packets[i].wire,originals[i].payload);await publish(ack(packets[i].event));}
 const resumed=await until(async()=>{const s=await edgeStatus();return s?.recoveryPending===0&&s.records===3&&s.opcConnected&&packets.some(p=>p.event.sequenceNo>100)?s:false;},'ACTUAL_OPC_RESUMED');assert.equal(resumed.capturePaused,false);const future=packets.find(p=>p.event.sequenceNo>100);assert.equal(future.event.sequenceNo,101);assert(authenticEvent(future.event,source.signingKey));assert((await simStatus()).readRequests>0);assert.equal((await simStatus()).writeRequests,0);
 await close(edge);assert.equal(await occupied(edgePort),false);assert(sameProcess(sim.control.process,await processFacts(sim.control.process.pid)));spool=new EdgeSpool(path,source,10000,{existingOnly:true});assert.equal(spool.stats().records,3);const stored=spool.db.prepare('SELECT payload FROM pending WHERE event_id=?').get(future.event.eventId);assert.equal(stored.payload,future.wire);for(const row of originals)assert.equal(spool.db.prepare('SELECT payload FROM quarantine WHERE event_id=?').get(row.event_id).payload,row.payload);spool.close();spool=undefined;report.checks.push('ACTUAL_OPC_RESUMES_FUTURE_SEQUENCE_AND_NORMAL_EDGE_EXIT_PRESERVES_UNACKNOWLEDGED_MESSAGE');
 // A real OPC UA server holds an asynchronous read response. No edge function is stubbed.
 heldServer=new OPCUAServer({port:heldPort,host:'127.0.0.1',hostname:'127.0.0.1',alternateHostname:['127.0.0.1'],securityModes:[MessageSecurityMode.None],securityPolicies:[SecurityPolicy.None],serverCertificateManager:new OPCUACertificateManager({rootFolder:join(directory,'held-opc-pki'),automaticallyAcceptUnknownCertificate:true})});await heldServer.initialize();const ns=heldServer.engine.addressSpace.getOwnNamespace();ns.addVariable({organizedBy:heldServer.engine.addressSpace.rootFolder.objects,browseName:'held-qa',nodeId:source.points[0].nodeId,dataType:'Double',accessLevel:'CurrentRead',userAccessLevel:'CurrentRead',value:{refreshFunc(callback){heldCallbacks.push(callback);}}});await heldServer.start();
 const heldPath=join(directory,'held.sqlite');spool=new EdgeSpool(heldPath,source);spool.close();spool=undefined;const heldConfig=await write('held-telemetry.private.json',{...config,edge:{...config.edge,endpoint:'opc.tcp://127.0.0.1:'+heldPort,spool:heldPath,pollMs:10000}}),reading=await launch('edge',heldConfig,'edge-held-read');await until(()=>heldCallbacks.length>0,'ACTUAL_READ_HELD');const stopped=await stopControlledNode(reading.control,{budgetMs:0});assert.equal(stopped.status,'UNCONFIRMED');await until(async()=>JSON.parse(await readFile(reading.control.statusFile,'utf8')).phase==='ACCEPTED','STOP_ACCEPTED');assert(sameProcess(reading.control.process,await processFacts(reading.control.process.pid)));assert.equal(await occupied(edgePort),false);
 for(const callback of heldCallbacks.splice(0))callback(null,new DataValue({value:new Variant({dataType:DataType.Double,value:7}),statusCode:StatusCodes.Good,sourceTimestamp:new Date()}));
 const ended=await stopControlledNode(reading.control,{requestId:stopped.requestId,budgetMs:30000});assert.equal(ended.status,'NORMAL_EXIT');await close(reading);spool=new EdgeSpool(heldPath,source,10000,{existingOnly:true});assert.equal(spool.stats().pending,1);assert.equal(spool.stats().sequence,1);assert.equal(JSON.parse(spool.db.prepare('SELECT payload FROM pending').get().payload).value,7);spool.close();spool=undefined;await heldServer.shutdown(0);heldServer=undefined;report.checks.push('ACTUAL_EDGE_WAITS_FOR_IN_FLIGHT_OPC_RESPONSE_AND_PRESERVES_CAPTURE_BEFORE_SQLITE_CLOSE');
 await close(sim);assert.equal(await occupied(simPort),false);assert.equal(await occupied(opcPort),false);report.checks.push('ACTUAL_SIMULATOR_NORMAL_EXIT_CLOSES_STATUS_AND_OPC_LISTENERS');
 report.passed=true;
}catch(error){failed=true;report.failure={message:String(error.message),stack:String(error.stack)};process.exitCode=1;}
finally{
 spool?.close();for(const callback of heldCallbacks.splice(0))callback(null,new DataValue({value:new Variant({dataType:DataType.Double,value:7}),statusCode:StatusCodes.Good,sourceTimestamp:new Date()}));
 // Same original handles, normal close only. An unconfirmed close is retained.
 for(const entry of children.filter(c=>c.service==='edge').concat(children.filter(c=>c.service==='simulator'))){try{await close(entry);}catch(error){report.cleanup[entry.dir]={unconfirmed:true,code:error.message};report.passed=false;process.exitCode=1;}}
 if(heldServer)await heldServer.shutdown(0);if(core)await new Promise(ok=>core.end(false,{},ok));if(broker)report.cleanup.broker=await broker.close();
 report.children=children.map(c=>({service:c.service,directory:c.dir,normalExit:c.closed===true,proof:c.proof}));report.sourceAfter=await evidence();assert.deepEqual(report.sourceBefore,report.sourceAfter);report.observedAt=new Date().toISOString();await write('verification.json',report);console.log(JSON.stringify({passed:report.passed,checks:report.checks,evidence:join(directory,'verification.json'),failure:failed?report.failure.message:undefined}));
}
