import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {fieldEdgeMaterialMacV1} from './field-edge-material-binding-v1.mjs';
import {loadFieldEdgeConfiguration,clearFieldEdgeConfiguration} from '../services/field/edge-config.ts';
import {FieldEdgeRunnerV3} from '../services/field/edge-runner-v3.ts';
import {createHash,timingSafeEqual} from 'node:crypto';

const hash=b=>createHash('sha256').update(b).digest('hex');
const envelope=JSON.parse((await readActivationMaterialFile(process.argv[2],1024*1024)).toString('utf8'));
if(envelope.format!=='IDMS_FIELD_EDGE_LAUNCH_V2'||envelope.parentPid!==process.ppid||!process.connected)throw Error('FIELD_EDGE_PARENT_REQUIRED');
if(!Array.isArray(envelope.pins)||envelope.pins.length>512)throw Error('FIELD_EDGE_SOURCE_LIMIT');
for(const p of envelope.pins)if(hash(await readActivationMaterialFile(p.path,2*1024**2))!==p.sha256)throw Error('FIELD_EDGE_SOURCE_CHANGED');
let runner,configuration,task,requestId=null,stopping=false,finished=false,timer;
const emit=(event,details={})=>{if(process.connected)process.send?.({event,owner:envelope.owner,challenge:envelope.challenge,pid:process.pid,parentPid:process.ppid,...details},()=>{});};
const stop=()=>{stopping=true;runner?.stop();};
const state=()=>runner?.state()??{format:'IDMS_FIELD_EDGE_LOCAL_STATE_V3',started:false,stopping,closed:finished,ready:false,cleanupErrors:0};
async function finish(error){
  if(finished)return;finished=true;clearInterval(timer);
  if(configuration&&!runner)clearFieldEdgeConfiguration(configuration);
  const observed=state(),normal=!error&&observed.closed&&observed.cleanupErrors===0;
  emit('FIELD_EDGE_CLOSED_V1',{requestId,normal,startupCancelled:stopping&&!runner,localState:observed,errorCode:error?'FIELD_EDGE_RUN_FAILED':null});
  if(error)process.exitCode=1;
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
  // Node 24 dispatches IPC messages queued before listener installation in a
  // nextTick loop which still uses target.channel after our handler returns.
  // Defer disconnect beyond that loop, including pre-START cancellation.
  await new Promise(ok=>setImmediate(ok));
  if(process.connected)process.disconnect();
}
async function start(m){
  let key;
  try{
    key=Buffer.from(m.materialKey,'hex');
    const before=await readActivationMaterialFile(envelope.edgeConfigurationFile,262144);
    if(hash(before)!==envelope.edgeConfigurationSha256)throw Error('FIELD_EDGE_CONFIG_CHANGED');
    configuration=await loadFieldEdgeConfiguration(envelope.edgeConfigurationFile);
    const after=await readActivationMaterialFile(envelope.edgeConfigurationFile,262144);
    const mac=fieldEdgeMaterialMacV1(configuration,key);
    if(hash(after)!==envelope.edgeConfigurationSha256||!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(envelope.materialMac,'hex')))throw Error('FIELD_EDGE_MATERIAL_CHANGED');
    key.fill(0);key=null;
    if(stopping){clearFieldEdgeConfiguration(configuration);configuration=null;await finish();return;}
    runner=new FieldEdgeRunnerV3(configuration);
    timer=setInterval(()=>emit('FIELD_EDGE_STATE_V1',{localState:state()}),200);
    emit('FIELD_EDGE_STARTED_V1');
    await runner.run();
    await finish();
  }catch(error){
    key?.fill(0);if(stopping&&error?.code==='FIELD_EDGE_STOPPED'&&runner?.state().closed)await finish();
    else await finish(error);
  }
}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
process.on('disconnect',()=>{stop();if(!task)void finish();});
process.on('message',m=>{
  if(!m||m.owner!==envelope.owner||m.challenge!==envelope.challenge||finished)return;
  if(m.type==='FIELD_EDGE_STOP_V1'){
    if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(m.requestId))return;
    if(requestId&&requestId!==m.requestId)return;
    requestId=m.requestId;stop();if(!task)void finish();
  }else if(m.type==='FIELD_EDGE_START_V1'&&!task&&!stopping){task=start(m);}
  else if(m.type==='FIELD_EDGE_PROBE_V1')emit('FIELD_EDGE_PROBE_V1',{requestId:m.requestId,localState:state()});
});
emit('FIELD_EDGE_CREATED_V1');
