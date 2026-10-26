import {RuntimeColdReadOnlyPreparationV24} from '../runtime-cold-review-prepare-v26-request-file-v1.mjs';
import {createSharedColdCoreFieldMaterialFilesQaV2} from './cold-core-field-shared-material-files-v2-qa.mjs';
import {createColdCoreFieldParticipantsQaV1} from './cold-core-field-participants-v1-qa.mjs';
import {startFieldCurrentTransportPeersQaV3} from './field-current-transport-peers-v3-qa.mjs';
import assert from 'node:assert/strict';
import pg from 'pg';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {canonical} from '../../server/imports.ts';
import {readRuntimeColdReviewWithFieldSourceV2} from '../runtime-cold-readonly-control-v7.mjs';
import {RuntimeColdReviewV3} from '../runtime-cold-readonly-control-v5.mjs';
import {RuntimeColdReadOnlyPreparationV15} from '../runtime-cold-review-prepare-v17-request-file-v1.mjs';
import {generateColdImageKeyV1} from '../pg-cold-image-portable-v1.mjs';
import {authenticateColdReviewImageV2} from '../pg-cold-review-image-v2.mjs';
import {launchPostgresLifecycleV2,bindPostgresLifecycleV2,inspectPostgresLifecycleV2,stopPostgresLifecycleV2} from '../postgres-lifecycle-v2.mjs';
import {buildWorkflowReviewReaderV4} from '../build-workflow-review-reader-v4.mjs';
import {buildWorkflowReaderPeerToolsV1} from '../workflow-reader-peer-tools-v1-request-file-v1.mjs';
import {launchWorkflowReviewReaderV7,bindWorkflowReviewReaderV7,stopWorkflowReviewReaderV7} from '../workflow-review-reader-lifecycle-v7-request-file-v1.mjs';
import {createColdOwnedReviewSessionV1} from '../cold-owned-review-session-v3-request-file-v1.mjs';
import {createColdFieldCurrentMaterialsV4} from '../cold-field-current-materials-v4.mjs';
import {createFieldCurrentMaterialFilesQaV1} from './field-current-material-files-v1-qa.mjs';

const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
async function port(){for(let index=0;index<40;index++){const value=30000+randomBytes(2).readUInt16BE()%10000,server=createServer();try{await new Promise((ok,no)=>{server.once('error',no);server.listen({host:'127.0.0.1',port:value,exclusive:true},ok);});await new Promise((ok,no)=>server.close(error=>error?no(error):ok()));return value;}catch(error){if(!['EACCES','EADDRINUSE'].includes(error.code))throw error;}}throw Error('FIELD_CURRENT_NATIVE_PORT');}
async function end(client){if(!client)return;const stream=client.connection?.stream,closed=!stream||stream.closed?Promise.resolve():new Promise(ok=>stream.once('close',ok));await client.end();await closed;}

/** Adds real second-round read-only restores; does not grant complete admission. */
export async function exerciseColdCoreFieldCompositionNativeQaV4({work,cluster,identity,sourceCreation,workflowTools,mavenHome,localRepository,report,note,observe,reviewTransportSource,site,save}){
  const stage={format:'FIELD_CURRENT_MATERIALS_ACTUAL_NATIVE_V2',checks:[],cases:[],archives:[],sourceCaptured:false,allOwnedResourcesNormallyRetired:false,completeFieldMaterialsVerified:false,fullGoalComplete:false};report.fieldCurrentMaterialsNative=stage;
  const done=name=>{stage.checks.push(name);note(name);},directory=join(work,'review');await privateDirectory(directory);const scratch=join(directory,'scratch'),archives=join(directory,'archives');await privateDirectory(scratch);await privateDirectory(archives);
  const keyFile=join(directory,'cold-key.private.json');await generateColdImageKeyV1(keyFile);const sources=[];
  for(const item of sourceCreation.sources){const state=await readRuntimeColdReviewWithFieldSourceV2(item.trust);assert.equal(state.phase,'PREPARED');const control=new RuntimeColdReviewV3(cluster.account,item.trust,identity.runtime);await observe('FIELD_CURRENT_FREEZE',()=>control.freeze());sources.push({...item,source:state.source,control});}
  await cluster.stop();stage.sourceStopped=true;
  for(const item of sources){const backup=await observe('FIELD_CURRENT_ARCHIVE',()=>item.control.capture({sourceDirectory:item.source.inventory.identity.directory,binDirectory:cluster.bin,keyFile,workDirectory:scratch,outputDirectory:archives})),checked=await authenticateColdReviewImageV2({backupFile:backup.file,keyFile,workDirectory:scratch});try{assert.equal(checked.manifest.evidence.coldControlId,item.trust.controlId);assert.equal(checked.manifest.evidence.sourceHash,item.trust.sourceHash);item.reviewEvidence=structuredClone(checked.manifest.evidence);}finally{await checked.dispose();}stage.archives.push({mode:item.mode,trust:item.trust,backup,reviewEvidence:item.reviewEvidence});}
  stage.sourceCaptured=true;done('both new FIELD SOURCEs freeze, original source postmaster stops normally and complete reader-aware encrypted archives authenticate');
  const readerBuild=await observe('FIELD_CURRENT_READER_BUILD',()=>buildWorkflowReviewReaderV4({tools:workflowTools,mavenHome,workDirectory:directory,offline:!!localRepository,localRepository})),peerTools=await buildWorkflowReaderPeerToolsV1(directory,workflowTools);stage.readerBuild=readerBuild;const currentActors=await createColdCoreFieldParticipantsQaV1({identity,site,work,save});
  for(const item of sources){
    const currentWork=join(directory,item.mode.toLowerCase());await privateDirectory(currentWork);const target=join(currentWork,'restored');await observe('FIELD_CURRENT_RESTORE',()=>item.control.restore({targetDirectory:target,binDirectory:cluster.bin,keyFile,workDirectory:scratch}));
    const result={mode:item.mode,trust:item.trust,targetDirectory:target,configurationFile:null,recoveryId:randomUUID(),postgresDirectory:null,postgresTerminal:null,readerDirectory:null,readerTerminal:null,sessionHeld:null,sessionReleased:null,currentMaterial:null,cleanupErrors:[]};stage.cases.push(result);
    let postgres,reader,readerBound=false,session,preparation,material,sql,transport,inspector;
    try{
      const postgresWork=join(currentWork,'postgres-owner');await privateDirectory(postgresWork);postgres=await launchPostgresLifecycleV2({binDirectory:cluster.bin,dataDirectory:target,workDirectory:postgresWork,expectedSystemIdentifier:item.source.inventory.identity.system_id,port:cluster.account.port,account:{user:cluster.account.user,password:cluster.account.password,database:'postgres'},reviewEvidence:item.reviewEvidence});result.postgresDirectory=postgres.directory;result.postgresBinding=await bindPostgresLifecycleV2(postgres);done(item.mode+' separate physical review target starts through its original postmaster handle and exact SOURCE reader HBA');
      const deadline=Math.max(item.source.deadlines.tokenDeadline+item.source.verifier.clockToleranceMs,item.source.deadlines.leaseDeadline);while(Date.now()<=deadline)await pause(Math.min(1000,deadline+1-Date.now()));
      const privateWork=join(currentWork,'private');await privateDirectory(privateWork);const config={account:{...cluster.account},authority:identity.runtime,binDirectory:cluster.bin,keyFile,trust:item.trust,workDirectory:privateWork};preparation=new RuntimeColdReadOnlyPreparationV15(config);const prepared=await observe('FIELD_CURRENT_PREPARE',()=>preparation.prepare({recoveryId:result.recoveryId}));assert.equal(prepared.phase,'REVIEW_READY_V3');assert(prepared.reviewReady&&prepared.entireCurrentRootsIndependentlyRebuilt&&prepared.allOriginalSqlFactsCompared);result.reviewPrepared=prepared;
      const runtime=await preparation.readerRuntimeConfig({recoveryId:result.recoveryId}),runtimeFile=join(currentWork,'reader-runtime.private.json');await privateNewFile(runtimeFile,canonical(runtime));const httpPort=await port();reader=await launchWorkflowReviewReaderV7({tools:workflowTools,workDirectory:currentWork,jarFile:readerBuild.jar,jarSha256:readerBuild.jarSha256,runtimeFile,port:httpPort});result.readerDirectory=reader.directory;
      let ready=false;for(let index=0;index<600;index++){if(reader.process.exitCode!==null||reader.process.signalCode!==null){await reader.terminal;throw Error('FIELD_CURRENT_NATIVE_READER_EXIT');}try{const response=await fetch('http://127.0.0.1:'+httpPort+'/health',{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}await pause(100);}assert(ready,'FIELD_CURRENT_NATIVE_READER_READY');await bindWorkflowReviewReaderV7(reader);readerBound=true;
      session=await createColdOwnedReviewSessionV1({config,recoveryId:result.recoveryId,reader,peerTools});result.sessionHeld=await session.acquire();assert.equal(result.sessionHeld.guardCount,item.source.readerContract.readers.length);done(item.mode+' real prepared readonly reader and original full guard session acquire HELD');
      const files=await createSharedColdCoreFieldMaterialFilesQaV2({directory:join(currentWork,'combined-materials'),originalDirectory:work,trust:item.trust,mode:item.mode,sourceCreation,authority:identity.runtime,account:cluster.account});result.configurationFile=files.fieldMaterialConfiguration.configurationFile;result.coreConfigurationFile=files.coreMaterialConfiguration.configurationFile;result.currentAdmissionProjection=files.core.currentAdmissionProjection;
      if(item.mode==='ENABLED')transport=await startFieldCurrentTransportPeersQaV3({source:reviewTransportSource,files:files.fieldMaterialConfiguration,workDirectory:currentWork});
      inspector=new RuntimeColdReadOnlyPreparationV24({...config,coreMaterialConfiguration:files.coreMaterialConfiguration,fieldMaterialConfiguration:files.fieldMaterialConfiguration});
      const participants=await currentActors.participants(runtime,'http://127.0.0.1:'+httpPort);
      result.coreFieldReview=await observe('CORE_FIELD_CURRENT_VERIFY',()=>inspector.inspectCoreAndFieldMaterials({recoveryId:result.recoveryId,session,participants}));
      const reviewed=result.coreFieldReview;assert.equal(reviewed.format,'COLD_CORE_AND_FIELD_CURRENT_MATERIALS_REVIEW_STATUS_V1');assert(reviewed.currentCoreAndFieldMaterialsVerified&&reviewed.combinedMaterialWindow.originalWindowsNotExtended);assert.equal(reviewed.coreMaterialEvidence.roleResponsibilities.describedRoles,29);assert.equal(reviewed.coreConfiguredRoleCredentials.matchedRuntimeRoles.length,12);assert(reviewed.coreConfiguredRoleCredentials.allConfiguredRuntimePasswordsMatched&&reviewed.coreConfiguredRoleCredentials.allRegisteredReviewRoleAttributesAndMembershipsMatched);assert.equal(reviewed.retiredBackupPrivileges.length,2);assert(reviewed.retiredBackupPrivileges.every(value=>value.currentBackupReadPrivilegesVerified));
      result.currentMaterial=reviewed.fieldMaterialEvidence;result.currentCredentialMaterial=structuredClone(result.currentMaterial);result.finalMaterialRevalidationCompletedAt=reviewed.fieldMaterialFinalRevalidatedAt;
      assert(result.currentMaterial.originalHeldSessionVerified&&result.currentMaterial.currentTargetConfiguredAccountPasswordsMatched&&result.currentMaterial.currentIdentityVerified&&result.currentMaterial.transportInspectionComplete);assert.equal(result.currentMaterial.actualTransportObserved,item.mode==='ENABLED');assert.equal(result.currentMaterial.transportChannels.length,item.mode==='ENABLED'?1:0);assert(Date.parse(result.finalMaterialRevalidationCompletedAt)<result.currentMaterial.validUntilMs);assert.equal(reviewed.fullRegisteredRoleMatrixVerified,false);assert.equal(reviewed.completeDeploymentMaterialsVerified,false);assert.equal(reviewed.fullGoalComplete,false);
      done(item.mode+' same new SOURCE and original HELD combines complete core files, 29 role descriptions, 12 real password matches, both retired backup ACLs and current FIELD readonly transport inside both original deadlines');
      await inspector.close();inspector=null;
      done(item.mode+' original current identity and both workflow inventories, all seven databases and complete auth delivery/queue checks remain inside the combined original owner');
    }catch(error){
      if(error?.safeSqlCohortFailure)result.safeSqlCohortFailure=structuredClone(error.safeSqlCohortFailure);
      if(error?.code==='COLD_FIELD_CURRENT_UNVERIFIABLE')result.safeMaterialFailure={phase:['CREATE','VERIFY_CURRENT','OBSERVE_TRANSPORT','REVALIDATE'].includes(error.safePhase)?error.safePhase:'UNKNOWN',reason:['EXPIRED_OR_CLOSED','INPUT_CHANGED','CONTEXT_CHANGED','IDENTITY_CHANGED','UNVERIFIABLE'].includes(error.safeReason)?error.safeReason:'UNVERIFIABLE',elapsedMs:Number.isInteger(error.elapsedMs)&&error.elapsedMs>=0&&error.elapsedMs<=3600000?error.elapsedMs:null,rawErrorOrCredentialsRetained:false};
      throw error;
    }finally{
      const close=async(operation,code)=>{try{await operation();}catch{result.cleanupErrors.push(code);}};
      await close(async()=>{await inspector?.close();},'CORE_FIELD_INSPECTOR_CLOSE');await close(async()=>{await material?.close();},'FIELD_CURRENT_MATERIAL_CLOSE');await close(async()=>{if(sql){if(sql.getTransactionStatus()==='T')await sql.query('ROLLBACK');await end(sql);sql=null;}},'FIELD_CURRENT_ROOT_CLOSE');
      await close(async()=>{if(transport)result.transportPeers=await transport.close();},'FIELD_CURRENT_TRANSPORT_CLOSE');
      await close(async()=>{if(session)result.sessionReleased=await session.close();},'FIELD_CURRENT_SESSION_CLOSE');
      await close(async()=>{if(reader){if(reader.process.exitCode!==null||reader.process.signalCode!==null)await reader.terminal;else{if(!readerBound){await bindWorkflowReviewReaderV7(reader);readerBound=true;}result.readerTerminal=await stopWorkflowReviewReaderV7(reader);}}},'FIELD_CURRENT_READER_CLOSE');await close(async()=>{await preparation?.close();},'FIELD_CURRENT_PREPARATION_CLOSE');
      await close(async()=>{if(postgres){for(let index=0;index<40;index++){if((await inspectPostgresLifecycleV2(postgres)).otherClients===0)break;await pause(50);}result.postgresTerminal=await stopPostgresLifecycleV2(postgres,{requestId:randomUUID()});}},'FIELD_CURRENT_POSTGRES_CLOSE');
      await privateNewFile(join(currentWork,'field-current-result.private.json'),canonical(result));
    }
    assert.deepEqual(result.cleanupErrors,[]);assert(result.sessionReleased?.originalGuardsNormallyClosed&&result.sessionReleased?.allOriginalGuardBackendsRetired&&result.readerTerminal?.terminal.code===0&&result.readerTerminal?.targetSignalSent===false&&result.postgresTerminal?.terminal.code===0);done(item.mode+' original HELD guards/readers release and both actual JVM/postmaster handles retire normally');
  }
  stage.allOwnedResourcesNormallyRetired=true;await privateNewFile(join(directory,'field-current-native-result.private.json'),canonical(stage));return stage;
}
