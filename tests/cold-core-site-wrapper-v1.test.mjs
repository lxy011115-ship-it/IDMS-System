import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {advanceColdCoreSiteWrapperV1 as advance} from '../scripts/cold-core-site-wrapper-v1.mjs';
import {inspectColdRegistrationCoreMaterialsV9 as inspect,assertColdRegistrationCoreMaterialsV9 as owned} from '../scripts/cold-registration-core-materials-v9-request-file-v1.mjs';
import {createColdRegistrationCoreMaterialQaV2 as fixture} from '../scripts/fixtures/cold-registration-core-materials-v2-qa.mjs';
import {canonical} from '../server/imports.ts';

const root=resolve('work/cold-core-site-wrapper-v1-20261026'),file=join(root,'field.json'),authorityFile=join(root,'authority.json');
const field=enabled=>({format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:'cold.json',field:enabled?{enabled:true,gatewayFile:'gateway.json'}:{enabled:false}});
const cold=()=>({format:1,purpose:'RUNTIME_COLD_SITE_V1',baseRuntimeFile:'site-authority.json',trustFile:'trust.json'});
const authority=()=>({format:1,purpose:'SITE_CONSOLE_AUTHORITY_V1',baseRuntimeFile:'r4.json',authorityRuntimeFile:authorityFile});
const step=(value,state='START',depth=0,at=file)=>advance({value,file:at,authorityFile,state,depth});
const refused=(run,code)=>assert.throws(run,error=>error.code===code&&!error.message.includes(root));

test('enabled FIELD resolves only the next cold wrapper; it grants no capability',()=>{const value=step(field(true));assert.equal(value.nextFile,join(root,'cold.json'));assert.equal(value.state,'EXPECT_COLD');assert.equal(value.fieldEnabled,true);assert.equal(Object.hasOwn(value,'admissionGranted'),false);});
test('explicitly disabled FIELD still requires the cold wrapper',()=>{assert.equal(step(field(false)).state,'EXPECT_COLD');});
test('cold entry resolves and exposes trust for the core captured-file validator',()=>{const value=step(cold(),'EXPECT_COLD',1,join(root,'cold.json'));assert.equal(value.state,'EXPECT_AUTHORITY');assert.equal(value.trustFile,join(root,'trust.json'));});
test('standalone cold entry retains the same mandatory authority order',()=>{assert.equal(step(cold()).state,'EXPECT_AUTHORITY');});
test('authority immediately below cold uses the declared original authority file',()=>{const value=step(authority(),'EXPECT_AUTHORITY',2);assert.equal(value.state,'BASE');assert.equal(value.nextFile,join(root,'r4.json'));});
test('legacy entry passes through without acquiring wrapper verification',()=>{const value=step({purpose:'SITE_CONSOLE_HTTP_R4'});assert.equal(value.handled,false);assert.equal(value.state,'LEGACY');});
test('FIELD cannot be nested below legacy SITE',()=>refused(()=>step(field(true),'LEGACY',2),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER'));
test('FIELD cannot be nested below cold SITE',()=>refused(()=>step(field(true),'EXPECT_AUTHORITY',1),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER'));
test('FIELD cannot bypass cold and refer directly to authority',()=>refused(()=>step(authority(),'EXPECT_COLD',1),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER'));
test('cold cannot bypass authority and refer directly to a base',()=>refused(()=>step({purpose:'SITE_CONSOLE_HTTP_R4'},'EXPECT_AUTHORITY',1),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER'));
test('extra FIELD authorization flags are rejected',()=>refused(()=>step({...field(true),approved:true}),'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA'));
test('disabled FIELD rejects a hidden gateway reference',()=>{const value=field(false);value.field.gatewayFile='gateway.json';refused(()=>step(value),'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');});
test('cold wrapper rejects extra fields and wrong format',()=>{refused(()=>step({...cold(),approved:true}),'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');refused(()=>step({...cold(),format:2}),'COLD_REGISTRATION_CORE_SITE_WRAPPER_SCHEMA');});
test('self reference, gateway alias and trust alias are rejected',()=>{refused(()=>step({...field(true),baseRuntimeFile:'field.json'}),'COLD_REGISTRATION_CORE_SITE_CYCLE');const value=field(true);value.field.gatewayFile='cold.json';refused(()=>step(value),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ALIAS');refused(()=>step({...cold(),trustFile:'site-authority.json'}),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ALIAS');});
test('foreign authority and duplicate wrapped authority are rejected',()=>{refused(()=>step({...authority(),authorityRuntimeFile:'foreign.json'},'EXPECT_AUTHORITY',2),'COLD_REGISTRATION_CORE_SITE_AUTHORITY');refused(()=>step(authority(),'BASE',3),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ORDER');});
test('control characters and exhausted depth are rejected',()=>{refused(()=>step({...cold(),trustFile:'bad\n.json'}),'COLD_REGISTRATION_CORE_SITE_WRAPPER_REFERENCE');refused(()=>step(field(true),'START',8),'COLD_REGISTRATION_CORE_SITE_WRAPPER_ARGUMENTS');});

const original=resolve('work/cold-registration-auth-audit-map-native-v5-20261025/dd7554efc169');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
async function wrapped(label,enabled=false){
  const trust=await json(join(original,'cold-control/trust.json'));
  const f=await fixture({directory:join(root,'fixtures',label+'-'+randomUUID()),originalDirectory:original,trust});
  const trustFile=join(f.root,'current-trust.private.json'),coldFile=join(f.root,'cold-site.private.json'),siteFile=join(f.root,'field-site.private.json');
  await writeFile(trustFile,canonical(trust),{flag:'wx'});
  await writeFile(coldFile,canonical({format:1,purpose:'RUNTIME_COLD_SITE_V1',baseRuntimeFile:f.declaration.siteFile,trustFile}),{flag:'wx'});
  await writeFile(siteFile,canonical({format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:coldFile,field:enabled?{enabled:true,gatewayFile:join(f.root,'unverified-gateway.private.json')}:{enabled:false}}),{flag:'wx'});
  await f.change(f.configurationFile,value=>{value.siteFile=siteFile;});
  return {...f,trustFile,coldFile,siteFile};
}
test('real core compiler captures wrappers and current trust with all 16 original members',async()=>{
  const f=await wrapped('positive');let cap;
  try{cap=await inspect(f.config);const proof=cap.evidence();assert.equal(proof.implementationVersion,9);assert.equal(proof.strictSiteWrapperTopologyVerified,true);assert.equal(proof.members.length,16);assert.equal(proof.files.fileCount,34);assert.deepEqual(await cap.revalidate(),proof);assert.deepEqual(owned(cap,proof.binding),proof);assert.throws(()=>owned(proof,proof.binding),/CORE_OWNER/);for(const key of ['fieldMaterialsVerified','completeDeploymentMaterialsVerified','formalFieldActivationGranted','fullGoalComplete'])assert.equal(proof[key],false);}finally{await cap?.close();}
});
test('real core compiler refuses an otherwise well-formed different SOURCE trust file',async()=>{
  const f=await wrapped('foreign-trust');await f.change(f.trustFile,value=>{value.sourceHash='a'.repeat(64);});await assert.rejects(inspect(f.config),error=>error.code==='COLD_REGISTRATION_CORE_SITE_TRUST');
});
test('captured wrapper bytes are revalidated and drift permanently closes the real compiler',async()=>{
  const f=await wrapped('drift');let cap;
  try{cap=await inspect(f.config);await f.change(f.siteFile,value=>{value.field.enabled=true;value.field.gatewayFile='unverified-gateway.private.json';});await assert.rejects(cap.revalidate(),error=>error.code==='COLD_REGISTRATION_CORE_FILE_CHANGED');assert.throws(()=>cap.evidence(),/CORE_CLOSED_OR_BUSY/);}finally{await cap?.close();}
});
test('enabled wrapper syntax cannot claim FIELD verification from the core compiler',async()=>{
  const f=await wrapped('enabled-reference-only',true);let cap;
  try{cap=await inspect(f.config);assert.equal(cap.evidence().fieldMaterialsVerified,false);assert.equal(cap.evidence().completeDeploymentMaterialsVerified,false);}finally{await cap?.close();}
});
