import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
import {launchApplicationLifecycleV1,bindApplicationLifecycleV1,stopApplicationLifecycleV1} from '../application-lifecycle-v1.mjs';

const json=async p=>JSON.parse(await readFile(p,'utf8')),sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function within(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,no)=>timer=setTimeout(()=>no(Error(code)),ms))]);}finally{clearTimeout(timer);}}

/** Reuses this case's actual authority/data, never existing production processes. */
export async function exerciseApplicationLifecycleQaV1({work,site,children,report,note}){
 const original=await json(join(work,'application-a.private.json')),records=join(work,'application-lifecycle-records');await privateDirectory(records);const groups=[],handles=[];
 async function launch(label){
  const manifest={...original,registryDirectory:join(work,'application-lifecycle-'+label)},file=join(work,'application-lifecycle-'+label+'.private.json');await privateNewFile(file,canonical(manifest));
  const handle=await launchApplicationLifecycleV1({manifestFile:file,workDirectory:records}),h={process:handle.process,script:'scripts/runtime-application-suite-v2.mjs',stopType:'APPLICATION_SUITE_STOP',lifecycle:handle,terminal:handle.terminal.then(p=>p.exit)};
  handles.push(h);children.push(h);report.children.push({pid:h.process.pid,script:h.script});return{handle,h,manifest};
 }
 async function capture(group,proof){
  const trust=await json(join(group.manifest.registryDirectory,'trust.json')),r=await readApplicationRegistryV1(trust);assert.equal(r.header.ownerPid,group.h.process.pid);
  const exits=r.events.filter(e=>e.event==='EXIT'),members=[];
  for(const e of exits){const envelopeFile=join(group.manifest.registryDirectory,e.componentId+'-launch.private.json'),resultFile=join(group.manifest.registryDirectory,e.componentId+'-result.private.json'),envelope=await json(envelopeFile),result=await json(resultFile);assert.equal(envelope.parentPid,group.h.process.pid);assert.equal(result.parentPid,group.h.process.pid);assert.equal(result.ownerId,trust.ownerId);assert.equal(result.pid,e.pid);assert(result.normalClose);assert.equal(e.code,0);assert.equal(e.signal,null);const intent=r.events.find(v=>v.event==='STOP_INTENT'&&v.componentId===e.componentId);assert.equal(result.requestId,intent.requestId);members.push({componentId:e.componentId,pid:e.pid,envelopeFile,resultFile,exit:{code:e.code,signal:e.signal}});}
  assert.equal(members.length,proof.membersCreated);assert.equal(proof.membersNormalExit,members.length);assert(proof.allOwnedTerminalProven);assert.equal(proof.exit.code,0);assert.equal(proof.exit.signal,null);
  const value={ownerPid:group.h.process.pid,directory:group.handle.directory,registryTrust:trust,proof,members};groups.push(value);return value;
 }
 try{
  const full=await launch('full');assert.equal(full.handle.ready,false);assert(full.h.process.pid>0);const bound=await within(bindApplicationLifecycleV1(full.handle),180000,'APPLICATION_LIFECYCLE_QA_READY_OBSERVATION');assert.equal(bound.pid,full.h.process.pid);assert.equal(bound.components,9);
  const accounts=await json(join(work,'background-users.private.json'));
  for(const tenant of original.tenantIds){const a=accounts[tenant].operator,r=await fetch(site.origin+'/api/v4/site/context',{headers:{cookie:'idms_session='+a.sid,origin:site.origin,'x-tenant-id':tenant,'x-idms-actor-id':a.id,'x-csrf-token':a.csrf},redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);assert.equal((await r.json()).modules.length,4);}
  const requestId=randomUUID(),stop=stopApplicationLifecycleV1(full.handle,{requestId});assert.equal(stopApplicationLifecycleV1(full.handle,{requestId}),stop);assert.throws(()=>stopApplicationLifecycleV1(full.handle,{requestId:randomUUID()}),/APPLICATION_LIFECYCLE_REQUEST_CHANGED/);
  const proof=await within(stop,180000,'APPLICATION_LIFECYCLE_QA_STOP_OBSERVATION');assert(proof.normalFullGroup&&!proof.startupCancelled);assert.equal(proof.membersCreated,9);assert.equal(await stopApplicationLifecycleV1(full.handle),proof);await capture(full,proof);
  note('early-handle application adapter binds a real nine-member READY group, both tenant HTTP contexts and one correlated normal stop; repeated requests return the same actual proof');
  const partial=await launch('partial'),binding=bindApplicationLifecycleV1(partial.handle);binding.catch(()=>{});let sawPartial=false;
  for(let i=0;i<1800;i++){
   assert.equal(partial.h.process.exitCode,null);let trust;try{trust=await json(join(partial.manifest.registryDirectory,'trust.json'));}catch(error){if(error.code==='ENOENT'){await sleep(50);continue;}throw error;}
   const r=await readApplicationRegistryV1(trust);assert(!r.lifecycle.groupReady);if(r.events.some(e=>e.event==='READY')){sawPartial=true;break;}await sleep(50);
  }
  assert(sawPartial);const cancelId=randomUUID(),cancel=stopApplicationLifecycleV1(partial.handle,{requestId:cancelId});assert.equal(stopApplicationLifecycleV1(partial.handle,{requestId:cancelId}),cancel);
  const cancelled=await within(cancel,180000,'APPLICATION_LIFECYCLE_QA_CANCEL_OBSERVATION');assert(cancelled.startupCancelled&&!cancelled.normalFullGroup);assert(cancelled.membersCreated>0&&cancelled.membersCreated<9);await assert.rejects(binding,/APPLICATION_LIFECYCLE_/);await capture(partial,cancelled);
  note('the same adapter cancels an actual partially ready group, preserves the root handle and verifies all already-created members and the root exit normally without claiming full READY');
  report.applicationLifecycle={groups,normalGroups:1,startupCancelledGroups:1,registeredApplicationChildProcesses:groups.reduce((n,g)=>n+g.members.length,0),fullGroupPositiveNativeVerified:true,backendSessionsExplicit:true,browserCases:false,oldOwnerAdopted:false,wholeStackIntegrated:false};await privateNewFile(join(work,'application-lifecycle-verification.json'),canonical(report.applicationLifecycle));
 }finally{
  for(const h of [...handles].reverse()){if(h.process.exitCode===null&&h.process.signalCode===null)await stopApplicationLifecycleV1(h.lifecycle);await h.terminal;}
 }
}
