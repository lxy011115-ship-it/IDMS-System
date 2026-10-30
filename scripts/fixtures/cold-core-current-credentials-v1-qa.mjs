import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
import {readRuntimeColdControlV1} from '../runtime-cold-portable-control-v1.mjs';
import {createRuntimeColdConfigGenerationV1} from '../runtime-cold-config-v1.mjs';

/** QA-only immutable projection of this SOURCE's actual, hash-bound prior admission credential generation. */
export async function projectColdCoreCurrentCredentialsQaV1({fixture,priorTrust}){
  const prior=await readRuntimeColdControlV1(priorTrust),current=fixture.state.source;
  assert.equal(prior.phase,'ADMITTED','QA_PRIOR_ADMISSION_NOT_READY');
  assert.equal(prior.source.inventory.identity.system_id,current.inventory.identity.system_id,'QA_PRIOR_ADMISSION_SOURCE_IDENTITY');
  assert.equal(await realpath(prior.details.targetDirectory),await realpath(current.inventory.identity.directory),'QA_PRIOR_ADMISSION_SOURCE_DIRECTORY');
  const identities=value=>value.inventory.roles.map(role=>({oid:role.oid,name:role.rolname})).sort((a,b)=>a.oid.localeCompare(b.oid));assert.equal(canonical(identities(prior.source)),canonical(identities(current)),'QA_PRIOR_ADMISSION_ROLE_SET');
  const bytes=await readFile(prior.details.admission.credentialFile);assert.equal(createHash('sha256').update(bytes).digest('hex'),prior.details.admission.credentialHash,'QA_PRIOR_ADMISSION_CREDENTIAL_HASH');
  const credentials=JSON.parse(bytes.toString('utf8'));bytes.fill(0);
  assert.deepEqual(Object.keys(credentials).sort(),['controlId','format','roles']);assert.equal(credentials.format,'RUNTIME_COLD_CREDENTIALS_V1');assert.equal(credentials.controlId,prior.source.controlId);
  assert.deepEqual(Object.keys(credentials.roles).sort(),prior.source.inventory.roles.filter(role=>role.rolcanlogin).map(role=>role.rolname).sort());assert(Object.values(credentials.roles).every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)));
  try{
    const generation=await createRuntimeColdConfigGenerationV1(join(fixture.root,'current-admission-generation'),credentials),configurationFile=await generation.clone(fixture.configurationFile);await generation.finish();
    const remap=file=>generation.records.find(record=>record.source===file)?.target??file,declaration=JSON.parse(await readFile(configurationFile,'utf8'));
    const paths=new Map([...fixture.paths].map(([name,file])=>[name,remap(file)])),http=new Map([...fixture.http].map(([name,file])=>[name,remap(file)]));
    return {...fixture,configurationFile,declaration,config:{...fixture.config,configurationFile},paths,http,components:declaration.components,deliveryFiles:fixture.deliveryFiles?.map(remap),retiredFiles:fixture.retiredFiles?.map(remap),keyFile:fixture.keyFile?remap(fixture.keyFile):undefined,currentAdmissionProjection:{format:'COLD_CORE_CURRENT_ADMISSION_PROJECTION_QA_V1',sourceHash:fixture.trust.sourceHash,priorControlId:prior.source.controlId,priorSourceHash:priorTrust.sourceHash,credentialHash:prior.details.admission.credentialHash,files:generation.records.length,actualPriorAdmittedTargetIsCurrentSource:true,priorRuntimeRolesBoundByOidAndName:true,onlySqlPasswordsAndGraphReferencesChanged:true,currentTargetSqlPasswordsVerified:false,fullGoalComplete:false},async rotateJobKey(tenant){await this.change(paths.get(tenant+'-job-key.private.json'),value=>{value.keys[0].key=randomBytes(32).toString('base64url');});}};
  }finally{for(const name of Object.keys(credentials.roles))credentials.roles[name]='';}
}
