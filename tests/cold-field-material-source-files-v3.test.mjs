import test from'node:test';import assert from'node:assert/strict';import{readFile,writeFile,unlink}from'node:fs/promises';import{dirname,resolve}from'node:path';import{randomBytes}from'node:crypto';import{coldFieldMaterialActualInputQaV2 as fixture}from'./fixtures/cold-field-material-source-files-v2-input.mjs';import{loadColdFieldSourceMaterialSetV1 as load}from'../scripts/cold-field-material-source-files-v1.mjs';
test('actual complete enabled SOURCE compiles all channel files with private HMAC and explicit non-authority scope',async()=>{
 const v=await fixture(),loaded=await load(v.configurationFile,v.context,randomBytes(32));try{assert.equal(loaded.channels.length,v.configuration.edges.length);assert(loaded.privateFiles.length>=14);assert.match(loaded.fingerprint,/^[a-f0-9]{64}$/);assert.equal(loaded.sourceBinding.sourceHash,v.context.trust.sourceHash);for(const flag of['completeFieldMaterialsVerified','currentHeldSessionVerified','actualTransportObserved','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'])assert.equal(loaded[flag],false);assert.equal(loaded.sourceOnly,true);assert.throws(()=>JSON.stringify(loaded),/COLD_FIELD_MATERIAL_PRIVATE_ONLY/);}finally{loaded.clear();}assert(loaded.channels.every(c=>c.edge.eventKey.every(b=>b===0)&&c.edge.lease.requestKey.every(b=>b===0)&&c.platform.materials.privateKeyPem.every(b=>b===0)));
});
test('missing and duplicate channel declarations reject rather than accepting a readable subset',async()=>{
 for(const change of[v=>v.configuration.edges=[],v=>v.configuration.edges.push({...v.configuration.edges[0]})]){const v=await fixture();change(v);await v.save(v.configurationFile,v.configuration);await assert.rejects(load(v.configurationFile,v.context,randomBytes(32)),/MATERIAL_CONFIGURATION_INVALID/);}
});
test('tenant and edge identities must match the complete original registry',async()=>{
 for(const change of[v=>v.configuration.tenantId='foreign',v=>v.configuration.edges[0].edgeId='foreign']){const v=await fixture();change(v);await v.save(v.configurationFile,v.configuration);await assert.rejects(load(v.configurationFile,v.context,randomBytes(32)),/MATERIAL_(?:CONFIGURATION_INVALID|CHANNEL_BINDING_CHANGED)/);}
});
test('unconfigured tenant and explicitly disabled SOURCE remain distinct fail-closed outcomes',async()=>{
 const v=await fixture();await assert.rejects(load(v.configurationFile,{...v.context,tenantId:'acme'},randomBytes(32)),/TENANT_NOT_CONFIGURED/);await assert.rejects(load(v.configurationFile,{...v.context,trust:v.sourceModes.find(s=>s.mode==='EXPLICIT_DISABLED').trust},randomBytes(32)),/SOURCE_EXPLICIT_DISABLED/);
});
test('changed request key cannot be substituted under the original source channel',async()=>{
 const v=await fixture();await writeFile(resolve(dirname(v.edgeFile),v.edge.lease.requestKeyFile),randomBytes(32));await assert.rejects(load(v.configurationFile,v.context,randomBytes(32)),/CHANNEL_BINDING_CHANGED/);
});
test('event and request keys cannot share the same bytes',async()=>{
 const v=await fixture();await writeFile(resolve(dirname(v.edgeFile),v.edge.eventKeyFile),await readFile(resolve(dirname(v.edgeFile),v.edge.lease.requestKeyFile)));await assert.rejects(load(v.configurationFile,v.context,randomBytes(32)),/FIELD_EDGE_CONFIG_INVALID/);
});
test('OPC UA client private key must correspond to its pinned client certificate',async()=>{
 const v=await fixture(),platform=v.intake.tenants[0].channels[0].mqtt;await writeFile(resolve(dirname(v.profileFile),v.profile.certificates.privateKeyFile),await readFile(resolve(dirname(v.configuration.intakeConfigurationFile),platform.privateKeyFile)));await assert.rejects(load(v.configurationFile,v.context,randomBytes(32)),e=>typeof e.code==='string'||e instanceof Error);
});
test('missing platform MQTT key cannot pass material completeness',async()=>{
 const v=await fixture(),platform=v.intake.tenants[0].channels[0].mqtt;await unlink(resolve(dirname(v.configuration.intakeConfigurationFile),platform.privateKeyFile));await assert.rejects(load(v.configurationFile,v.context,randomBytes(32)),e=>e.code==='ENOENT');
});
test('referenced material files must stay within the trusted declared material roots',async()=>{
 const v=await fixture();await assert.rejects(load(v.configurationFile,{...v.context,roots:[resolve(v.directory,'other')]},randomBytes(32)),/COLD_FIELD_MATERIAL_FILE_PATH/);
});
test('legacy registration objects and caller authorization callbacks cannot select the cold source context',async()=>{
 const v=await fixture();for(const extra of[{registration:{}},{authorize:()=>true}])await assert.rejects(load(v.configurationFile,{...v.context,...extra},randomBytes(32)),/COLD_FIELD_MATERIAL_CONTEXT/);
});
test('the original SOURCE hash remains required before any material compilation',async()=>{
 const v=await fixture();await assert.rejects(load(v.configurationFile,{...v.context,trust:{...v.context.trust,sourceHash:'0'.repeat(64)}},randomBytes(32)),/COLD_STORE_BINDING/);
});
