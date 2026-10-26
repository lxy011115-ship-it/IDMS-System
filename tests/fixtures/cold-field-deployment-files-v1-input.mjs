import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {coldFieldMaterialActualInputQaV1} from './cold-field-material-source-files-v1-input.mjs';

/** Copies existing accepted case files into an isolated QA directory; never starts a runtime. */
export async function coldFieldDeploymentFilesActualInputQaV1({disabled=false}={}){
  const input=await coldFieldMaterialActualInputQaV1(),original=resolve(process.env.IDMS_COLD_FIELD_MATERIAL_QA_CASE),report=JSON.parse(await readFile(join(original,'verification.json'),'utf8'));
  const directory=input.directory,json=input.json,save=input.save,originalMaterials=join(original,'field-site-materials');
  const rebased=path=>{const rel=relative(originalMaterials,resolve(path));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));return join(directory,rel);};
  const siteFile=join(directory,'site.json');let site;
  if(disabled){
    const manifest=await json(report.fieldColdSourceCreation.disabledManifestFile),member=manifest.components.find(value=>value.kind==='SITE');assert(member);
    site=await json(resolve(dirname(report.fieldColdSourceCreation.disabledManifestFile),member.runtimeFile));assert.equal(site.field.enabled,false);
  }else{site=await json(siteFile);assert.equal(site.field.enabled,true);}
  const base=join(directory,'base-site.private.json');await copyFile(resolve(dirname(siteFile),site.baseRuntimeFile),base);site.baseRuntimeFile=base;
  let gateway,gatewayFile,hostFile,platformFile,brokerFile,broker,programDirectory;
  if(!disabled){
    gatewayFile=rebased(site.field.gatewayFile);site.field.gatewayFile=gatewayFile;gateway=await json(gatewayFile);
    hostFile=join(directory,'authority-host.private.json');await copyFile(resolve(dirname(gatewayFile),gateway.authorityHostFile),hostFile);const host=await json(hostFile);
    for(const [name,file]of [['coldTrustFile','host-cold-trust.private.json'],['authorityRuntimeFile','host-authority-runtime.private.json']]){const target=join(directory,file);await copyFile(resolve(dirname(hostFile),host[name]),target);host[name]=target;}
    await save(hostFile,host);gateway.authorityHostFile=hostFile;gateway.platformFile=rebased(gateway.platformFile);gateway.intakeFile=rebased(gateway.intakeFile);await save(gatewayFile,gateway);platformFile=gateway.platformFile;
    brokerFile=join(directory,'broker-runtime.private.json');broker=await json(brokerFile);
    for(const section of ['server','probe'])for(const name of Object.keys(broker[section]))if(name.endsWith('File'))broker[section][name]=rebased(broker[section][name]);
    programDirectory=join(directory,'broker-program');await mkdir(programDirectory);
    const names=[process.platform==='win32'?'mosquitto.exe':'mosquitto'];if(process.platform==='win32')for(const value of await readdir(broker.toolingDirectory,{withFileTypes:true}))if(value.name.toLowerCase().endsWith('.dll')){assert(value.isFile()&&!value.isSymbolicLink());names.push(value.name);}
    for(const name of names)await copyFile(join(broker.toolingDirectory,name),join(programDirectory,name));broker.toolingDirectory=programDirectory;await save(brokerFile,broker);
  }
  await save(siteFile,site);
  const descriptor={format:'idms-cold-field-deployment-materials-v1',siteRuntimeFile:siteFile,brokerRuntimeFile:disabled?null:brokerFile,tenantMaterials:disabled?[]:[{tenantId:input.configuration.tenantId,configurationFile:input.configurationFile}]};
  const configurationFile=join(directory,'cold-deployment-materials.json');await save(configurationFile,descriptor);
  return {...input,configurationFile,channelConfigurationFile:input.configurationFile,descriptor,siteFile,site,gatewayFile,gateway,hostFile,platformFile,brokerFile,broker,programDirectory,context:{trust:input.sourceModes.find(value=>value.mode===(disabled?'EXPLICIT_DISABLED':'ENABLED')).trust,roots:[directory]}};
}
