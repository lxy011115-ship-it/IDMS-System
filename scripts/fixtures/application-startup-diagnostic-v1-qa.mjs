import {resolve,dirname,join} from 'node:path';
import {lstat} from 'node:fs/promises';
import {canonical} from '../../server/imports.ts';
import {applicationManifestV1,readApplicationFileV1,applicationHashV1 as hash} from '../runtime-application-config-v1.mjs';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';

const need=(v,c)=>{if(!v)throw Error(c);},code=v=>typeof v==='string'&&/^(?:APPLICATION_|COLD_|AUTHORITY_|IDENTITY_)[A-Z0-9_]{1,100}$/.test(v)?v:null;
const json=async file=>JSON.parse((await readApplicationFileV1(file)).bytes.toString('utf8').replace(/^\uFEFF/,''));
const normal=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);

/** Read only. The verifier supplies roots from the actual fork objects it retained. */
export async function inspectApplicationStartupDiagnosticQaV1({roots,retired}){
 need(Array.isArray(roots)&&roots.length<=64&&new Set(roots.map(r=>r.pid)).size===roots.length,'APPLICATION_STARTUP_DIAGNOSTIC_ROOTS');
 const groups=[];let members=0,normalMembers=0,failedMembers=0,allBound=true;
 for(const root of roots){
  need(Number.isInteger(root.pid)&&root.pid>0&&typeof root.launchFile==='string'&&root.exit&&Number.isInteger(root.exit.code)&&root.exit.signal===null,'APPLICATION_STARTUP_DIAGNOSTIC_ROOT');
  const file=resolve(root.launchFile),manifest=applicationManifestV1(await json(file)),directory=resolve(dirname(file),manifest.registryDirectory),exists=await lstat(join(directory,'trust.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(!exists){groups.push({ownerPid:root.pid,registryPresent:false,memberCount:null,retirementProven:false});allBound=false;continue;}
  const trust=await json(join(directory,'trust.json')),registry=await readApplicationRegistryV1(trust);need(registry.header.ownerPid===root.pid&&normal(resolve(dirname(file),registry.header.manifest.registryDirectory))===normal(directory)&&canonical(registry.header.manifest)===canonical(manifest),'APPLICATION_STARTUP_DIAGNOSTIC_OWNER');
  const terminal=registry.events.at(-1);need(registry.lifecycle.terminal&&['FAILED','GROUP_CLOSED'].includes(terminal?.event),'APPLICATION_STARTUP_DIAGNOSTIC_NOT_TERMINAL');
  const launched=registry.events.filter(e=>e.event==='LAUNCH_INTENT'),rows=[];
  for(const launch of launched){
   const id=launch.componentId,envelopeFile=join(directory,id+'-launch.private.json'),envelope=await json(envelopeFile),result=await json(join(directory,id+'-result.private.json')),exit=registry.events.find(e=>e.event==='EXIT'&&e.componentId===id);
   need(exit&&exit.signal===null&&Number.isInteger(exit.pid)&&exit.pid>0,'APPLICATION_STARTUP_DIAGNOSTIC_EXIT');
   need(result.format==='RUNTIME_APPLICATION_CHILD_RESULT_V2'&&result.ownerId===trust.ownerId&&result.parentPid===root.pid&&result.componentId===id&&result.pid===exit.pid&&envelope.parentPid===root.pid&&envelope.ownerId===trust.ownerId&&envelope.component.id===id&&result.challengeSha256===hash(envelope.challenge)&&result.configSha256===launch.configSha256&&envelope.configSha256===launch.configSha256&&result.manifestSha256===hash(canonical(manifest))&&envelope.manifestSha256===result.manifestSha256,'APPLICATION_STARTUP_DIAGNOSTIC_BINDING');
   if(result.normalClose){const stop=registry.events.find(e=>e.event==='STOP_INTENT'&&e.componentId===id),closed=registry.events.find(e=>e.event==='CLOSED'&&e.componentId===id);need(exit.code===0&&stop&&closed&&stop.requestId===result.requestId&&closed.requestId===result.requestId,'APPLICATION_STARTUP_DIAGNOSTIC_NORMAL');normalMembers++;}
   else{need(exit.code===1&&code(result.errorCode),'APPLICATION_STARTUP_DIAGNOSTIC_FAILURE');failedMembers++;}
   if(retired)await retired(exit.pid,[envelopeFile],new Date(exit.at).toISOString());
   rows.push({componentId:id,pid:exit.pid,normalClose:result.normalClose,errorCode:code(result.errorCode),ready:result.ready===true,actualRecordedExit:{code:exit.code,signal:exit.signal},privateResultBindingVerified:true});members++;
  }
  if(retired)await retired(root.pid,[file],new Date(terminal.at).toISOString());
  groups.push({ownerPid:root.pid,registryPresent:true,groupReady:registry.lifecycle.groupReady,terminalEvent:terminal.event,terminalErrorCode:code(terminal.errorCode),memberCount:rows.length,members:rows,retirementProven:true});
 }
 return{format:'IDMS_APPLICATION_STARTUP_DIAGNOSTIC_V1',rootsObserved:roots.length,groups,membersWithBoundExitResults:members,normalMembers,failedMembers,allDiscoveredMemberRetirementsBound:allBound,independentPidObservationsPerformed:typeof retired==='function',rawFailureOrCredentialsPrinted:false};
}

export function summarizeApplicationStartupDiagnosticQaV1(report){
 const d=report.applicationStartupDiagnostics,codes=new Set();
 for(const group of d?.groups??[]){if(code(group.terminalErrorCode))codes.add(group.terminalErrorCode);for(const member of group.members??[])if(code(member.errorCode))codes.add(member.errorCode);}
 return{startupDiagnosticNeeded:report.passed!==true,startupDiagnosticObserved:d?.format==='IDMS_APPLICATION_STARTUP_DIAGNOSTIC_V1',startupRootsObserved:d?.rootsObserved??null,startupMemberExitBindings:d?.membersWithBoundExitResults??null,startupAllDiscoveredMemberRetirementsBound:d?d.allDiscoveredMemberRetirementsBound===true:null,startupFailureCodes:[...codes].sort(),startupDiagnosticFailureCode:code(report.applicationStartupDiagnosticError),rawStartupFailureOrCredentialsPrinted:false};
}
