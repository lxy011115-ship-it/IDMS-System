import test from 'node:test';
import assert from 'node:assert/strict';
import {currentWorkflowSourceInputQaV1 as input,resealCurrentWorkflowSourceQaV1 as seal} from './fixtures/workflow-current-source-v1-input.mjs';
import {validatePriorWorkflowReaderSourceV1 as validate,createOwnedCurrentWorkflowReaderSourceV1,captureOwnedCurrentWorkflowReaderSourceV1,revalidateOwnedCurrentWorkflowReaderSourceV1,closeOwnedCurrentWorkflowReaderSourceV1} from '../scripts/workflow-current-source-v1.mjs';
import {createRuntimeColdControlWithReaderSourceV1} from '../scripts/runtime-cold-control-reader-source-v1.mjs';
import {createRuntimeColdReviewWithFieldSourceV2} from '../scripts/runtime-cold-readonly-control-v7.mjs';

const check=v=>validate(v.owner,v.trust,v.state);
const denied=(change,code)=>{const v=input();change(v);seal(v);assert.throws(()=>check(v),new RegExp(code));};
test('initial V1 history projects exact original readers, without granting a current capability',()=>{
 const v=input(),r=check(v);assert.equal(r.originalReaderContractSha256,v.state.source.readerSourceContract.sha256);assert.equal(r.originalSourceHash,v.trust.sourceHash);assert.equal(r.currentSqlRecaptured,false);assert.equal(r.businessWritesEnabled,false);assert.equal(r.formalFieldActivationGranted,false);
 r.originalActive[0].actorOids.push('999');assert.equal(v.state.source.active[0].actorOids.length,2);
});
test('later V3 history retains its original reader contract and physical restore identity',()=>{
 const v=input('RUNTIME_COLD_REVIEW_SOURCE_V3'),r=check(v);assert.equal(r.targetDirectory,v.state.details.targetDirectory);assert.equal(r.systemIdentifier,v.state.source.inventory.identity.system_id);assert.deepEqual(r.originalReaderContract,v.state.source.readerContract);
});
test('missing declaration and ambiguous contract aliases are rejected despite valid source hashes',()=>{
 denied(v=>delete v.state.source.readerSourceContract,'DECLARATION_REQUIRED');
 denied(v=>v.state.source.readerContract=structuredClone(v.state.source.readerSourceContract),'AMBIGUOUS_CONTRACT');
});
test('a source digest or admitted deployment binding cannot be substituted',()=>{
 const v=input();v.trust.sourceHash='f'.repeat(64);assert.throws(()=>check(v),/ORIGINAL_CONTROL/);
 denied(v=>v.owner.originalDeploymentBinding.authorityHash='a'.repeat(64),'ORIGINAL_CONTROL');
});
test('only a normally retired full original owner and ADMITTED restore are accepted',()=>{
 for(const key of['normalFullGroup','allOwnedTerminalProven','allOwnedResourcesRetired'])denied(v=>v.owner.originalTerminal[key]=false,'ORIGINAL_OWNER');
 denied(v=>v.owner.originalTerminal.exit.signal='SIGTERM','ORIGINAL_OWNER');
 denied(v=>v.state.phase='HELD','ORIGINAL_CONTROL');
});
test('archive authentication, full file verification, backup, system and restored target stay bound',()=>{
 for(const key of['fullArchiveAuthenticationVerified','fullFileHashesVerified'])denied(v=>v.state.details.restore[key]=false,'ORIGINAL_RESTORE');
 denied(v=>v.state.details.restore.backupId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ORIGINAL_RESTORE');
 denied(v=>v.state.details.restore.systemIdentifier='7000000000000000001','ORIGINAL_RESTORE');
 denied(v=>v.state.details.restore.directory=v.state.source.inventory.identity.directory,'ORIGINAL_RESTORE');
});
test('tenant coverage and the original installation identity must be complete',()=>{
 denied(v=>v.owner.tenantIds.push('second'),'TENANT_COVERAGE');
 denied(v=>v.state.source.readerSourceContract.installationId='caller-value','TENANT_COVERAGE');
});
test('reader role OIDs and directory cannot be replaced while retaining old inventory',()=>{
 denied(v=>v.state.source.readerSourceContract.readers[0].facts.role.oid='103','CAPTURE_PROFILE');
 denied(v=>v.state.source.readerSourceContract.sourceDirectory=v.state.details.targetDirectory,'CAPTURE_ROLE_FACTS');
});
test('initial reader control, workflow authority, fence and registered actor remain bound',()=>{
 for(const change of[
  v=>v.state.source.readerSourceContract.readers[0].facts.identity.current_oid='99',
  v=>v.state.source.readerSourceContract.readers[0].facts.identity.standby=true,
  v=>v.state.source.readerSourceContract.readers[0].facts.fence.ownerOid='999',
  v=>v.state.source.readerSourceContract.readers[0].facts.authorityId='caller-authority',
  v=>v.state.source.readerSourceContract.readers[0].fenceBinding.actorOids=['101']
 ])denied(change,'INITIAL_READER_BINDING');
});
test('caller metadata cannot create, clone, capture, revalidate or close the production capability',async()=>{
 const fake=Object.freeze({format:'OWNED_CURRENT_WORKFLOW_READER_SOURCE_V1',captureId:'12345678-1234-1234-1234-123456789abc'});
 await assert.rejects(createOwnedCurrentWorkflowReaderSourceV1(input().owner),/FIELD_SOURCE_CAPABILITY/);
 assert.throws(()=>captureOwnedCurrentWorkflowReaderSourceV1(fake,null,{sourceOwner:{},frame:{}}),/CURRENT_READER_SOURCE_CAPABILITY/);
 await assert.rejects(revalidateOwnedCurrentWorkflowReaderSourceV1({...fake},{}),/CURRENT_READER_SOURCE_CAPABILITY/);
 assert.throws(()=>closeOwnedCurrentWorkflowReaderSourceV1(fake),/CURRENT_READER_SOURCE_CAPABILITY/);
});
test('the initial SOURCE creator rejects a self-reported installer before SQL or file creation',async()=>{
 await assert.rejects(createRuntimeColdControlWithReaderSourceV1(null,{readerInstaller:{state:()=>({prepared:true}),capture:()=>input().state.source.readerSourceContract}}),/WORKFLOW_SOURCE_REAL_INSTALLATION_REQUIRED/);
});
test('the restored SOURCE creator rejects a caller FIELD owner before SQL or file creation',async()=>{
 await assert.rejects(createRuntimeColdReviewWithFieldSourceV2(null,{fieldSourceCapability:input().owner}),/FIELD_SOURCE_CAPABILITY/);
});
