import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createColdRegistrationCoreMaterialQaV2 as create} from '../scripts/fixtures/cold-registration-core-materials-v2-qa.mjs';
import {projectColdCoreCurrentCredentialsQaV1 as project} from '../scripts/fixtures/cold-core-current-credentials-v1-qa.mjs';
import {inspectColdRegistrationCoreMaterialsV11 as inspect} from '../scripts/cold-registration-core-materials-v11-request-file-v1.mjs';
import {readRuntimeColdControlV1} from '../scripts/runtime-cold-portable-control-v1.mjs';
const original=resolve('work/field-current-materials-native-v8-20261026/542c8702bd63'),root=resolve('work/cold-core-current-credentials-v1-20261026'),json=async file=>JSON.parse(await readFile(file,'utf8'));
let positive;
test('current FIELD SOURCE core copies use the actual hash-bound prior admission passwords',async()=>{
  const report=await json(join(original,'verification.json')),trust=report.fieldColdSourceCreation.sources[0].trust,priorTrust=report.fieldColdSourceCreation.priorTrust,prior=await readRuntimeColdControlV1(priorTrust),credentials=await json(prior.details.admission.credentialFile),fixture=await create({directory:join(root,'positive'),originalDirectory:original,trust});
  const before=await readFile(fixture.configurationFile),projected=await project({fixture,priorTrust});positive={fixture,priorTrust};assert(projected.currentAdmissionProjection.actualPriorAdmittedTargetIsCurrentSource);assert(projected.currentAdmissionProjection.priorRuntimeRolesBoundByOidAndName);assert.equal(projected.currentAdmissionProjection.currentTargetSqlPasswordsVerified,false);
  let changed=0,checked=0;
  for(const component of projected.components){const runtime=await json(component.runtimeFile),originalRuntime=await json(fixture.components.find(value=>value.tenantId===component.tenantId&&value.kind===component.kind&&value.mode===component.mode).runtimeFile);for(const kind of ['business','queue']){const account=runtime[kind].account;assert.equal(account.password,credentials.roles[account.user]);checked++;if(account.password!==originalRuntime[kind].account.password)changed++;}}
  assert.equal(checked,32);assert(changed>0);assert.equal(createHash('sha256').update(await readFile(fixture.configurationFile)).digest('hex'),createHash('sha256').update(before).digest('hex'));
  let cap;try{cap=await inspect(projected.config);assert.equal(cap.evidence().roleResponsibilities.runtimeRoleCount,11);assert.equal(cap.evidence().roleResponsibilities.currentConfiguredPasswordsVerified,false);assert.deepEqual(await cap.revalidate(),cap.evidence());}finally{await cap?.close();for(const name of Object.keys(credentials.roles))credentials.roles[name]='';}
});
test('projection refuses overwriting an existing material generation',async()=>{assert(positive);await assert.rejects(project(positive),error=>error.code==='EEXIST');});
test('an admission from another physical source cannot rebase these credentials',async()=>{
  const foreign=resolve('work/cold-registration-auth-audit-map-native-v5-20261025/dd7554efc169'),fixture=await create({directory:join(root,'foreign-source'),originalDirectory:foreign,trust:await json(join(foreign,'cold-control/trust.json'))});
  await assert.rejects(project({fixture,priorTrust:positive.priorTrust}),error=>error.code==='ERR_ASSERTION'&&error.message.includes('QA_PRIOR_ADMISSION_SOURCE_IDENTITY'));
});
