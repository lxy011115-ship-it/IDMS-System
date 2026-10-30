import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {launchApplicationLifecycleV4,bindApplicationLifecycleV4,stopApplicationLifecycleV4,captureOwnedApplicationFieldSourceV1,inspectOwnedApplicationFieldSourceV1,closeOwnedApplicationFieldSourceV1} from '../application-lifecycle-v4.mjs';
import {createOwnedCurrentWorkflowReaderSourceV1,revalidateOwnedCurrentWorkflowReaderSourceV1,closeOwnedCurrentWorkflowReaderSourceV1} from '../workflow-current-source-v1.mjs';
import {createRuntimeColdControlWithReaderSourceV1,readRuntimeColdControlWithReaderSourceV1} from '../runtime-cold-control-reader-source-v1.mjs';
import {createRuntimeColdReviewWithFieldSourceV2,readRuntimeColdReviewWithFieldSourceV2} from '../runtime-cold-readonly-control-v7.mjs';
import {createRuntimeMaintenanceV1,RuntimeMaintenanceControlV1} from '../runtime-maintenance-control-v1.mjs';

const json=async p=>JSON.parse(await readFile(p,'utf8'));
/** Actual stopped owner capabilities and existing installed roles only; creates historical SOURCE, not activation. */
export async function exerciseFieldColdSourceCreationQaV1({cluster,work,identity,site,recovered,active,retired,enabledSource,children,report,note,retireApplication}){
 assert(enabledSource?.capability&&enabledSource.manifestFile);
 const prior=await readRuntimeColdControlWithReaderSourceV1(recovered.trust);assert.equal(prior.phase,'ADMITTED');assert.equal(prior.source.readerSourceContract.readers.length,2);
 assert.deepEqual(prior.source.readerSourceContract.readers.map(r=>r.facts.tenantId).sort(),['acme','sandbox']);
 const stage={format:'FIELD_COLD_SOURCE_CREATION_ACTUAL_V1',checks:[],priorTrust:recovered.trust,sources:[],currentFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};report.fieldColdSourceCreation=stage;
 const done=name=>{stage.checks.push(name);note(name);};
 let disabledManager,disabledOwner,currentReader,requestId=randomUUID(),disabledStop;
 try{
  const original=await json(enabledSource.manifestFile),oldSite=original.components.find(c=>c.kind==='SITE'),originalSiteFile=resolve(dirname(enabledSource.manifestFile),oldSite.runtimeFile),siteConfig=await json(originalSiteFile);
  siteConfig.field={enabled:false};const disabledSite=join(work,'source-disabled-site.private.json');await privateNewFile(disabledSite,canonical(siteConfig));
  const manifest=structuredClone(original);manifest.field={enabled:false};manifest.registryDirectory=join(work,'source-disabled-registry');manifest.components.find(c=>c.kind==='SITE').runtimeFile=disabledSite;
  const manifestFile=join(work,'source-disabled-manifest.private.json'),records=join(work,'source-disabled-records');await privateDirectory(records);await privateNewFile(manifestFile,canonical(manifest));
  disabledManager=await launchApplicationLifecycleV4({manifestFile,workDirectory:records});children.push({process:disabledManager.process,script:'scripts/runtime-application-suite-v3.mjs',lifecycle:disabledManager,lifecycleVersion:4,terminal:disabledManager.terminal});report.children.push({pid:disabledManager.process.pid,script:'scripts/runtime-application-suite-v3.mjs'});
  await bindApplicationLifecycleV4(disabledManager);disabledStop=await stopApplicationLifecycleV4(disabledManager,{requestId});assert(disabledStop.normalFullGroup&&disabledStop.allOwnedResourcesRetired&&disabledStop.allOwnedTerminalProven);
  disabledOwner=await captureOwnedApplicationFieldSourceV1(disabledManager);const disabledEvidence=await inspectOwnedApplicationFieldSourceV1(disabledOwner);assert.equal(disabledEvidence.siteFieldEnabled,false);assert.deepEqual(disabledEvidence.tenantIds,['acme','sandbox']);stage.disabledOwnerEvidence=disabledEvidence;stage.disabledManagerTerminal=disabledStop;stage.disabledManifestFile=manifestFile;stage.disabledManagerDirectory=disabledManager.directory;
  done('new original nine-child manager explicitly declares FIELD disabled, reaches READY and retires normally before its own source capability is captured');
  await retireApplication();await site.flow.quiesce();await site.qa.detach();
  const maintenanceDirectory=join(work,'field-source-maintenance'),maintenanceTrust=await createRuntimeMaintenanceV1(maintenanceDirectory,active),maintenance=new RuntimeMaintenanceControlV1(cluster.account,maintenanceTrust,active),operationId=randomUUID();await maintenance.prepare({operationId,expectedRevision:0});const closedReceipt=await maintenance.close({operationId});assert.equal(closedReceipt.databases.length,active.length);stage.maintenanceTrust=maintenanceTrust;stage.maintenanceOperationId=operationId;stage.closedReceipt=closedReceipt;
  const readerIds=prior.source.readerSourceContract.readers.map(r=>r.facts.role.oid),registeredBusinessRoleOids=prior.source.inventory.roles.map(r=>r.oid).filter(id=>!readerIds.includes(id));
  const originalWorker=await json(site.workers.sandbox),jvmProofFiles=site.flow.children.map(h=>join(h.directory,'normal-stop-proof.json'));
  for(const [mode,owner]of[['ENABLED',enabledSource.capability],['EXPLICIT_DISABLED',disabledOwner]]){
   const evidence=await inspectOwnedApplicationFieldSourceV1(owner);assert.equal(evidence.siteFieldEnabled,mode==='ENABLED');currentReader=await createOwnedCurrentWorkflowReaderSourceV1(owner);
   await assert.rejects(revalidateOwnedCurrentWorkflowReaderSourceV1({...currentReader},owner),/CURRENT_READER_SOURCE_CAPABILITY/);
   const trust=await createRuntimeColdReviewWithFieldSourceV2(join(work,'field-source-'+mode.toLowerCase()),{currentReaderSourceCapability:currentReader,fieldSourceCapability:owner,account:cluster.account,active,retired,registeredBusinessRoleOids,maintenanceTrust,operationId,authRuntimeFile:originalWorker.authRuntimeFile,authority:identity.runtime,jvmProofFiles});
   const state=await readRuntimeColdReviewWithFieldSourceV2(trust);assert.equal(state.phase,'PREPARED');assert.equal(state.source.fieldSource.ownerEvidence.siteFieldEnabled,mode==='ENABLED');assert.equal(state.source.fieldSource.configuredTenants.length,mode==='ENABLED'?1:0);assert.equal(state.source.fieldSource.fieldMaps.length,2);assert.equal(state.source.readerContract.readers.length,2);
   assert.equal(state.source.readerSourceLineage.originalReaderContractSha256,prior.source.readerSourceContract.sha256);assert.equal(state.source.readerSourceLineage.originalSourceHash,recovered.trust.sourceHash);assert.equal(state.source.readerSourceLineage.sourceOwnerCaptureId,owner.captureId);assert.equal(state.source.readerSourceLineage.actualSqlRolePrivilegesAndHbaRecaptured,true);assert.equal(state.source.inventory.identity.system_id,prior.source.inventory.identity.system_id);
   assert.deepEqual(state.source.readerContract.readers.map(r=>r.facts.role.oid),prior.source.readerSourceContract.readers.map(r=>r.facts.role.oid));assert.equal(state.source.readerContract.hba.sha256,prior.source.readerSourceContract.hba.sha256);assert.equal(state.source.fieldSource.currentFieldMaterialsVerified,false);assert.equal(state.source.fieldSource.formalFieldActivationGranted,false);
   stage.sources.push({mode,trust,fieldSourceSha256:state.source.fieldSource.sha256,readerContractSha256:state.source.readerContract.sha256,readerSourceLineage:state.source.readerSourceLineage,fullFactsSha256:state.source.fullFacts.sha256,databases:state.source.fullFacts.databases.length,mapTenants:state.source.fieldSource.fieldMaps.map(m=>m.binding.tenantId),configuredTenants:state.source.fieldSource.configuredTenants.map(t=>t.tenantId),actualSourceCreationExecuted:true,currentFieldMaterialsVerified:false,formalFieldActivationGranted:false});
   await closeOwnedCurrentWorkflowReaderSourceV1(currentReader);await assert.rejects(revalidateOwnedCurrentWorkflowReaderSourceV1(currentReader,owner),/CURRENT_READER_SOURCE_CAPABILITY/);currentReader=null;
   done('actual '+mode+' SOURCE first INSERT hashes the real stopped owner, both complete map histories and recaptured existing workflow role ACL/HBA without restored-target grants');
  }
  closeOwnedApplicationFieldSourceV1(enabledSource.capability);closeOwnedApplicationFieldSourceV1(disabledOwner);await assert.rejects(inspectOwnedApplicationFieldSourceV1(enabledSource.capability),/APPLICATION_FIELD_SOURCE_CAPABILITY/);await assert.rejects(inspectOwnedApplicationFieldSourceV1(disabledOwner),/APPLICATION_FIELD_SOURCE_CAPABILITY/);
  stage.allSourceCapabilitiesNormallyClosed=true;stage.initialInstallerNotRequiredAfterPhysicalRestore=true;done('both new historical SOURCE captures remain readable after all original owner and current-reader capabilities close normally');
 }finally{
  if(currentReader)await closeOwnedCurrentWorkflowReaderSourceV1(currentReader);
  closeOwnedApplicationFieldSourceV1(enabledSource.capability);if(disabledOwner)closeOwnedApplicationFieldSourceV1(disabledOwner);
  if(disabledManager&&disabledManager.process.exitCode===null&&disabledManager.process.signalCode===null)await stopApplicationLifecycleV4(disabledManager,{requestId});
  await privateNewFile(join(work,'field-cold-source-result.private.json'),canonical(stage));
 }
}
