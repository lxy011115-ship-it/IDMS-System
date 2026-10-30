import {createColdCoreRoleMaterialFilesQaV1} from './cold-core-role-material-files-v1-qa.mjs';
import {projectColdCoreCurrentCredentialsQaV1} from './cold-core-current-credentials-v1-qa.mjs';
import {readRuntimeColdReviewWithFieldSourceV2} from '../runtime-cold-readonly-control-v7.mjs';
import assert from 'node:assert/strict';
import {readFile,cp,copyFile,mkdir,readdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';

/** New current material copies from this same live Native's normally stopped FIELD owner. */
export async function createSharedColdCoreFieldMaterialFilesQaV2({directory:rootDirectory,originalDirectory,trust,mode,sourceCreation,authority,account}){
  const root=resolve(rootDirectory),originalRoot=resolve(originalDirectory),state=await readRuntimeColdReviewWithFieldSourceV2(trust);assert.equal(state.phase,'REVIEW_READY_V3');assert.equal(state.source.fieldSource.ownerEvidence.siteFieldEnabled,mode==='ENABLED');assert(['ENABLED','EXPLICIT_DISABLED'].includes(mode));await privateDirectory(root);const roleFiles=await createColdCoreRoleMaterialFilesQaV1({directory:join(root,'core'),originalDirectory:originalRoot,trust}),core=await projectColdCoreCurrentCredentialsQaV1({fixture:roleFiles,priorTrust:sourceCreation.priorTrust});assert.equal(canonical(core.authority),canonical(authority));const original=join(originalRoot,'field-site-materials'),directory=join(root,'field');await cp(original,directory,{recursive:true,errorOnExist:true,force:false});await privateDirectory(directory);
  const json=async file=>JSON.parse(await readFile(file,'utf8')),save=(file,value)=>writeFile(file,canonical(value)),rebase=file=>{const rel=relative(original,resolve(file));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));return join(directory,rel);};
  let originalSiteFile=join(original,'site.json');
  if(mode==='EXPLICIT_DISABLED'){const manifest=await json(sourceCreation.disabledManifestFile),site=manifest.components.find(value=>value.kind==='SITE');assert(site);originalSiteFile=resolve(dirname(sourceCreation.disabledManifestFile),site.runtimeFile);}
  const site=await json(originalSiteFile),siteFile=join(directory,'site.json');assert.equal(site.field.enabled,mode==='ENABLED');
  const baseFile=join(directory,'current-base-site.private.json'),trustFile=join(directory,'current-cold-trust.private.json'),authorityFile=core.declaration.authorityRuntimeFile,base=await json(resolve(dirname(originalSiteFile),site.baseRuntimeFile));assert.deepEqual(Object.keys(base).sort(),['baseRuntimeFile','format','purpose','trustFile']);assert.equal(base.format,1);assert.equal(base.purpose,'RUNTIME_COLD_SITE_V1');await privateNewFile(trustFile,canonical(trust));await privateNewFile(baseFile,canonical({...base,baseRuntimeFile:core.declaration.siteFile,trustFile}));site.baseRuntimeFile=baseFile;
  let brokerFile=null;
  if(site.field.enabled){
    const oldGatewayFile=resolve(dirname(originalSiteFile),site.field.gatewayFile),gatewayFile=rebase(oldGatewayFile),gateway=await json(oldGatewayFile);site.field.gatewayFile=gatewayFile;
    const oldHostFile=resolve(dirname(oldGatewayFile),gateway.authorityHostFile),host=await json(oldHostFile),hostFile=join(directory,'current-authority-host.private.json');
    host.coldTrustFile=trustFile;host.authorityRuntimeFile=authorityFile;host.controlAccount={...host.controlAccount,host:account.host,port:account.port,user:account.user,password:account.password,database:'postgres'};
    for(const tenant of host.tenants){tenant.account.host=account.host;tenant.account.port=account.port;}
    await privateNewFile(hostFile,canonical(host));gateway.authorityHostFile=hostFile;gateway.platformFile=rebase(resolve(dirname(oldGatewayFile),gateway.platformFile));gateway.intakeFile=rebase(resolve(dirname(oldGatewayFile),gateway.intakeFile));await save(gatewayFile,gateway);
    const activationFile=join(directory,'activation-materials.json'),activation=await json(activationFile);activation.intakeConfigurationFile=rebase(activation.intakeConfigurationFile);for(const edge of activation.edges)edge.configurationFile=rebase(edge.configurationFile);await save(activationFile,activation);
    brokerFile=join(directory,'broker-runtime.private.json');const broker=await json(brokerFile);for(const section of ['server','probe'])for(const name of Object.keys(broker[section]))if(name.endsWith('File'))broker[section][name]=rebase(broker[section][name]);
    const programs=join(directory,'current-broker-programs');await mkdir(programs);const names=[process.platform==='win32'?'mosquitto.exe':'mosquitto'];if(process.platform==='win32')for(const entry of await readdir(broker.toolingDirectory,{withFileTypes:true}))if(entry.name.toLowerCase().endsWith('.dll')){assert(entry.isFile()&&!entry.isSymbolicLink());names.push(entry.name);}
    for(const name of names)await copyFile(join(broker.toolingDirectory,name),join(programs,name));broker.toolingDirectory=programs;await save(brokerFile,broker);
  }
  await save(siteFile,site);const workDirectory=join(directory,'inspection');await mkdir(workDirectory);await privateDirectory(workDirectory);
  const configurationFile=join(directory,'current-deployment-materials.private.json'),descriptor={format:'idms-cold-field-deployment-materials-v2',siteRuntimeFile:siteFile,brokerRuntimeFile:brokerFile,tenantMaterials:site.field.enabled?[{tenantId:(await json(join(directory,'activation-materials.json'))).tenantId,configurationFile:join(directory,'activation-materials.json')}]:[],historicalStreamMaterials:[]};await privateNewFile(configurationFile,canonical(descriptor));
  await core.change(core.configurationFile,value=>{value.siteFile=siteFile;});const coreMaterialConfiguration={configurationFile:core.configurationFile,roots:core.config.roots},fieldMaterialConfiguration={configurationFile,roots:[directory,core.root],workDirectory};return {directory:root,core,coreMaterialConfiguration,fieldMaterialConfiguration,siteFile,coldSiteFile:baseFile,trustFile,authorityFile,trust:structuredClone(trust),mode};
}
