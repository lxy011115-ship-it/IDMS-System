import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {dependencyV2Config,dependencyV2Files} from './platform-dependency-v2-input.mjs';
import {privateNewFile} from '../../scripts/backup-support.mjs';

export function dependencyV3Config(base){return{...dependencyV2Config(base),format:3,purpose:'PLATFORM_DEPENDENCIES_V3',field:{enabled:false}};}
export function fieldSlotFixtureV3(base){return{enabled:true,brokers:[{id:'field-broker',runtimeFile:join(base,'broker-missing.json'),workDirectory:join(base,'broker-not-created'),port:24504}],edges:[{id:'field-edge',brokerId:'field-broker',tenantId:'acme',edgeId:'edge-acme',configurationFile:join(base,'materials-missing.json'),edgeConfigurationFile:join(base,'edge-missing.json'),registrationFile:join(base,'registration-missing.json'),workDirectory:join(base,'edge-not-created')}]};}
export async function dependencyV3Files(label){
 const f=await dependencyV2Files('v3-'+label),config={...f.config,format:3,purpose:'PLATFORM_DEPENDENCIES_V3',field:{enabled:false}},manifest=JSON.parse(await readFile(config.applicationManifestFile,'utf8'));
 manifest.format=2;manifest.purpose='RUNTIME_APPLICATION_SUITE_V2';manifest.field={enabled:false};await writeFile(config.applicationManifestFile,JSON.stringify(manifest));
 const siteFile=manifest.components.find(c=>c.kind==='SITE').runtimeFile,baseRuntimeFile=join(f.base,'base-site.json');await privateNewFile(baseRuntimeFile,'{}');await writeFile(siteFile,JSON.stringify({format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile,field:{enabled:false}}));
 return{...f,config,manifest,siteFile};
}
