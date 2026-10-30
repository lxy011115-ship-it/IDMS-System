import{resolve}from'node:path';
import{canonical}from'../../server/imports.ts';
import{applicationHashV1 as hash}from'../../scripts/runtime-application-config-v1.mjs';
import{coldSourceFullSetUnitV1}from'./cold-source-full-set-v2.mjs';
import{fieldProfileFixture}from'../../scripts/fixtures/field-certificate-fixture.mjs';
import{fieldMqttDeclaration}from'../../scripts/fixtures/field-mqtt-fixture.mjs';
import{publicFieldProfile}from'../../services/field/profile.ts';
import{publicFieldProfileDigest}from'../../integrations/field-profile.ts';
import{fieldRegistrySnapshot}from'../../server/field-registry.ts';
import{fieldRecoveryFixture}from'../../scripts/fixtures/field-recovery-fixture.mjs';
const id='10000000-0000-4000-8000-000000000001';
export function rehashColdFieldUnitV1(value){const{sha256,...body}=value;value.sha256=hash(canonical(body));return value;}
/** Pure metadata vectors. They cannot mint an original manager or pass native source creation. */
export function coldFieldSourceUnitV1({enabled=true,historical=true}={}){
 const x=coldSourceFullSetUnitV1(),frame={...x.frame,fullFacts:x.set};frame.closedReceipt.operationId=id;
 const d=x.set.databases.find(d=>d.map),m=d.map,owner={format:'OWNED_APPLICATION_FIELD_SOURCE_EVIDENCE_V1',captureId:id,owner:id,originalPid:12345,requestId:id,readyAt:'2026-10-26T00:00:00.000Z',originalDeploymentBinding:{controlId:id,sourceHash:'a'.repeat(64),authorityHash:'b'.repeat(64)},siteFieldEnabled:enabled,tenantIds:['acme'],fixedManagerInputFiles:11,configurationMac:'c'.repeat(64),actualReadyAndOriginalNormalFullStopVerified:true,originalJsonGraphUnchanged:true,privatePathsPublished:false,unkeyedPrivateDigestsPublished:false,sourceClusterAndCompleteFactsBound:false,completeFieldMaterialsVerified:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 const p=fieldProfileFixture(),profile=publicFieldProfile({...p,format:'idms-field-channel-profile-v2',transport:fieldMqttDeclaration(p.source)}),channel={edgeId:profile.source.edgeId,profile,profileDigest:publicFieldProfileDigest(profile)},identity=fieldRecoveryFixture({database:d.database,user:'unit_app'}).identity;
 const registry=fieldRegistrySnapshot({format:'idms-field-registry-v2',tenantId:'acme',recovery:identity,leaseKeyId:profile.transport.acknowledgementKeyId,channels:[{profile,profileDigest:channel.profileDigest,requestKeySha256:'d'.repeat(64)}]}),registryHead={format:'IDMS_FIELD_RUNTIME_MAP_V1',tenantId:'acme',snapshot:registry,revision:'1',registryDigest:hash(canonical(registry)),registryEventId:id,observedAt:'2026-10-26T00:00:00.000Z'};
 const mapBinding={tenantId:'acme',database:d.database,databaseOid:d.databaseOid,mapBinding:m.profile.binding,sourceMapFactsSha256:m.facts.factsSha256,sourceMapEvidenceSha256:m.evidenceSha256,sourcePayloadSha256:m.facts.payloadSha256};
 const fieldFacts={format:'COLD_FIELD_MAP_SOURCE_FACTS_V1',runtimeMarker:historical?{format:'IDMS_FIELD_RUNTIME_MAP_V1',tenantId:'acme'}:null,registryHead:historical?registryHead:null,intakeMarker:historical?{format:'IDMS_FIELD_MAP_INTAKE_V1',tenantId:'acme',initializedFrom:{revision:'0',rootId:'e'.repeat(64),rootHash:'f'.repeat(64),receiptHash:'1'.repeat(64)}}:null,registryHistoryCount:historical?'1':'0',fieldLeaseHistoryCount:0,allFieldRuntimeIndicesMatchedToCompleteAuditedPayload:true,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 const value={format:'COLD_FIELD_SOURCE_V1',sourceBinding:{systemIdentifier:frame.inventory.identity.system_id,sourceDirectory:resolve(frame.inventory.identity.directory),fullFactsSha256:x.set.sha256,closedReceiptSha256:hash(canonical(frame.closedReceipt)),maintenanceOperationId:id,tenantIds:['acme']},ownerEvidence:owner,originalTrust:{format:'RUNTIME_COLD_TRUST_V1',controlId:id,sourceHash:'a'.repeat(64),targetDirectory:resolve(frame.inventory.identity.directory)},managerJsonPins:Array.from({length:11},(_,n)=>({path:resolve('work/unit-field-source/input-'+n+'.json'),sha256:'e'.repeat(64)})),fieldMaps:[{binding:mapBinding,fieldFacts}],configuredTenants:enabled?[{tenantId:'acme',mapBinding:m.profile.binding,channels:[channel],registrySha256:hash(canonical(registry)),recoveryIdentity:identity}]:[],historicalSourceOnly:true,configurationGraphOnly:true,configurationAndMapSourceBound:true,currentFieldMaterialsVerified:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 return{frame,value:rehashColdFieldUnitV1(value),controlDirectory:x.controlDirectory,metadataOnly:true};
}
