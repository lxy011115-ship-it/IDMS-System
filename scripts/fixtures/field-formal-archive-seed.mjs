import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
const env=JSON.parse(await readFile(process.env.IDMS_FIELD_ARCHIVE_QA_PRIVATE));
if(process.env.NODE_ENV!=='test'||!/^fieldarchiveqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||'')||!/^idms_fieldarchiveqa_acme_[a-f0-9]{10}$/.test(env.runtime.tenants.acme.database)||resolve(process.env.IDMS_POSTGRES_CONFIG)!==resolve(env.directory,'runtime.json'))throw Error('Owned archive QA environment required');
const {seedStore}=await import('../../server/store.ts'),{loadRuntimeImports,mutate,waitForWrites,clearWorkspaceCache}=await import('../../server/import-api.ts'),{closePostgres}=await import('../../server/postgres-repository.ts'),{FieldPlatformService}=await import('../../server/field-platform.ts');
const {fieldIssuanceModel}=await import('./field-issuance-model.mjs'),{fieldProfileFixture}=await import('./field-certificate-fixture.mjs'),{fieldMqttDeclaration}=await import('./field-mqtt-fixture.mjs'),{fieldDeclaredObservation}=await import('./field-event-model.mjs');
const {fieldSha256,publicFieldProfileDigest}=await import('../../integrations/field-profile.ts'),{fieldLeaseKeyId}=await import('../../integrations/field-lease.ts'),{signFieldLeaseRequest}=await import('../../integrations/field-request.ts'),{fieldObservationEvents,verifyFieldAck}=await import('../../integrations/field-event.ts'),{stable}=await import('../../integrations/telemetry.ts'),{writePrivate}=await import('../keycloak-local.mjs');
const keys=generateKeyPairSync('ed25519'),requestKey=randomBytes(32),eventKey=env.liveMaterials?await readFile(env.liveMaterials.eventKeyFile):randomBytes(32),source=env.source,privateProfile=env.liveMaterials?structuredClone(env.liveMaterials.profileSeed):fieldProfileFixture();
privateProfile.format='idms-field-channel-profile-v2';privateProfile.transport={...(env.liveMaterials?privateProfile.transport:fieldMqttDeclaration(source)),eventKeySha256:fieldSha256(eventKey),acknowledgementKeyId:fieldLeaseKeyId(keys.publicKey)};
const store=seedStore(),platform=new FieldPlatformService(),control=await readFile(resolve(env.directory,'recovery.json'));
try{
 const history=await loadRuntimeImports(store);
 let workflowProof=null;if(process.env.IDMS_FIELD_REVIEW_WORKFLOW_QA==='1'){const {seedRecoveryWorkflow}=await import('./field-recovery-workflow-seed.mjs');workflowProof=await seedRecoveryWorkflow({store,history,directory:env.directory,runtime:env.runtime});}
 const model=await mutate(store,(_c,w)=>{const m=fieldIssuanceModel(w.store,w.imports,source,privateProfile);return {profile:m.profile};},'acme'),profile=model.profile;
 await writePrivate(resolve(env.directory,'signer.pem'),keys.privateKey.export({type:'pkcs8',format:'pem'}));await writePrivate(resolve(env.directory,'request.bin'),requestKey);await writePrivate(resolve(env.directory,'event.bin'),eventKey);
 const file=resolve(env.directory,'platform.json');await writePrivate(file,JSON.stringify({format:'idms-field-platform-config-v2',leaseSigningKeyFile:'signer.pem',tenants:[{tenantId:'acme',recoveryFile:'recovery.json',channels:[{profile,requestKeyFile:'request.bin',eventKeyFile:'event.bin'}]}]}));
 if(env.liveMaterials){
  const {origin,...privateSource}=profile.source,configured={...privateProfile,source:privateSource,points:profile.points,transport:profile.transport};await writePrivate(resolve(env.directory,'profile-materials.json'),JSON.stringify(configured));await writePrivate(resolve(env.directory,'platform-public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
  await writePrivate(resolve(env.directory,'edge-materials.json'),JSON.stringify({format:'idms-field-edge-config-v1',profileFile:'profile-materials.json',lease:{url:'http://127.0.0.1:9/api/v1/field-channel/lease',requestKeyFile:'request.bin',platformPublicKeyFile:'platform-public.pem',timeoutMs:1000,renewBeforeMs:500},eventKeyFile:'event.bin',mqtt:env.liveMaterials.edgeMqtt,spool:{directory:'activation-material-spool',capacity:100,maxBytes:131072,maxStreams:4},schedule:{sampleIntervalMs:1000,retryMs:100,ackTimeoutMs:500,batchLimit:10,onceTimeoutMs:10000,retryBackoffMs:1000}}));
  await writePrivate(resolve(env.directory,'intake-materials.json'),JSON.stringify({format:'idms-field-platform-intake-v1',tenants:[{tenantId:'acme',channels:[{edgeId:profile.source.edgeId,mqtt:env.liveMaterials.platformMqtt}]}]}));
  await writePrivate(resolve(env.directory,'activation-materials.json'),JSON.stringify({format:'idms-field-activation-materials-v1',tenantId:'acme',intakeConfigurationFile:resolve(env.directory,'intake-materials.json'),edges:[{edgeId:profile.source.edgeId,configurationFile:resolve(env.directory,'edge-materials.json')}]}));
 }
 if(process.env.IDMS_FIELD_ACTIVATION_STREAM_QA!=='1'){
 await platform.start(store,file);await platform.enableReceiving(env.runtime);
 const lease=await platform.issue(store,signFieldLeaseRequest({format:'idms-field-lease-request-v1',requestId:randomUUID(),tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion,profileDigest:publicFieldProfileDigest(profile),requestedAtMs:Date.now()},requestKey));
 const events=fieldObservationEvents(fieldDeclaredObservation(profile,lease),profile,eventKey,keys.publicKey,1,randomUUID());assert.ok(events.length>0);
 for(const event of events){const ack=await platform.receiveMqtt(profile.transport.topics.telemetry,Buffer.from(stable(event)));assert.equal(verifyFieldAck(ack,keys.publicKey,event).body.status,'STORED');}
 const replay=await platform.receiveMqtt(profile.transport.topics.telemetry,Buffer.from(stable(events[0])));assert.equal(verifyFieldAck(replay,keys.publicKey,events[0]).body.status,'STORED');
 }
 assert.deepEqual(await readFile(resolve(env.directory,'recovery.json')),control);
 process.send?.({type:'PROOF',value:{points:process.env.IDMS_FIELD_ACTIVATION_STREAM_QA==='1'?0:profile.points.length,realInitializedControlPreserved:true,protocolFixtureOnly:process.env.IDMS_FIELD_ACTIVATION_STREAM_QA!=='1',deferredActualSourceStream:process.env.IDMS_FIELD_ACTIVATION_STREAM_QA==='1',...(workflowProof?{workflow:workflowProof}:{})}});
}finally{await platform.close();await waitForWrites();clearWorkspaceCache();await closePostgres();requestKey.fill(0);eventKey.fill(0);process.disconnect?.();}
