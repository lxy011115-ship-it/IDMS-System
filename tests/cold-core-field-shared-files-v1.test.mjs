import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createSharedColdCoreFieldMaterialFilesQaV1 as create} from '../scripts/fixtures/cold-core-field-shared-material-files-v1-qa.mjs';
import {inspectColdRegistrationCoreMaterialsV9 as inspect} from '../scripts/cold-registration-core-materials-v9-request-file-v1.mjs';
import {loadColdFieldDeploymentMaterialFilesV4 as loadField} from '../scripts/cold-field-deployment-material-files-v4.mjs';
import {canonical} from '../server/imports.ts';

const original=resolve('work/field-current-materials-native-v8-20261026/542c8702bd63'),root=resolve('work/cold-core-field-shared-files-v1-20261026');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
for(const mode of ['ENABLED','EXPLICIT_DISABLED'])test(mode+' original SOURCE core and FIELD files share the actual SITE, trust and authority',async()=>{
  const report=await json(join(original,'verification.json')),caseItem=report.fieldCurrentMaterialsNative.cases.find(value=>value.mode===mode),enabled=report.fieldCurrentMaterialsNative.cases.find(value=>value.mode==='ENABLED');
  const enabledDescriptor=await json(enabled.configurationFile),enabledSite=await json(enabledDescriptor.siteRuntimeFile),gateway=await json(resolve(dirname(enabledDescriptor.siteRuntimeFile),enabledSite.field.gatewayFile)),host=await json(resolve(dirname(enabledDescriptor.siteRuntimeFile),gateway.authorityHostFile));
  const authority=await json(join(original,'authority-runtime.private.json'));
  const files=await create({directory:join(root,mode.toLowerCase()),originalDirectory:original,trust:caseItem.trust,mode,sourceCreation:report.fieldColdSourceCreation,authority,account:host.controlAccount});
  const coreDeclaration=await json(files.coreMaterialConfiguration.configurationFile),fieldDeclaration=await json(files.fieldMaterialConfiguration.configurationFile),cold=await json(files.coldSiteFile);
  assert.equal(coreDeclaration.siteFile,fieldDeclaration.siteRuntimeFile);
  assert.equal(coreDeclaration.siteFile,files.siteFile);
  assert.equal(cold.trustFile,files.trustFile);
  assert.deepEqual(await json(files.trustFile),caseItem.trust);
  assert.equal((await json(cold.baseRuntimeFile)).authorityRuntimeFile,files.authorityFile);
  let core,field;const key=randomBytes(32);
  try{
    core=await inspect({...files.core.config,...files.coreMaterialConfiguration});
    field=await loadField(files.fieldMaterialConfiguration.configurationFile,{trust:caseItem.trust,roots:files.fieldMaterialConfiguration.roots,workDirectory:files.fieldMaterialConfiguration.workDirectory},key);
    const coreProof=core.evidence();
    assert.equal(coreProof.binding.sourceHash,field.sourceBinding.sourceHash);
    assert.equal(coreProof.binding.controlId,field.sourceBinding.controlId);
    assert.equal(coreProof.members.length,16);
    assert.equal(field.site.field.enabled,mode==='ENABLED');
    assert.equal(field.evidence.configuredTenants,mode==='ENABLED'?1:0);
    assert(field.evidence.fieldConfigurationAndCredentialGraphCovered);
    assert.deepEqual(await core.revalidate(),coreProof);
    assert((await field.revalidateInputWitness()).allOriginalBytesAndIdentitiesVerified);
    assert.equal(coreProof.fieldMaterialsVerified,false);
    assert.equal(field.evidence.currentHeldSessionVerified,false);
    assert.equal(field.evidence.currentTargetSqlAndIdentityVerified,false);
    assert.equal(field.evidence.completeFieldMaterialsVerified,false);
    const sharedFile=await json(files.coldSiteFile);sharedFile.trustFile='unregistered-trust.private.json';
    await writeFile(files.coldSiteFile,canonical(sharedFile));
    await assert.rejects(core.revalidate(),error=>error.code==='COLD_REGISTRATION_CORE_FILE_CHANGED');
    await assert.rejects(field.revalidateInputWitness(),error=>['COLD_FIELD_INPUT_BYTES_CHANGED','COLD_FIELD_INPUT_IDENTITY_CHANGED'].includes(error.code));
    assert.throws(()=>core.evidence(),/CORE_CLOSED_OR_BUSY/);
  }finally{await core?.close();await field?.clear();key.fill(0);}
});
