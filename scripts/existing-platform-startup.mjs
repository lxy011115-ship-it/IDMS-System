import {readFile,writeFile,lstat,access,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadExistingBinding,bindingFile,StartupError,need,jsonFile,sha,runtimeSourceEvidence} from './existing-platform-binding.mjs';
import {privateDirectory} from './backup-support.mjs';
import {acquireCoordinator,occupied,processFacts,sameProcess,observeStage,launchGuardedService} from './existing-platform-process.mjs';
import {serviceProbe,verifyExistingStores} from './existing-platform-probes.mjs';
import {serviceCommand} from './existing-platform-services.mjs';
import {deploymentEvidence,sameDeploymentStructure} from './existing-platform-evidence.mjs';

const parent=resolve('.local/platform-startup'),latest=join(parent,'latest.json');
export const stages=['database','identity','broker','workflow','model','ai','predictor','main','simulator','edge'];
export async function startExistingPlatform(args=[],dependencies={}){
 const output=dependencies.output||console.log;
 // No directory/config/process creation before all bounded static inputs have passed.
 let binding,source;
 try{
  need(args.length===0,'ORDINARY_STARTUP_ARGUMENTS_REFUSED');
  binding=await (dependencies.loadBinding||loadExistingBinding)();
  source=await runtimeSourceEvidence();
  for(const name of stages)await (dependencies.command||serviceCommand)(binding,name);
  for(const file of ['server/index.ts','services/predictor/index.ts','services/ai-gateway/index.ts','services/edge/index.ts','services/edge/simulator.ts'])await access(file);
 }catch(error){error.startupPreflight=true;throw error;}
 if(dependencies.preflightOnly)return {status:'STATIC_PREFLIGHT_PASSED',servicesStarted:0};
 await privateDirectory(join(parent,'runs'));
 const release=await acquireCoordinator(join(parent,'coordinator.lock'),dependencies);
 const runId=randomUUID(),directory=join(parent,'runs',runId),report={format:1,runId,status:'STARTING',sourceDigest:source.digest,sourceFiles:source.files,services:{},startedAt:new Date().toISOString(),initialization:false,automaticRestarts:false,forcedTermination:false};
 let previous;
 const save=async()=>{await writeFile(join(directory,'run.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});await writeFile(latest,JSON.stringify(report,null,2)+'\n',{mode:0o600});};
 try{
  need((await readdir(join(parent,'runs'))).length<32,'RUN_HISTORY_LIMIT_REVIEW');
  await privateDirectory(directory);
  try{previous=await jsonFile(latest,65536);}catch(e){try{await lstat(latest);throw e;}catch(missing){if(missing.code!=='ENOENT')throw e;}}
  await save();const db=await jsonFile(binding.files.database.path),ports={database:db.port,identity:8081,broker:1884,workflow:4016,model:11435,ai:4018,predictor:4012,main:4010,simulator:4015,edge:4014};
  for(const name of stages){
   report.phase=name;await save();let processIdentity,reused=false;
   const port=ports[name];
   if(await occupied(port)){
    processIdentity=previous?.services?.[name]?.process;
    if(['ai','predictor','main','simulator','edge'].includes(name))need(previous?.sourceDigest===source.digest,'OCCUPIED_SOURCE_CHANGED');
    if(name!=='database')need(previous?.services?.[name]?.bindingDigest===sha(JSON.stringify(binding)),'OCCUPIED_DEPLOYMENT_UNVERIFIED');
    if(name==='database'){
     const lines=(await readFile(join(binding.identity.data,'postmaster.pid'),'utf8')).split(/\r?\n/);
     need(resolve(lines[1])===binding.identity.data&&Number(lines[3])===port,'DATABASE_PROCESS_BINDING_MISMATCH');
     processIdentity=await processFacts(Number(lines[0]));need(processIdentity?.executable.toLowerCase()===binding.files.postgres.path.toLowerCase(),'DATABASE_PROCESS_BINDING_MISMATCH');
    }
    need(processIdentity&&sameProcess(processIdentity,await processFacts(processIdentity.pid)),'OCCUPIED_SERVICE_UNVERIFIED');
    need(await serviceProbe(binding,name),'OCCUPIED_SERVICE_CONTRACT_FAILED');reused=true;
   }else{
    // Do not start a replacement for a still-live service whose endpoint has disappeared.
    const prior=previous?.services?.[name]?.process;
    if(prior){const current=await processFacts(prior.pid);need(!current,current&&sameProcess(current,prior)?'EXISTING_PROCESS_UNREADY':'SERVICE_PID_REUSED');}
    if(name==='database'){
     try{const lines=(await readFile(join(binding.identity.data,'postmaster.pid'),'utf8')).split(/\r?\n/);need(!await processFacts(Number(lines[0])),'DATABASE_PID_REQUIRES_REVIEW');report.staleDatabasePidObserved=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(name==='simulator')need(!await occupied(4841),'OPC_PORT_UNVERIFIED');
    if(name==='identity')need(!await occupied(9000),'IDENTITY_MANAGEMENT_PORT_UNVERIFIED');
    let receipt;
    try{receipt=await launchGuardedService(bindingFile,directory,name);}catch(e){if(e.mayHaveStarted)report.services[name]={status:'LAUNCH_UNCONFIRMED',process:null,wrapperPid:e.wrapperPid,reused:false};throw e;}
    processIdentity=receipt.process;
   }
   report.services[name]={reused,process:processIdentity,status:'OBSERVING',bindingDigest:sha(JSON.stringify(binding))};await save();
   const observation=await observeStage({probe:()=>serviceProbe(binding,name),alive:async()=>sameProcess(processIdentity,await processFacts(processIdentity.pid)),budgetMs:name==='identity'?180000:name==='workflow'?90000:30000});
   report.services[name]={...report.services[name],...observation};await save();
   need(observation.status==='READY'||observation.status==='LATE_READY',observation.status==='EXITED'?'SERVICE_EXITED':'SERVICE_START_UNCONFIRMED');
   if(name==='database'){await verifyExistingStores(binding);report.before=await deploymentEvidence(binding);await save();}
   output(JSON.stringify({stage:name,status:observation.status,reused}));
  }
  await loadExistingBinding();need((await runtimeSourceEvidence()).digest===source.digest,'RUNTIME_SOURCE_CHANGED_DURING_START');report.after=await deploymentEvidence(binding);report.structureAndPrivilegesUnchanged=sameDeploymentStructure(report.before,report.after);need(report.structureAndPrivilegesUnchanged,'DEPLOYMENT_STRUCTURE_CHANGED');
  report.status='STARTED';report.url='http://127.0.0.1:4010/?view=overview';report.completedAt=new Date().toISOString();await save();output(JSON.stringify({status:report.status,url:report.url,fullReadiness:'CHECK_SEPARATELY',initialization:false}));return report;
 }catch(e){
  report.status=Object.keys(report.services).length?'PARTIAL_START':'START_REFUSED';report.code=e instanceof StartupError?e.code:'STAGE_VALIDATION_FAILED';report.completedAt=new Date().toISOString();await save();
  output(JSON.stringify({status:report.status,stage:report.phase,code:report.code,startedOrReused:Object.keys(report.services),automaticCleanup:false,advice:'查看私密分阶段记录；未确认进程不重试、不强杀。'}));process.exitCode=1;return report;
 }finally{await release();}
}
export async function startupMain(args=process.argv.slice(2)){try{return await startExistingPlatform(args);}catch(e){console.error(JSON.stringify({status:e.startupPreflight?'PREFLIGHT_REFUSED':'STARTUP_UNCONFIRMED',code:e instanceof StartupError?e.code:'INPUT_OR_BINDING_INVALID',servicesStarted:e.startupPreflight?0:'UNKNOWN',automaticCleanup:false}));process.exitCode=1;}}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await startupMain();
