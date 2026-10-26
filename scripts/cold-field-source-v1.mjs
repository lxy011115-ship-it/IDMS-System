import{resolve,dirname}from'node:path';
import{lstat}from'node:fs/promises';
import{canonical}from'../server/imports.ts';
import{parsePublicFieldProfile,publicFieldProfileDigest}from'../integrations/field-profile.ts';
import{fieldRecoveryControl,fieldRecoveryDatabaseBinding}from'../integrations/field-recovery.ts';
import{fieldRegistrySnapshot}from'../server/field-registry.ts';
import{readOwnedApplicationFieldSourcePrivateV1,inspectOwnedApplicationFieldSourceV1}from'./application-lifecycle-v4.mjs';
import{readApplicationFileV1,assertApplicationPinsV1,applicationBindingV1,applicationHashV1 as hash}from'./runtime-application-config-v1.mjs';
import{fieldMapSiteRuntimeConfigV1}from'./field-map-site-runtime-v1.mjs';
import{fieldMapAuthorityGatewayConfigV1}from'./field-map-authority-gateway-v1.mjs';
import{fieldMapAuthorityHostConfigV1}from'./field-map-authority-host-v1.mjs';
import{readRuntimeColdControlV1}from'./runtime-cold-portable-control-v1.mjs';
import{readRuntimeColdReviewV3}from'./runtime-cold-readonly-control-v5.mjs';
import{validateColdSourceFullFactsV1}from'./cold-source-full-facts-v2.mjs';
import{verifyFieldMapFullFieldSourceEvidenceV1}from'./field-map-full-field-source-evidence-v1.mjs';
import{coldFileHashV1}from'./pg-cold-image-portable-tools-v1.mjs';

const need=(v,c)=>{if(!v)throw Error(c);},same=(a,b)=>canonical(a)===canonical(b),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...k].sort().join(','),ordered=v=>[...v].sort(),normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p),samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&normal(a)===normal(b);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v),tenant=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v);
const safeOwnerKeys=['format','captureId','owner','originalPid','requestId','readyAt','originalDeploymentBinding','siteFieldEnabled','tenantIds','fixedManagerInputFiles','configurationMac','actualReadyAndOriginalNormalFullStopVerified','originalJsonGraphUnchanged','privatePathsPublished','unkeyedPrivateDigestsPublished','sourceClusterAndCompleteFactsBound','completeFieldMaterialsVerified','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'];
function sourceMapBindings(frame){return frame.fullFacts.databases.filter(d=>d.map).map(d=>({tenantId:d.map.tenantId,database:d.database,databaseOid:d.databaseOid,mapBinding:structuredClone(d.map.profile.binding),sourceMapFactsSha256:d.map.facts.factsSha256,sourceMapEvidenceSha256:d.map.evidenceSha256,sourcePayloadSha256:d.map.facts.payloadSha256})).sort((a,b)=>a.tenantId.localeCompare(b.tenantId));}
function binding(frame){need(uuid(frame.closedReceipt.operationId),'COLD_FIELD_SOURCE_MAINTENANCE_BINDING');return{systemIdentifier:frame.inventory.identity.system_id,sourceDirectory:resolve(frame.inventory.identity.directory),fullFactsSha256:frame.fullFacts.sha256,closedReceiptSha256:hash(canonical(frame.closedReceipt)),maintenanceOperationId:frame.closedReceipt.operationId,tenantIds:sourceMapBindings(frame).map(m=>m.tenantId)};}
function validateOwner(v){
 need(exact(v,safeOwnerKeys)&&v.format==='OWNED_APPLICATION_FIELD_SOURCE_EVIDENCE_V1'&&[v.captureId,v.owner,v.requestId].every(uuid)&&Number.isInteger(v.originalPid)&&v.originalPid>0,'COLD_FIELD_SOURCE_OWNER');
 need(typeof v.siteFieldEnabled==='boolean'&&Array.isArray(v.tenantIds)&&v.tenantIds.length>0&&v.tenantIds.every(tenant)&&same(v.tenantIds,ordered(new Set(v.tenantIds)))&&Number.isInteger(v.fixedManagerInputFiles)&&v.fixedManagerInputFiles>10&&hex(v.configurationMac),'COLD_FIELD_SOURCE_OWNER');
 need(v.actualReadyAndOriginalNormalFullStopVerified===true&&v.originalJsonGraphUnchanged===true&&['privatePathsPublished','unkeyedPrivateDigestsPublished','sourceClusterAndCompleteFactsBound','completeFieldMaterialsVerified','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'].every(k=>v[k]===false),'COLD_FIELD_SOURCE_OWNER_SCOPE');
 need(exact(v.originalDeploymentBinding,['controlId','sourceHash','authorityHash'])&&uuid(v.originalDeploymentBinding.controlId)&&hex(v.originalDeploymentBinding.sourceHash)&&hex(v.originalDeploymentBinding.authorityHash)&&typeof v.readyAt==='string'&&new Date(v.readyAt).toISOString()===v.readyAt,'COLD_FIELD_SOURCE_OWNER_BINDING');
}
function validateFieldMap(m){
 need(exact(m,['format','runtimeMarker','registryHead','intakeMarker','registryHistoryCount','fieldLeaseHistoryCount','allFieldRuntimeIndicesMatchedToCompleteAuditedPayload','completeFieldMaterialsVerified','formalFieldActivationGranted','fullGoalComplete'])&&m.format==='COLD_FIELD_MAP_SOURCE_FACTS_V1','COLD_FIELD_SOURCE_MAP_SCHEMA');
 need(typeof m.registryHistoryCount==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(m.registryHistoryCount)&&Number.isSafeInteger(m.fieldLeaseHistoryCount)&&m.fieldLeaseHistoryCount>=0&&m.allFieldRuntimeIndicesMatchedToCompleteAuditedPayload===true&&m.completeFieldMaterialsVerified===false&&m.formalFieldActivationGranted===false&&m.fullGoalComplete===false,'COLD_FIELD_SOURCE_MAP_FACTS');
 if(m.runtimeMarker!==null)need(exact(m.runtimeMarker,['format','tenantId'])&&m.runtimeMarker.format==='IDMS_FIELD_RUNTIME_MAP_V1'&&tenant(m.runtimeMarker.tenantId),'COLD_FIELD_SOURCE_RUNTIME_MARKER');
 if(m.registryHead!==null){const h=m.registryHead;need(exact(h,['format','tenantId','snapshot','revision','registryDigest','registryEventId','observedAt'])&&h.format==='IDMS_FIELD_RUNTIME_MAP_V1'&&tenant(h.tenantId)&&h.revision===m.registryHistoryCount&&hex(h.registryDigest)&&uuid(h.registryEventId)&&hash(canonical(fieldRegistrySnapshot(h.snapshot)))===h.registryDigest&&h.snapshot.tenantId===h.tenantId,'COLD_FIELD_SOURCE_REGISTRY');}
 else need(m.registryHistoryCount==='0','COLD_FIELD_SOURCE_REGISTRY_MISSING');
 if(m.intakeMarker!==null){const v=m.intakeMarker;need(exact(v,['format','tenantId','initializedFrom'])&&v.format==='IDMS_FIELD_MAP_INTAKE_V1'&&tenant(v.tenantId)&&exact(v.initializedFrom,['revision','rootId','rootHash','receiptHash'])&&/^(0|[1-9][0-9]{0,18})$/.test(v.initializedFrom.revision)&&[v.initializedFrom.rootId,v.initializedFrom.rootHash,v.initializedFrom.receiptHash].every(hex),'COLD_FIELD_SOURCE_INTAKE');}
 if(m.runtimeMarker===null)need(m.registryHead===null&&m.intakeMarker===null&&m.fieldLeaseHistoryCount===0,'COLD_FIELD_SOURCE_RUNTIME_MARKER_MISSING');
}

/** Historical private SOURCE data only. Hash validation does not mint an owner or authorize operation. */
export function validateColdFieldSourceV1(frame,value,controlDirectory){
 validateColdSourceFullFactsV1(frame,frame.fullFacts,controlDirectory);
 const{sha256,...body}=value??{};need(exact(value,['format','sourceBinding','ownerEvidence','originalTrust','managerJsonPins','fieldMaps','configuredTenants','historicalSourceOnly','configurationGraphOnly','configurationAndMapSourceBound','currentFieldMaterialsVerified','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete','sha256'])&&value.format==='COLD_FIELD_SOURCE_V1'&&hex(sha256)&&hash(canonical(body))===sha256,'COLD_FIELD_SOURCE_DESCRIPTOR');
 const b=binding(frame),maps=sourceMapBindings(frame);need(same(value.sourceBinding,b)&&maps.length>0&&same(maps.map(m=>m.tenantId),ordered(new Set(maps.map(m=>m.tenantId)))),'COLD_FIELD_SOURCE_CLUSTER_BINDING');validateOwner(value.ownerEvidence);need(same(value.ownerEvidence.tenantIds,b.tenantIds),'COLD_FIELD_SOURCE_TENANT_COVERAGE');
 need(value.historicalSourceOnly===true&&value.configurationGraphOnly===true&&value.configurationAndMapSourceBound===true&&['currentFieldMaterialsVerified','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'].every(k=>value[k]===false),'COLD_FIELD_SOURCE_SCOPE');
 const trust=value.originalTrust;need(exact(trust,['format','controlId','sourceHash','targetDirectory'])&&['RUNTIME_COLD_TRUST_V1','RUNTIME_COLD_REVIEW_TRUST_V3'].includes(trust.format)&&trust.controlId===value.ownerEvidence.originalDeploymentBinding.controlId&&trust.sourceHash===value.ownerEvidence.originalDeploymentBinding.sourceHash&&samePath(trust.targetDirectory,b.sourceDirectory),'COLD_FIELD_SOURCE_ORIGINAL_DEPLOYMENT');
 need(Array.isArray(value.managerJsonPins)&&value.managerJsonPins.length===value.ownerEvidence.fixedManagerInputFiles&&new Set(value.managerJsonPins.map(p=>normal(p.path))).size===value.managerJsonPins.length&&value.managerJsonPins.every(p=>exact(p,['path','sha256'])&&text(p.path)&&resolve(p.path)===p.path&&hex(p.sha256)),'COLD_FIELD_SOURCE_ORIGINAL_PINS');
 need(Array.isArray(value.fieldMaps)&&value.fieldMaps.length===maps.length,'COLD_FIELD_SOURCE_MAP_COVERAGE');
 for(let i=0;i<maps.length;i++){const v=value.fieldMaps[i];need(exact(v,['binding','fieldFacts'])&&same(v.binding,maps[i]),'COLD_FIELD_SOURCE_MAP_BINDING');validateFieldMap(v.fieldFacts);for(const m of[v.fieldFacts.runtimeMarker,v.fieldFacts.registryHead,v.fieldFacts.intakeMarker])if(m)need(m.tenantId===maps[i].tenantId,'COLD_FIELD_SOURCE_MAP_TENANT');}
 need(Array.isArray(value.configuredTenants)&&value.configuredTenants.length<=maps.length&&value.ownerEvidence.siteFieldEnabled===(value.configuredTenants.length>0),'COLD_FIELD_SOURCE_MODE');
 let prior='';for(const t of value.configuredTenants){
  need(exact(t,['tenantId','mapBinding','channels','registrySha256','recoveryIdentity'])&&tenant(t.tenantId)&&t.tenantId>prior,'COLD_FIELD_SOURCE_CONFIGURED_TENANT');prior=t.tenantId;
  const row=value.fieldMaps.find(m=>m.binding.tenantId===t.tenantId),f=row?.fieldFacts;need(row&&same(t.mapBinding,row.binding.mapBinding)&&f.runtimeMarker&&f.registryHead&&f.intakeMarker,'COLD_FIELD_SOURCE_CONFIGURED_MAP');const registry=fieldRegistrySnapshot(f.registryHead.snapshot);
  need(registry.format==='idms-field-registry-v2'&&same(t.recoveryIdentity,registry.recovery)&&t.registrySha256===hash(canonical(registry))&&Array.isArray(t.channels)&&t.channels.length>0&&t.channels.length===registry.channels.length,'COLD_FIELD_SOURCE_CONFIGURED_REGISTRY');
  for(let n=0;n<t.channels.length;n++){const c=t.channels[n],r=registry.channels[n];need(exact(c,['edgeId','profile','profileDigest'])&&c.edgeId===r.profile.source.edgeId&&same(parsePublicFieldProfile(c.profile),r.profile)&&c.profileDigest===publicFieldProfileDigest(c.profile)&&c.profileDigest===r.profileDigest&&!!c.profile.transport,'COLD_FIELD_SOURCE_COMPLETE_CHANNELS');}
 }
 return structuredClone(value);
}

/** Called by the source factory with its actual closed SQL inventory and complete captured roots. */
export async function captureColdFieldSourceV1(capability,frame,controlDirectory){
 const owner=await readOwnedApplicationFieldSourcePrivateV1(capability),ownerEvidence=await inspectOwnedApplicationFieldSourceV1(capability);validateOwner(ownerEvidence);const pins=owner.registryHeader.pins;
 await assertApplicationPinsV1(pins);validateColdSourceFullFactsV1(frame,frame.fullFacts,controlDirectory);
 const json=async file=>{const item=await readApplicationFileV1(file);need(pins.some(p=>samePath(p.path,item.path)&&p.sha256===item.sha256),'COLD_FIELD_SOURCE_UNPINNED_JSON');return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(item.bytes).replace(/^\uFEFF/,''));};
 const manifest=owner.registryHeader.manifest,trust=await json(resolve(dirname(owner.manifestFile),manifest.trustFile));
 const readPrior=async()=>trust.format==='RUNTIME_COLD_TRUST_V1'?readRuntimeColdControlV1(trust):trust.format==='RUNTIME_COLD_REVIEW_TRUST_V3'?readRuntimeColdReviewV3(trust):Promise.reject(Error('COLD_FIELD_SOURCE_ORIGINAL_TRUST'));
 const prior=await readPrior();need(prior.phase==='ADMITTED'&&same(applicationBindingV1(prior),owner.originalDeploymentBinding)&&prior.source.inventory.identity.system_id===frame.inventory.identity.system_id&&samePath(prior.details.targetDirectory,frame.inventory.identity.directory),'COLD_FIELD_SOURCE_ORIGINAL_CLUSTER');
 const site=fieldMapSiteRuntimeConfigV1(await json(owner.siteRuntimeFile));need(site.field.enabled===owner.siteFieldEnabled,'COLD_FIELD_SOURCE_MODE_CHANGED');const configured=[];
 if(site.field.enabled){
  const gatewayFile=resolve(dirname(owner.siteRuntimeFile),site.field.gatewayFile),gateway=fieldMapAuthorityGatewayConfigV1(await json(gatewayFile));need(gateway.enabled,'COLD_FIELD_SOURCE_GATEWAY_DISABLED');
  const hostFile=resolve(dirname(gatewayFile),gateway.authorityHostFile),host=fieldMapAuthorityHostConfigV1(await json(hostFile)),platformFile=resolve(dirname(gatewayFile),gateway.platformFile),platform=await json(platformFile),intake=await json(resolve(dirname(gatewayFile),gateway.intakeFile));
  need(samePath(resolve(dirname(hostFile),host.coldTrustFile),resolve(dirname(owner.manifestFile),manifest.trustFile)),'COLD_FIELD_SOURCE_HOST_TRUST');
  need(exact(platform,['format','leaseSigningKeyFile','tenants'])&&platform.format==='idms-field-platform-config-v2'&&text(platform.leaseSigningKeyFile)&&Array.isArray(platform.tenants)&&platform.tenants.length>0&&platform.tenants.length<=32,'COLD_FIELD_SOURCE_PLATFORM');
  need(exact(intake,['format','tenants'])&&intake.format==='idms-field-platform-intake-v1'&&Array.isArray(intake.tenants),'COLD_FIELD_SOURCE_INTAKE_CONFIG');
  const tenantSet=new Set();for(const t of platform.tenants){
   need(exact(t,['tenantId','recoveryFile','channels'])&&tenant(t.tenantId)&&!tenantSet.has(t.tenantId)&&owner.tenantIds.includes(t.tenantId)&&text(t.recoveryFile)&&Array.isArray(t.channels)&&t.channels.length>0&&t.channels.length<=32,'COLD_FIELD_SOURCE_PLATFORM_TENANT');tenantSet.add(t.tenantId);
   const h=host.tenants.find(h=>h.tenantId===t.tenantId),m=sourceMapBindings(frame).find(m=>m.tenantId===t.tenantId);need(h&&m&&h.account.database===m.database&&same(h.binding,m.mapBinding),'COLD_FIELD_SOURCE_HOST_MAP');
   const recovery=fieldRecoveryControl(await json(resolve(dirname(platformFile),t.recoveryFile)));need(recovery.tenantId===t.tenantId&&recovery.state==='ACTIVE'&&recovery.identity.databaseBindingSha256===fieldRecoveryDatabaseBinding({host:h.account.host,port:h.account.port,database:h.account.database,user:h.account.user}),'COLD_FIELD_SOURCE_RECOVERY');
   const channels=t.channels.map(c=>{need(exact(c,['profile','requestKeyFile','eventKeyFile'])&&text(c.requestKeyFile)&&text(c.eventKeyFile),'COLD_FIELD_SOURCE_CHANNEL_CONFIG');const profile=parsePublicFieldProfile(c.profile);need(profile.source.tenantId===t.tenantId&&profile.transport,'COLD_FIELD_SOURCE_CHANNEL_PROFILE');return{edgeId:profile.source.edgeId,profile,profileDigest:publicFieldProfileDigest(profile)};}).sort((a,b)=>a.edgeId.localeCompare(b.edgeId));need(new Set(channels.map(c=>c.edgeId)).size===channels.length,'COLD_FIELD_SOURCE_DUPLICATE_EDGE');
   const i=intake.tenants.find(i=>i.tenantId===t.tenantId);need(exact(i,['tenantId','channels'])&&Array.isArray(i.channels)&&same(ordered(i.channels.map(c=>c.edgeId)),channels.map(c=>c.edgeId))&&i.channels.every(c=>exact(c,['edgeId','mqtt'])&&c.mqtt&&typeof c.mqtt==='object'),'COLD_FIELD_SOURCE_COMPLETE_INTAKE');configured.push({tenantId:t.tenantId,mapBinding:m.mapBinding,channels,recoveryIdentity:recovery.identity});
  }
  need(same(ordered(host.tenants.map(t=>t.tenantId)),ordered(tenantSet))&&same(ordered(intake.tenants.map(t=>t.tenantId)),ordered(tenantSet)),'COLD_FIELD_SOURCE_COMPLETE_PLATFORM');
 }
 const fieldMaps=[];
 for(const d of frame.fullFacts.databases.filter(d=>d.map).sort((a,b)=>a.map.tenantId.localeCompare(b.map.tenantId))){
  const m=d.map,before=await lstat(m.evidenceFile,{bigint:true});need((await coldFileHashV1(m.evidenceFile,2*1024**3)).sha256===m.evidenceSha256,'COLD_FIELD_SOURCE_EVIDENCE_CHANGED');
  const proof=await verifyFieldMapFullFieldSourceEvidenceV1({file:m.evidenceFile,expectedFacts:m.facts,workDirectory:resolve(controlDirectory,'source-full-maps')}),after=await lstat(m.evidenceFile,{bigint:true});for(const k of['dev','ino','nlink','size','mtimeNs','ctimeNs'])need(before[k]===after[k],'COLD_FIELD_SOURCE_EVIDENCE_CHANGED');need((await coldFileHashV1(m.evidenceFile,2*1024**3)).sha256===m.evidenceSha256,'COLD_FIELD_SOURCE_EVIDENCE_CHANGED');
  fieldMaps.push({binding:sourceMapBindings(frame).find(b=>b.tenantId===m.tenantId),fieldFacts:proof.fieldSourceFacts});
 }
 for(const t of configured){const row=fieldMaps.find(m=>m.binding.tenantId===t.tenantId);need(row?.fieldFacts.registryHead,'COLD_FIELD_SOURCE_REGISTRY_MISSING');t.registrySha256=hash(canonical(fieldRegistrySnapshot(row.fieldFacts.registryHead.snapshot)));}
 const body={format:'COLD_FIELD_SOURCE_V1',sourceBinding:binding(frame),ownerEvidence,originalTrust:{format:trust.format,controlId:trust.controlId,sourceHash:trust.sourceHash,targetDirectory:resolve(prior.details.targetDirectory)},managerJsonPins:structuredClone(pins),fieldMaps,configuredTenants:configured.sort((a,b)=>a.tenantId.localeCompare(b.tenantId)),historicalSourceOnly:true,configurationGraphOnly:true,configurationAndMapSourceBound:true,currentFieldMaterialsVerified:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 const result={...body,sha256:hash(canonical(body))};validateColdFieldSourceV1(frame,result,controlDirectory);await assertApplicationPinsV1(pins);
 need(same(await readOwnedApplicationFieldSourcePrivateV1(capability),owner),'COLD_FIELD_SOURCE_ORIGINAL_OWNER_CHANGED');const finalPrior=await readPrior();need(finalPrior.phase==='ADMITTED'&&same(finalPrior.source,prior.source)&&same(finalPrior.details.admission,prior.details.admission)&&samePath(finalPrior.details.targetDirectory,prior.details.targetDirectory),'COLD_FIELD_SOURCE_ORIGINAL_DEPLOYMENT_CHANGED');
 return result;
}
