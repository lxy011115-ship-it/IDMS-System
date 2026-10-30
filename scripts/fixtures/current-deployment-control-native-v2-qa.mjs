import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {privateNewFile} from '../backup-support.mjs';
import {reviewSourceHashV1 as hash} from '../workflow-review-source-facts-v1.mjs';
import {readRuntimeColdReviewWithFieldSourceV2} from '../runtime-cold-readonly-control-v7.mjs';
import {coldReviewJavaConfigV3} from '../runtime-cold-review-credentials-v3.mjs';
import {createColdCurrentDeploymentControlV1,readColdCurrentDeploymentControlPrivateV1} from '../cold-current-deployment-control-v1.mjs';
import {createColdCurrentDeploymentUserIntentGateV1,currentDeploymentUserActionV1} from '../cold-current-deployment-user-intent-v1.mjs';
import {currentDeploymentReviewPurposeV1} from '../cold-current-deployment-review-contract-v1.mjs';
import {exerciseCurrentDeploymentControlOnOriginalSourceQaV1} from './current-deployment-control-native-v1-qa.mjs';

/** New complete case only. Actual isolated Keycloak users, no new reader or business authority. */
export async function exerciseCurrentDeploymentControlAndUserOnOriginalSourceQaV2({config,currentWork,files,readerBuild,peerTools,currentActors,readerOrigin}){
  const metadata=await exerciseCurrentDeploymentControlOnOriginalSourceQaV1({config,currentWork,files,readerBuild,peerTools});
  const before=await readRuntimeColdReviewWithFieldSourceV2(config.trust),sourceBytes=canonical(before.source),oldBytes=canonical(before.details.review),workDirectory=join(currentWork,'current-deployment');
  const construction={trust:config.trust,authority:config.authority,workDirectory,targetDirectory:before.details.targetDirectory,host:config.account.host,port:config.account.port,deploymentSha256:hash(await readFile(files.coreMaterialConfiguration.configurationFile)),programInventorySha256:hash(metadata.programInputInventory)},control=createColdCurrentDeploymentControlV1(construction);
  let privateValue,gate,rows;
  try{
    const statusRequest={reviewId:metadata.prepared.reviewId,operationId:metadata.prepared.operationId,expectedIntentSha256:metadata.prepared.intentSha256};privateValue=await readColdCurrentDeploymentControlPrivateV1(control,statusRequest);
    const newRuntime=coldReviewJavaConfigV3(privateValue.privateRecord.readerCredentials);rows=await currentActors.participants(newRuntime,readerOrigin);
    const request={purpose:currentDeploymentReviewPurposeV1,...statusRequest,confirmations:rows.map(row=>({tenantId:row.configuration.tenantId,confirmationId:randomUUID(),confirmedAt:new Date().toISOString(),action:currentDeploymentUserActionV1,expectedSourceHash:config.trust.sourceHash,expectedFullFactsSha256:before.source.fullFacts.sha256,expectedDeploymentSha256:construction.deploymentSha256,expectedProgramInventorySha256:construction.programInventorySha256,accessToken:row.authorAccessToken}))};
    await privateNewFile(join(workDirectory,'user-request.private.json'),canonical(request));
    gate=createColdCurrentDeploymentUserIntentGateV1({context:privateValue.context,privateRecord:privateValue.privateRecord,expectedIntentSha256:statusRequest.expectedIntentSha256,authority:config.authority,participants:rows.map(v=>v.configuration)});
    await assert.rejects(async()=>gate.authorize({...request,purpose:'RESTORE_ORIGINAL_SYSTEM_READ_ONLY_SUBMISSION'}),/CURRENT_DEPLOYMENT_USER_REQUEST/);
    const handle=await gate.authorize(request),proof=gate.inspect(handle),revalidated=await gate.revalidate(handle);assert.deepEqual(revalidated,proof);
    assert.equal(proof.intentSha256,statusRequest.expectedIntentSha256);assert.equal(proof.sourceHash,config.trust.sourceHash);assert.equal(proof.sourceFullFactsSha256,before.source.fullFacts.sha256);assert.equal(proof.programInventorySha256,construction.programInventorySha256);assert.equal(proof.confirmations.length,before.source.readerContract.readers.length);assert(proof.actualCurrentUsersAuthenticated&&proof.allSourceTenantsExplicitlyRequested);assert.equal(new Set(proof.confirmations.map(v=>v.actor.actorId)).size,proof.confirmations.length);
    for(const row of proof.confirmations){assert.equal(row.actor.tenantId,row.tenantId);assert.equal(row.actor.purpose,'AUTHOR');assert.equal(hash(request.confirmations.find(v=>v.tenantId===row.tenantId).accessToken),row.actor.tokenSha256);}
    for(const key of ['durableConsentRecorded','ownedRuntimeSessionMinted','allCurrentTargetFactsRechecked','programStartupGranted','mqttApplicationProbeGranted','independentApprovalGranted','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'])assert.equal(proof[key],false);
    assert.throws(()=>gate.inspect({...handle}),/CURRENT_DEPLOYMENT_USER_HANDLE_NOT_MINTED/);await assert.rejects(gate.authorize(request),/CURRENT_DEPLOYMENT_USER_GATE_CONSUMED/);
    const after=await readRuntimeColdReviewWithFieldSourceV2(config.trust);assert.equal(canonical(after.source),sourceBytes);assert.equal(canonical(after.details.review),oldBytes);
    const result={...metadata,newCurrentUserIntent:{proof,revalidated,actualIsolatedKeycloakUsersVerified:true,allSourceTenantsCovered:true,oldPurposeRejected:true,publicProofAndCopiedHandleCannotAuthorize:true,newPurposeReaderCredentialConfigUsed:true,workflowHttpOrNewReaderUsed:false,originalSourceAndOldReadOnlyIntentUnchanged:true,durableConsentRecorded:false,newOwnedHeldCreated:false,programStartupGranted:false,mqttApplicationProbeGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false}};
    await privateNewFile(join(workDirectory,'control-user-native-result.private.json'),canonical(result));return result;
  }finally{
    let failure;for(const close of [()=>gate?.close(),()=>control.close()])try{await close();}catch(error){failure??=error;}if(privateValue){privateValue.privateRecord.journalKey='';privateValue.privateRecord.readerCredentials.key='';for(const reader of privateValue.privateRecord.readerCredentials.readers){reader.password='';reader.token='';}}for(const row of rows??[]){row.authorAccessToken='';row.reviewerAccessToken='';row.contributorAccessTokens.fill('');row.configuration.identityReader.clientSecret='';row.configuration.workflow.recoveryReadToken='';}if(failure)throw failure;
  }
}
