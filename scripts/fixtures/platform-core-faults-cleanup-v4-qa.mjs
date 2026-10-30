import {verifyPlatformPredictorRootQaV1} from './platform-predictor-cleanup-v1-qa.mjs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {readApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');

export async function verifyCoreFaultsCleanupQaV4({report:r,json,retired}){
 const rows=r.coreFaultResources??[],summary={predictorNormalStops:0,resourcesRetired:0,postgresNormalStops:0,identityNormalStops:0,workflowNormalStops:0,poolClosures:0,applicationRootsRetired:0,normalApplicationRoots:0,abnormalApplicationRoots:0,applicationMembersRetired:0,normalApplicationMembers:0,abnormalApplicationMembers:0,terminalReinspectionsVerified:0,casesVerified:0};
 for(const e of rows){
  const exit=await json(join(e.directory,'exit-observation.json'));assert.equal(exit.pid,e.pid);assert.equal(exit.signal,null);
  if(e.kind==='POSTGRES'){
   const proof=await json(join(e.directory,'normal-stop-proof.json'));assert.deepEqual(proof,e.retirementProof);assert(proof.helperReplyConfirmed&&proof.terminal.proofSaved);assert.equal(exit.code,0);assert.equal(proof.terminal.code,0);assert.equal(proof.terminal.signal,null);assert.equal(proof.control.state,'shut down');assert.equal(proof.control.systemIdentifier,e.binding.systemIdentifier);assert.equal(proof.otherClientsBefore,0);assert.equal(proof.preparedTransactionsBefore,0);
   await assert.rejects(lstat(join(e.binding.dataDirectory,'postmaster.pid')),{code:'ENOENT'});await retired(e.pid,[e.binding.dataDirectory],exit.observedAt);summary.postgresNormalStops++;
  }else if(e.kind==='WORKFLOW'||e.kind==='IDENTITY'){
   const proof=await json(join(e.directory,'normal-stop-proof.json'));assert.deepEqual(proof,e.retirementProof);assert.equal(exit.code,0);assert(proof.helperReplyConfirmed&&!proof.targetSignalSent);assert.equal(proof.binding.owner,e.binding.owner);assert.equal(exit.owner,e.binding.owner);await retired(e.pid,[e.binding.owner],exit.observedAt);
   if(e.kind==='WORKFLOW'){assert(proof.gracefulWebCompleted&&proof.poolCallbacksLogged);assert.equal(proof.expectedPoolClosures,6);summary.workflowNormalStops++;summary.poolClosures+=6;}else summary.identityNormalStops++;
  }else if(e.kind==='PREDICTOR'){const proof=await verifyPlatformPredictorRootQaV1({row:e,json,retired});assert.deepEqual(proof,e.retirementProof);summary.predictorNormalStops++;}
  else{
   assert.equal(e.kind,'APPLICATIONS');const original=await json(join(e.directory,'terminal-proof.json')),trust=await json(join(e.registryDirectory,'trust.json')),registry=await readApplicationRegistryV1(trust),launch=await json(join(e.directory,'launch-intent.json'));
   assert.equal(registry.header.ownerPid,e.pid);assert(registry.lifecycle.terminal&&registry.lifecycle.groupReady);assert.equal(hash(canonical(registry.header.manifest)),launch.manifestSha256);
   let proof=original;
   if(e.stage==='application-config'){
    assert.equal(exit.code,1);assert(!original.allOwnedTerminalProven);const file=await json(join(e.directory,'retirement-reinspection.private.json'));assert.equal(file.owner,original.owner);assert.equal(file.pid,e.pid);assert.deepEqual(file.observedExit,original.exit);assert.equal(file.originalProofSha256,hash(canonical(original)));assert(file.proof.allOwnedTerminalProven&&!file.proof.normalFullGroup&&!file.proof.startupCancelled);proof=file.proof;summary.terminalReinspectionsVerified++;summary.abnormalApplicationRoots++;
   }else{assert.equal(exit.code,0);assert(original.normalFullGroup&&original.allOwnedTerminalProven);assert.deepEqual(await json(join(e.directory,'normal-stop-proof.json')),original);summary.normalApplicationRoots++;}
   assert.deepEqual(proof,e.retirementProof);let members=0;
   for(const event of registry.events.filter(v=>v.event==='EXIT')){
    const envelopeFile=join(e.registryDirectory,event.componentId+'-launch.private.json'),envelope=await json(envelopeFile),result=await json(join(e.registryDirectory,event.componentId+'-result.private.json')),closed=registry.events.find(v=>v.event==='CLOSED'&&v.componentId===event.componentId),stop=registry.events.find(v=>v.event==='STOP_INTENT'&&v.componentId===event.componentId);
    assert.equal(event.signal,null);assert.equal(result.pid,event.pid);assert.equal(result.parentPid,e.pid);assert.equal(result.ownerId,trust.ownerId);assert.equal(result.challengeSha256,hash(envelope.challenge));assert.equal(result.configSha256,envelope.configSha256);assert.equal(result.manifestSha256,envelope.manifestSha256);
    if(result.normalClose){assert.equal(event.code,0);assert(closed&&stop);assert.equal(result.requestId,stop.requestId);assert.equal(closed.requestId,stop.requestId);summary.normalApplicationMembers++;}
    else{assert.equal(e.stage,'application-config');assert.equal(event.code,1);assert(['APPLICATION_CONFIG_CHANGED','APPLICATION_FILE_CHANGED'].includes(result.errorCode));summary.abnormalApplicationMembers++;}
    await retired(event.pid,[envelopeFile],new Date(event.at).toISOString());members++;
   }
   assert.equal(members,9);assert.equal(proof.membersCreated,9);assert.equal(proof.membersTerminal,9);summary.applicationMembersRetired+=members;summary.applicationRootsRetired++;await retired(e.pid,['runtime-application-suite-v2.mjs'],exit.observedAt);
  }
  summary.resourcesRetired++;
 }
 for(const c of r.platformCoreFaults?.cases??[]){
  assert(c.result.allOwnedResourcesRetired&&!c.result.normal&&c.result.fullyReady);assert.equal(c.result.phase,'FAILED');assert.equal(c.result.componentsCreated,6);assert(!c.genericKillUsed&&!c.normalServiceShutdownClaimed&&c.originalConfigurationBytesRestored&&c.sameRequestRetained&&c.ingressActuallyClosed);
  if(c.stage!=='unexpected-workflow'){assert(c.blockedResult&&!c.blockedResult.allOwnedResourcesRetired);assert.equal(c.pgHelpersBeforeUnblock,0);assert.equal(c.result.requestId,c.blockedResult.requestId);}
  if(c.stage==='application-config'){assert(c.preflightRejectedWhileApplicationLive&&c.firstTerminalUnproven);assert.equal(c.failureCode,'PLATFORM_APPLICATION_ABNORMAL_RETIREMENT');}
  if(c.stage==='workflow-config'){assert(['PLATFORM_DEPENDENCY_INPUT_CHANGED','APPLICATION_FILE_CHANGED'].includes(c.failureCode));assert(c.ownedCopyAudit?.changedBeforeStopPreflight&&c.ownedDeploymentCopyBytesRestored);assert.equal(hash(await readFile(c.ownedCopyAudit.path)),c.ownedCopyAudit.expectedSha256);}
  if(c.stage==='unexpected-workflow'){assert(c.unexpectedDependencyExit&&c.actorWorkflowProof.helperReplyConfirmed&&!c.actorWorkflowProof.targetSignalSent);assert.equal(c.failureCode,'PLATFORM_DEPENDENCY_UNEXPECTED_EXIT');}
  const events=[];for(const name of(await readdir(c.controllerDirectory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort())events.push(await json(join(c.controllerDirectory,name)));
  assert.equal(events.at(-1).event,'FAILED');const retirements=events.filter(v=>v.event==='COMPONENT_RETIRED');assert.equal(retirements.length,6);
  const abnormal=retirements.filter(v=>!v.normal).map(v=>v.kind);assert.deepEqual(abnormal,c.stage==='application-config'?['APPLICATIONS']:c.stage==='unexpected-workflow'?['WORKFLOW']:[]);
  for(const resource of c.resources)assert(rows.some(v=>v.stage===c.stage&&v.pid===resource.pid&&v.directory===resource.directory));summary.casesVerified++;
 }
 if(r.passed){assert(r.platformCoreFaults?.completed);assert.deepEqual(r.platformCoreFaults.cases.map(c=>c.stage),['workflow-config','application-config','unexpected-workflow']);assert.equal(summary.casesVerified,3);assert.equal(summary.resourcesRetired,18);assert.equal(summary.predictorNormalStops,3);assert.equal(summary.postgresNormalStops,6);assert.equal(summary.identityNormalStops,3);assert.equal(summary.workflowNormalStops,3);assert.equal(summary.applicationRootsRetired,3);assert.equal(summary.applicationMembersRetired,27);assert.equal(summary.terminalReinspectionsVerified,1);assert.equal(summary.normalApplicationRoots,2);assert.equal(summary.abnormalApplicationRoots,1);assert.equal(summary.normalApplicationMembers+summary.abnormalApplicationMembers,27);}
 return summary;
}
