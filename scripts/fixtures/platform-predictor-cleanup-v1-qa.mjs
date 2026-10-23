import assert from 'node:assert/strict';
import {join} from 'node:path';
import {lstat,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');

export async function verifyPlatformPredictorRootQaV1({row:e,json,retired}){
 const intent=await json(join(e.directory,'launch.private.json')),proof=await json(join(e.directory,'normal-stop-proof.json')),terminal=await json(join(e.directory,'terminal-proof.json')),exit=await json(join(e.directory,'exit-observation.json')),child=await json(join(e.directory,'child-terminal.private.json'));
 assert.equal(exit.owner,intent.owner);assert.equal(exit.pid,e.pid);assert.equal(exit.code,0);assert.equal(exit.signal,null);assert.equal(proof.owner,intent.owner);assert.equal(proof.pid,e.pid);assert(proof.normalClose&&proof.allOwnedTerminalProven&&proof.serverClosed&&proof.stopAccepted&&!proof.genericKillUsed);assert.deepEqual(proof,terminal);assert.equal(child.requestId,proof.requestId);assert.equal(child.owner,intent.owner);assert.equal(child.pid,e.pid);assert.equal(child.parentPid,intent.parentPid);assert.equal(child.challengeSha256,hash(intent.challenge));assert.equal(child.runtimeSha256,intent.runtime.sha256);assert.equal(child.nodeSha256,intent.node.sha256);assert(child.normalClose&&child.serverClosed);assert.equal(hash(await readFile(join(e.directory,'child-terminal.private.json'))),proof.childTerminalSha256);assert.equal(proof.stats.active,0);assert.equal(proof.stats.started,proof.stats.finished+proof.stats.aborted);assert.deepEqual(child.stats,proof.stats);
 const stop=await json(join(e.directory,'stop-intent.json')),accepted=await json(join(e.directory,'child-stop-accepted.private.json'));assert.equal(stop.requestId,proof.requestId);assert.equal(accepted.requestId,proof.requestId);assert.equal(accepted.owner,intent.owner);assert.equal(accepted.pid,e.pid);
 await retired(e.pid,[join(e.directory,'launch.private.json')],exit.observedAt);return proof;
}

/** Independently read persisted sixth-dependency and its two platform-fault cases. */
export async function verifyPlatformPredictorCleanupQaV1({report:r,json,retired}){
 const normal=r.platformCore?.resources.find(e=>e.kind==='PREDICTOR');assert(normal);const normalProof=await verifyPlatformPredictorRootQaV1({row:normal,json,retired});assert.deepEqual(normalProof,normal.proof);assert(normalProof.readyBeforeStop&&normalProof.listenerStarted&&normalProof.stats.finished>=2);assert(r.platformCore.originalPredictorRetired.actualOriginalHandle&&r.platformCore.originalPredictorRetired.normalExit);assert.equal(r.platformCore.predictions.length,2);assert.deepEqual(r.platformCore.predictions.map(v=>v.tenant).sort(),['acme','sandbox']);
 const rows=r.corePredictorFaultResources??[],summary={positivePredictorNormalStops:1,faultPredictorNormalStops:0,resourcesRetired:0,postgresNormalStops:0,identityNormalStops:0,workflowNormalStops:0,poolClosures:0,applicationRootsRetired:0,applicationMembersRetired:0,casesVerified:0};
 for(const e of rows){
  const exit=await json(join(e.directory,'exit-observation.json'));assert.equal(exit.pid,e.pid);assert.equal(exit.code,0);assert.equal(exit.signal,null);
  if(e.kind==='PREDICTOR'){const proof=await verifyPlatformPredictorRootQaV1({row:e,json,retired});assert.deepEqual(proof,e.retirementProof);summary.faultPredictorNormalStops++;}
  else if(e.kind==='POSTGRES'){
   const proof=await json(join(e.directory,'normal-stop-proof.json'));assert.deepEqual(proof,e.retirementProof);assert(proof.helperReplyConfirmed&&proof.terminal.proofSaved);assert.equal(proof.control.state,'shut down');assert.equal(proof.control.systemIdentifier,e.binding.systemIdentifier);assert.equal(proof.otherClientsBefore,0);assert.equal(proof.preparedTransactionsBefore,0);await assert.rejects(lstat(join(e.binding.dataDirectory,'postmaster.pid')),{code:'ENOENT'});await retired(e.pid,[e.binding.dataDirectory],exit.observedAt);summary.postgresNormalStops++;
  }else if(e.kind==='IDENTITY'||e.kind==='WORKFLOW'){
   const proof=await json(join(e.directory,'normal-stop-proof.json'));assert.deepEqual(proof,e.retirementProof);assert(proof.helperReplyConfirmed&&!proof.targetSignalSent);assert.equal(proof.binding.owner,e.binding.owner);assert.equal(exit.owner,e.binding.owner);await retired(e.pid,[e.binding.owner],exit.observedAt);
   if(e.kind==='IDENTITY')summary.identityNormalStops++;else{assert(proof.gracefulWebCompleted&&proof.poolCallbacksLogged);assert.equal(proof.expectedPoolClosures,6);summary.workflowNormalStops++;summary.poolClosures+=6;}
  }else{
   assert.equal(e.kind,'APPLICATIONS');const proof=await json(join(e.directory,'normal-stop-proof.json'));assert.deepEqual(proof,e.retirementProof);assert(proof.normalFullGroup&&proof.allOwnedTerminalProven);const trust=await json(join(e.registryDirectory,'trust.json')),registry=await readApplicationRegistryV1(trust);assert.equal(registry.header.ownerPid,e.pid);assert.equal(registry.events.at(-1).event,'GROUP_CLOSED');let members=0;
   for(const event of registry.events.filter(v=>v.event==='EXIT')){const file=join(e.registryDirectory,event.componentId+'-launch.private.json'),envelope=await json(file),result=await json(join(e.registryDirectory,event.componentId+'-result.private.json')),stop=registry.events.find(v=>v.event==='STOP_INTENT'&&v.componentId===event.componentId),closed=registry.events.find(v=>v.event==='CLOSED'&&v.componentId===event.componentId);assert.equal(event.code,0);assert.equal(event.signal,null);assert(result.normalClose&&stop&&closed);assert.equal(result.pid,event.pid);assert.equal(result.parentPid,e.pid);assert.equal(result.ownerId,trust.ownerId);assert.equal(result.challengeSha256,hash(envelope.challenge));assert.equal(result.configSha256,envelope.configSha256);assert.equal(result.manifestSha256,envelope.manifestSha256);assert.equal(result.requestId,stop.requestId);assert.equal(closed.requestId,stop.requestId);await retired(event.pid,[file],event.at);members++;}
   assert.equal(members,9);assert.equal(proof.membersCreated,9);assert.equal(proof.membersTerminal,9);await retired(e.pid,['runtime-application-suite-v2.mjs'],exit.observedAt);summary.applicationRootsRetired++;summary.applicationMembersRetired+=members;
  }
  summary.resourcesRetired++;
 }
 for(const c of r.platformPredictorFaults?.cases??[]){
  assert(c.result.allOwnedResourcesRetired&&!c.result.normal&&c.result.fullyReady);assert.equal(c.result.componentsCreated,6);assert.equal(c.result.phase,'FAILED');assert(c.ingressActuallyClosed&&c.originalRuntimeBytesRestored&&c.sameRequestRetained&&!c.genericKillUsed&&!c.normalPlatformShutdownClaimed);
  if(c.stage==='predictor-config'){assert(c.blockedResult&&c.allEarlierDependenciesUnsignalledWhileBlocked);assert.equal(c.blockedResult.requestId,c.result.requestId);assert.equal(c.blockedResult.blocked[0].errorCode,'PREDICTOR_INPUT_CHANGED');}else{assert.equal(c.stage,'unexpected-predictor');assert(c.actorProof.normalClose);}
  const events=[];for(const f of(await readdir(c.controllerDirectory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort())events.push(await json(join(c.controllerDirectory,f)));assert.equal(events.at(-1).event,'FAILED');const retiredEvents=events.filter(e=>e.event==='COMPONENT_RETIRED');assert.equal(retiredEvents.length,6);assert.deepEqual(retiredEvents.filter(e=>!e.normal).map(e=>e.kind),c.stage==='unexpected-predictor'?['PREDICTOR']:[]);summary.casesVerified++;
 }
 if(r.passed){assert(r.platformPredictorFaults.completed);assert.deepEqual(r.platformPredictorFaults.cases.map(c=>c.stage),['predictor-config','unexpected-predictor']);assert.equal(summary.casesVerified,2);assert.equal(summary.resourcesRetired,12);assert.equal(summary.postgresNormalStops,4);assert.equal(summary.identityNormalStops,2);assert.equal(summary.workflowNormalStops,2);assert.equal(summary.faultPredictorNormalStops,2);assert.equal(summary.applicationRootsRetired,2);assert.equal(summary.applicationMembersRetired,18);}
 return summary;
}
