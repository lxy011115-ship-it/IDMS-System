import {createPredictorServiceV4} from '../services/predictor/service-v4.ts';
import {modelVersion} from '../services/predictor/model.ts';
import {privateNewFile} from './backup-support.mjs';
import {readPredictorFileV1,predictorRuntimeV1,assertPredictorPinsV1,predictorNodeIdentityV1,predictorHashV1 as hash,predictorNeedV1 as need,predictorUuidV1 as uuid} from './predictor-runtime-v1.mjs';
import {join,resolve} from 'node:path';
let envelope,envelopeSha,server,stopping=false,parentLost=false,requestId=null,readyEmitted=false,listenerStarted=false,action=null,resolveAction,resolveStop,acceptedPromise=Promise.resolve();
const decision=new Promise(ok=>resolveAction=ok),stopped=new Promise(ok=>resolveStop=ok),stats={started:0,finished:0,aborted:0,active:0};
const binding=()=>({owner:envelope.owner,pid:process.pid,parentPid:process.ppid,challengeSha256:hash(envelope.challenge),envelopeSha256:envelopeSha,runtimeSha256:envelope.runtime.sha256,nodeSha256:envelope.node.sha256});
async function send(event,details={}){if(!process.connected)return;await new Promise((ok,no)=>process.send({event,...binding(),...details},error=>error?no(error):ok()));}
function requestStop(id,reason){
 if(stopping)return;stopping=true;requestId=id;action??='STOP';resolveAction(action);resolveStop();
 if(reason==='REQUEST')acceptedPromise=(async()=>{const value={...binding(),requestId,reason,readyBeforeStop:readyEmitted};await privateNewFile(join(envelope.directory,'child-stop-accepted.private.json'),JSON.stringify(value));await send('PREDICTOR_STOP_ACCEPTED_V1',value);})();
 acceptedPromise.catch(()=>{});
}
process.on('message',message=>{
 if(!envelope||!envelopeSha||message?.owner!==envelope.owner||message?.challenge!==envelope.challenge||message?.envelopeSha256!==envelopeSha)return;
 if(message.type==='PREDICTOR_START_V1'&&!stopping&&action===null){action='START';resolveAction(action);}
 else if(message.type==='PREDICTOR_STOP_V1'&&uuid(message.requestId))requestStop(message.requestId,'REQUEST');
});
process.once('disconnect',()=>{parentLost=true;requestStop(null,'PARENT_DISCONNECTED');});
async function closeServer(){if(!server?.listening)return;await new Promise((ok,no)=>server.close(error=>error?no(error):ok()));}
async function main(){
 need(process.argv.length===3&&process.connected,'PREDICTOR_ENTRY_ARGUMENTS');const file=await readPredictorFileV1(process.argv[2],256*1024);envelope=JSON.parse(file.bytes.toString('utf8'));envelopeSha=file.sha256;
 need(envelope.format==='IDMS_PREDICTOR_LAUNCH_V1'&&uuid(envelope.owner)&&envelope.parentPid===process.ppid&&typeof envelope.challenge==='string'&&/^[a-f0-9]{64}$/.test(envelope.challenge)&&resolve(envelope.directory)===envelope.directory,'PREDICTOR_ENTRY_BINDING');
 await assertPredictorPinsV1(envelope.pins);const node=await predictorNodeIdentityV1();need(node.sha256===envelope.node.sha256&&node.bytes===envelope.node.bytes,'PREDICTOR_ENTRY_NODE');const runtime=await readPredictorFileV1(envelope.runtime.path,65536);need(runtime.sha256===envelope.runtime.sha256,'PREDICTOR_ENTRY_RUNTIME');const config=predictorRuntimeV1(JSON.parse(runtime.bytes.toString('utf8')));
 if(parentLost)requestStop(null,'PARENT_DISCONNECTED');await privateNewFile(join(envelope.directory,'child-created.private.json'),JSON.stringify(binding()));await send('PREDICTOR_CREATED_V1');
 await decision;
 if(!stopping){
  server=createPredictorServiceV4(config.serviceToken);const original=server.listeners('request')[0];need(typeof original==='function','PREDICTOR_HTTP_HANDLER');server.removeListener('request',original);
  server.on('request',async(req,res)=>{
   const unavailable=()=>{res.writeHead(503,{'content-type':'application/json','connection':'close'});res.end(JSON.stringify({error:'PREDICTOR_NOT_ACCEPTING'}));};
   if(stopping){unavailable();return;}
   try{need((await readPredictorFileV1(envelope.runtime.path,65536)).sha256===envelope.runtime.sha256,'PREDICTOR_INPUT_CHANGED');}catch{unavailable();return;}if(stopping){unavailable();return;}
   stats.started++;stats.active++;void send('PREDICTOR_ACTIVITY_V1',{stats:{...stats}}).catch(()=>{});let done=false;
   const complete=normal=>{if(done)return;done=true;stats.active--;stats[normal?'finished':'aborted']++;void send('PREDICTOR_ACTIVITY_V1',{stats:{...stats}}).catch(()=>{});};res.once('finish',()=>complete(true));res.once('close',()=>complete(false));
   await original(req,res);
  });
  await new Promise((ok,no)=>{server.once('error',no);server.listen(config.port,config.host,ok);});listenerStarted=true;
  if(!stopping){await privateNewFile(join(envelope.directory,'child-ready.private.json'),JSON.stringify({...binding(),origin:'http://127.0.0.1:'+config.port,modelVersion}));if(!stopping){readyEmitted=true;await send('PREDICTOR_READY_V1',{origin:'http://127.0.0.1:'+config.port,modelVersion});}}
 }
 await stopped;await acceptedPromise;await closeServer();need(stats.active===0&&stats.started===stats.finished+stats.aborted,'PREDICTOR_HTTP_DRAIN_UNPROVEN');
 const terminal={...binding(),requestId,normalClose:!parentLost&&uuid(requestId),readyBeforeStop:readyEmitted,listenerStarted,serverClosed:!server?.listening,stats:{...stats},reason:parentLost?'PARENT_DISCONNECTED':'REQUEST'};
 await privateNewFile(join(envelope.directory,'child-terminal.private.json'),JSON.stringify(terminal));await send('PREDICTOR_CLOSED_V1',terminal);if(parentLost)process.exitCode=1;if(process.connected)process.disconnect();
}
main().catch(async()=>{process.exitCode=1;stopping=true;try{await closeServer();}catch{}if(envelope&&envelopeSha)try{await privateNewFile(join(envelope.directory,'child-failure.private.json'),JSON.stringify({...binding(),errorCode:'PREDICTOR_RUNTIME_FAILED'}));}catch{}console.error('PREDICTOR_RUNTIME_FAILED');if(process.connected)process.disconnect();});
