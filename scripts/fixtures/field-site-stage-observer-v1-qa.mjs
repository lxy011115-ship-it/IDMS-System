import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {privateNewFile} from '../backup-support.mjs';

/** Observation only: no authorization calls, timeout cancellation, process signals or resource adoption. */
export async function createFieldSiteStageObserverQaV1({work,nonce,report,snapshot=()=>null,heartbeatMs=10000}){
 if(!/^[a-f0-9]{12}$/.test(nonce)||!report||typeof snapshot!=='function'||!Number.isInteger(heartbeatMs)||heartbeatMs<20||heartbeatMs>60000)throw Error('FIELD_SITE_OBSERVER_ARGUMENTS');
 const file=join(work,'field-site-stage.private.jsonl');await privateNewFile(file,'');const active=new Map();let sequence=0,journal=Promise.resolve(),closed=false;
 function record(stage,phase,started){const resources={};for(const name of process.getActiveResourcesInfo())resources[name]=(resources[name]??0)+1;let state=null;try{state=snapshot();if(Buffer.byteLength(JSON.stringify(state))>16384)state={snapshotTooLarge:true};}catch{report.fieldSiteObservationFailed=true;}
  const value={format:'FIELD_SITE_STAGE_OBSERVATION_V1',nonce,sequence:++sequence,stage,phase,elapsedMs:Math.round(performance.now()-started),resources,state,rawCredentialsPrinted:false};report.fieldSiteCurrentStage=stage;report.fieldSiteCurrentPhase=phase;
  try{console.log(JSON.stringify(value));}catch{report.fieldSiteObservationFailed=true;}
  journal=journal.then(()=>appendFile(file,JSON.stringify(value)+'\n')).catch(()=>{report.fieldSiteObservationFailed=true;});return journal;
 }
 return{async observe(stage,operation){if(closed||!/^[A-Z][A-Z0-9_]{2,80}$/.test(stage)||typeof operation!=='function')throw Error('FIELD_SITE_OBSERVER_STAGE');const id=Symbol(stage),started=performance.now();await record(stage,'STARTED',started);const timer=setInterval(()=>{void record(stage,'WAITING',started);},heartbeatMs);timer.unref();active.set(id,timer);
  try{const value=await operation();await record(stage,'SUCCEEDED',started);return value;}catch(error){await record(stage,'FAILED',started);throw error;}finally{clearInterval(timer);active.delete(id);}
 },async close(){closed=true;for(const timer of active.values())clearInterval(timer);await journal;if(active.size)report.fieldSiteObservationFailed=true;}};
}
