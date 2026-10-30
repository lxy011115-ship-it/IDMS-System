import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {writeFile,readFile,readdir,unlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {loadColdFieldDeploymentMaterialFilesV2 as load} from '../scripts/cold-field-deployment-material-files-v2.mjs';
import {loadColdFieldSourceMaterialSetV2 as loadTenant} from '../scripts/cold-field-material-source-files-v2.mjs';
import {coldFieldDeploymentFilesActualInputQaV1 as fixture} from './fixtures/cold-field-deployment-files-v1-input.mjs';

test('whole actual SOURCE file graph matches platform signer, keys, broker and every configured channel without an authority claim',async()=>{
  const input=await fixture(),key=randomBytes(32);let value;
  try{value=await load(input.configurationFile,input.context,key);assert.deepEqual(value.sourceBinding.configuredTenantIds,['sandbox']);assert.equal(value.evidence.configuredTenants,1);assert.equal(value.evidence.channels,input.configuration.edges.length);assert(value.evidence.files>30&&value.evidence.programFiles>=1&&value.evidence.offlineSpoolFiles>=1);assert(value.evidence.fieldConfigurationAndCredentialGraphCovered);assert.match(value.fingerprint,/^[a-f0-9]{64}$/);for(const name of ['currentHeldSessionVerified','currentTargetSqlAndIdentityVerified','actualTransportObserved','brokerTopicAclVerified','offlineSpoolSemanticsVerified','actualStartupProgramsApproved','completeFieldMaterialsVerified','formalFieldActivationGranted','fullGoalComplete'])assert.equal(value.evidence[name],false,name);assert.throws(()=>JSON.stringify(value),/COLD_FIELD_DEPLOYMENT_PRIVATE_ONLY/);assert(!JSON.stringify(value.evidence).includes(input.directory));
   const secrets=value.tenants.flatMap(value=>value.materials.channels.flatMap(value=>[value.edge.lease.requestKey,value.edge.eventKey,value.edge.opcua.privateKeyPem,value.edge.mqtt.materials.privateKeyPem,value.platform.materials.privateKeyPem]));value.clear();assert(secrets.every(value=>value.every(byte=>byte===0)));
  }finally{value?.clear();key.fill(0);}
});
test('missing, extra, duplicate or historically unconfigured tenants cannot reduce whole SOURCE coverage',async()=>{
  for(const tenantMaterials of [[],[{tenantId:'acme',configurationFile:null}],[{tenantId:'sandbox',configurationFile:null},{tenantId:'sandbox',configurationFile:null}]]){
    const input=await fixture();input.descriptor.tenantMaterials=tenantMaterials.map(value=>({...value,configurationFile:input.channelConfigurationFile}));await input.save(input.configurationFile,input.descriptor);await assert.rejects(load(input.configurationFile,input.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_TENANT_COVERAGE/);
  }
});
test('a different valid Ed25519 signer is rejected against the captured registry key identity',async()=>{
  const input=await fixture(),platform=await input.json(input.platformFile),file=resolve(dirname(input.platformFile),platform.leaseSigningKeyFile),key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});await writeFile(file,key);await assert.rejects(load(input.configurationFile,input.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_SIGNER_SOURCE/);
});
test('platform request and event keys must match the actual captured edge material, including separate file paths',async()=>{
  for(const name of ['requestKeyFile','eventKeyFile']){
    const input=await fixture(),platform=await input.json(input.platformFile),file=join(input.directory,'wrong-platform-'+name+'.bin');await writeFile(file,randomBytes(32),{flag:'wx'});platform.tenants[0].channels[0][name]=file.split(/[\\/]/).at(-1);await input.save(input.platformFile,platform);await assert.rejects(load(input.configurationFile,input.context,randomBytes(32)),name==='requestKeyFile'?/COLD_FIELD_DEPLOYMENT_PLATFORM_REQUEST_KEY/:/COLD_FIELD_DEPLOYMENT_PLATFORM_EVENT_KEY/);
  }
});
test('broker must cover the complete captured channel set and present its own matching server and probe keys',async()=>{
  const extra=await fixture();extra.broker.channels.push({tenantId:'acme',edgeId:'unconfigured-edge'});await extra.save(extra.brokerFile,extra.broker);await assert.rejects(load(extra.configurationFile,extra.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_BROKER_CHANNELS/);
  const wrong=await fixture();await writeFile(wrong.broker.probe.keyFile,await readFile(wrong.broker.server.keyFile));await assert.rejects(load(wrong.configurationFile,wrong.context,randomBytes(32)),/MQTT_BROKER_CERTIFICATE_KEY_MISMATCH/);
});
test('unbounded host references and online spool sidecars fail closed',async()=>{
  const escaped=await fixture();escaped.gateway.authorityHostFile=join(process.env.IDMS_COLD_FIELD_MATERIAL_QA_CASE,'field-site-host.private.json');await escaped.save(escaped.gatewayFile,escaped.gateway);await assert.rejects(load(escaped.configurationFile,escaped.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_PATH/);
  const spool=await fixture();await writeFile(join(spool.directory,'edge-spool','unexpected.sqlite-wal'),'not an offline spool',{flag:'wx'});await assert.rejects(load(spool.configurationFile,spool.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_SPOOL_OFFLINE/);
});
test('original explicit disabled SOURCE is distinct from changing an enabled SOURCE declaration',async()=>{
  const disabled=await fixture({disabled:true});let value;try{value=await load(disabled.configurationFile,disabled.context,randomBytes(32));assert.equal(value.sourceBinding.siteFieldEnabled,false);assert.equal(value.evidence.channels,0);assert.equal(value.evidence.programFiles,0);assert.equal(value.evidence.completeFieldMaterialsVerified,false);}finally{value?.clear();}
  const enabled=await fixture();enabled.site.field={enabled:false};await enabled.save(enabled.siteFile,enabled.site);await assert.rejects(load(enabled.configurationFile,enabled.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_SOURCE_MODE/);
});
test('legacy authority callbacks and malformed roots cannot become a whole deployment authority',async()=>{
  const input=await fixture();await assert.rejects(load(input.configurationFile,{...input.context,assertAuthorized(){throw Error('not an owner');}},randomBytes(32)),/COLD_FIELD_DEPLOYMENT_CONTEXT/);await assert.rejects(load(input.configurationFile,{...input.context,roots:['relative']},randomBytes(32)),/COLD_FIELD_DEPLOYMENT_CONTEXT/);
});
test('tenant file loader verifies the entire source configured intake set before selecting a tenant',async()=>{
  for(const change of [value=>value.tenants.pop(),value=>value.tenants.push(structuredClone(value.tenants[0])),value=>value.tenants.push({...structuredClone(value.tenants[0]),tenantId:'acme'})]){
    const input=await fixture(),intake=await input.json(input.configuration.intakeConfigurationFile);change(intake);await input.save(input.configuration.intakeConfigurationFile,intake);
    await assert.rejects(loadTenant(input.channelConfigurationFile,{trust:input.context.trust,tenantId:'sandbox',roots:input.context.roots},randomBytes(32)),/FIELD_ACTIVATION_MATERIAL_INTAKE_INVALID/);
  }
});

test('nonempty and orphan WAL sidecars are rejected, while every zero WAL has a bound identity witness',async()=>{
 const input=await fixture(),spool=join(input.directory,'edge-spool'),name=(await readdir(spool)).find(value=>/^stream-[a-f0-9]{64}\.sqlite$/.test(value));assert(name);await writeFile(join(spool,name+'-wal'),'pending log');await assert.rejects(load(input.configurationFile,input.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_SPOOL_WAL_NONEMPTY/);
 const orphan=await fixture();await writeFile(join(orphan.directory,'edge-spool','stream-'+('0'.repeat(64))+'.sqlite-wal'),Buffer.alloc(0),{flag:'wx'});await assert.rejects(load(orphan.configurationFile,orphan.context,randomBytes(32)),/COLD_FIELD_DEPLOYMENT_SPOOL_SIDECAR_ORPHAN/);
});
test('replacing a zero WAL changes the private material MAC through original file identity even though its bytes stay empty',async()=>{
 const input=await fixture(),key=randomBytes(32);let first,second;try{first=await load(input.configurationFile,input.context,key);assert(first.emptySidecarWitnesses.length>=1);const path=first.emptySidecarWitnesses[0].path,mac=first.fingerprint;first.clear();await unlink(path);await writeFile(path,Buffer.alloc(0),{flag:'wx'});second=await load(input.configurationFile,input.context,key);assert.notEqual(second.fingerprint,mac);assert.equal(second.evidence.offlineSpoolSemanticsVerified,false);}finally{first?.clear();second?.clear();key.fill(0);}
});
