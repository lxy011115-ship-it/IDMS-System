import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';

/** Read independent persisted service and application proofs after native exit. */
export async function verifyCoreCancellationCleanupQaV1({report:r,json,retired}){
 const rows=r.coreCancellationResources??[],summary={resourcesRetired:0,postgresNormalStops:0,identityNormalStops:0,workflowNormalStops:0,poolClosures:0,applicationRootsRetired:0,applicationMembersRetired:0,casesVerified:0};
 for(const e of rows){
  const exit=await json(join(e.directory,'exit-observation.json')),proof=await json(join(e.directory,'normal-stop-proof.json'));
  assert.equal(exit.pid,e.pid);assert.equal(exit.code,0);assert.equal(exit.signal,null);
  if(e.kind==='POSTGRES'){
   assert(proof.helperReplyConfirmed&&proof.terminal.proofSaved);assert.equal(proof.terminal.code,0);assert.equal(proof.terminal.signal,null);
   assert.equal(proof.control.state,'shut down');assert.equal(proof.control.systemIdentifier,e.binding.systemIdentifier);assert.equal(proof.otherClientsBefore,0);assert.equal(proof.preparedTransactionsBefore,0);
   await assert.rejects(lstat(join(e.binding.dataDirectory,'postmaster.pid')),{code:'ENOENT'});
   await retired(e.pid,[e.binding.dataDirectory],exit.observedAt);summary.postgresNormalStops++;
  }else if(e.kind==='IDENTITY'||e.kind==='WORKFLOW'){
   assert(proof.helperReplyConfirmed&&!proof.targetSignalSent);assert.equal(proof.binding.owner,e.binding.owner);
   assert.equal(exit.owner,e.binding.owner);assert.equal(exit.deployment,e.binding.deployment);
   await retired(e.pid,[e.binding.owner],exit.observedAt);
   if(e.kind==='IDENTITY')summary.identityNormalStops++;
   else{assert(proof.gracefulWebCompleted&&proof.poolCallbacksLogged);assert.equal(proof.expectedPoolClosures,6);summary.workflowNormalStops++;summary.poolClosures+=proof.expectedPoolClosures;}
  }else{
   assert.equal(e.kind,'APPLICATIONS');assert(proof.startupCancelled&&!proof.normalFullGroup&&proof.allOwnedTerminalProven);assert(proof.membersCreated>0&&proof.membersCreated<9);
   const trust=await json(join(e.registryDirectory,'trust.json')),registry=await readApplicationRegistryV1(trust);
   assert.equal(registry.header.ownerPid,e.pid);assert(!registry.lifecycle.groupReady&&registry.lifecycle.terminal);
   assert.equal(registry.events.at(-1).event,'FAILED');assert.equal(registry.events.at(-1).errorCode,'APPLICATION_SUITE_START_CANCELLED');
   assert(!registry.events.some(v=>v.event==='LAUNCH_INTENT'&&v.componentId==='site'));
   let members=0;
   for(const event of registry.events.filter(v=>v.event==='EXIT')){
    const envelopeFile=join(e.registryDirectory,event.componentId+'-launch.private.json'),envelope=await json(envelopeFile),result=await json(join(e.registryDirectory,event.componentId+'-result.private.json')),stop=registry.events.find(v=>v.event==='STOP_INTENT'&&v.componentId===event.componentId),closed=registry.events.find(v=>v.event==='CLOSED'&&v.componentId===event.componentId);
    assert(stop&&closed);assert.equal(event.code,0);assert.equal(event.signal,null);assert.equal(result.pid,event.pid);assert.equal(result.parentPid,e.pid);assert.equal(result.ownerId,trust.ownerId);assert.equal(result.challengeSha256,createHash('sha256').update(envelope.challenge).digest('hex'));
    assert.equal(result.configSha256,envelope.configSha256);assert.equal(result.manifestSha256,envelope.manifestSha256);assert.equal(result.requestId,stop.requestId);assert.equal(closed.requestId,stop.requestId);assert(result.normalClose);
    await retired(event.pid,[envelopeFile],new Date(event.at).toISOString());members++;
   }
   assert.equal(members,proof.membersCreated);summary.applicationMembersRetired+=members;
   await retired(e.pid,['runtime-application-suite-v2.mjs'],exit.observedAt);summary.applicationRootsRetired++;
  }
  summary.resourcesRetired++;
 }
 for(const c of r.platformCoreCancellation?.cases??[]){
  assert(c.result.normal&&c.result.startupCancelled&&c.result.allOwnedResourcesRetired&&!c.result.fullyReady);assert.equal(c.result.phase,'CLOSED');assert(!c.readyResolved);assert.equal(c.readyRejected,'PLATFORM_DEPENDENCY_START_CANCELLED');
  assert(c.noFurtherComponentsCreated&&c.noPlatformReadyEvent&&c.reverseNormalRetirement&&!c.genericKillUsed);
  const events=[];for(const name of (await readdir(c.controllerDirectory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort())events.push(await json(join(c.controllerDirectory,name)));
  assert(!events.some(e=>e.event==='PLATFORM_READY'));assert.equal(events.at(-1).event,'CLOSED');assert.equal(events.at(-1).requestId,c.result.requestId);
  assert.deepEqual(events.filter(e=>e.event==='COMPONENT_CREATED').map(e=>e.id),c.observedBeforeCancellation.components.map(e=>e.id));
  assert.deepEqual(events.filter(e=>e.event==='COMPONENT_RETIRED').map(e=>e.id),c.observedBeforeCancellation.components.map(e=>e.id).reverse());
  assert.equal(c.resources.length,c.observedBeforeCancellation.components.length);assert.equal(c.result.componentsCreated,c.resources.length);
  for(const resource of c.resources){
   assert(rows.some(e=>e.stage===c.stage&&e.pid===resource.pid&&e.directory===resource.directory));
   assert.deepEqual(await json(join(resource.directory,'normal-stop-proof.json')),resource.proof);
  }
  summary.casesVerified++;
 }
 if(r.passed){
  assert(r.platformCoreCancellation?.completed);assert.deepEqual(r.platformCoreCancellation.cases.map(c=>[c.stage,c.method,c.resources.length]),[['pg','ABORT_SIGNAL',1],['id','EXPLICIT_CLOSE',3],['app','EXPLICIT_CLOSE',5]]);
  assert.equal(summary.resourcesRetired,9);assert.equal(summary.postgresNormalStops,5);assert.equal(summary.identityNormalStops,2);assert.equal(summary.workflowNormalStops,1);assert.equal(summary.applicationRootsRetired,1);assert(summary.applicationMembersRetired>0&&summary.applicationMembersRetired<9);assert.equal(summary.casesVerified,3);
 }
 return summary;
}
