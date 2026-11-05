import {resolve,dirname,basename,join} from 'node:path';
import {processFacts,sameProcess,occupied} from './existing-platform-process.mjs';
import {inspectControlledNode,stopControlledNode} from './owned-node-control.mjs';
const need=(v,code)=>{if(!v)throw Error(code);},order=['edge','simulator','main'],ports={edge:[4014],simulator:[4015,4841],main:[4010]};
/** All three provenances are checked before the first stop request. Native
 * database and identity services are deliberately outside this command. */
export async function preflightRecoveryStop(p,{facts=processFacts,inspect=inspectControlledNode,portOccupied=occupied}={}){
 const entries=[];
 for(const service of order){
  const prior=p.latest?.services?.[service];need(prior?.process?.pid&&prior.process.born&&prior.process.executable,'RECOVERY_WRITER_PROVENANCE_REQUIRED');const current=await facts(prior.process.pid);need(!current||sameProcess(current,prior.process),'RECOVERY_WRITER_PID_REUSED');
  if(current||prior.control){const cap=prior.control;need(cap&&cap.service===service&&sameProcess(cap.process,prior.process),'RECOVERY_WRITER_CONTROL_REQUIRED');const directory=dirname(cap.requestFile);need(dirname(directory)===resolve(p.binding.project,'.local/platform-startup/runs')&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(basename(directory))&&cap.requestFile===join(directory,service+'.stop.request.json')&&cap.statusFile===join(directory,service+'.stop.status.json'),'RECOVERY_WRITER_CONTROL_PATH_INVALID');await inspect(cap,{facts,requireLive:!!current});}
  if(!current)for(const port of ports[service])need(!await portOccupied(port),'RECOVERY_WRITER_ENDPOINT_OCCUPIED');entries.push({service,process:prior.process,control:prior.control,alreadyTerminal:!current});
 }
 return entries;
}
export async function stopRecoveryWriters(p,{facts=processFacts,inspect=inspectControlledNode,portOccupied=occupied,stop=stopControlledNode,budgetMs=60000}={}){
 const entries=await preflightRecoveryStop(p,{facts,inspect,portOccupied}),results=[];
 for(const entry of entries){
  if(entry.control){const result=await stop(entry.control,{facts,budgetMs});results.push({service:entry.service,...result});if(result.status!=='NORMAL_EXIT')return {status:'WRITER_STOP_UNCONFIRMED',results,automaticRestart:false,forceTermination:false};}
  else results.push({service:entry.service,status:'LEGACY_TERMINAL_OBSERVED',process:entry.process});
 }
 for(const entry of entries){need(!await facts(entry.process.pid),'RECOVERY_WRITER_TERMINAL_CHANGED');for(const port of ports[entry.service])need(!await portOccupied(port),'RECOVERY_WRITER_ENDPOINT_OCCUPIED');}
 return {status:'RECOVERY_WRITERS_STOPPED',results,nativeDatabaseAndIdentityPreserved:true,automaticRestart:false,forceTermination:false};
}
