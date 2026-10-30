import {resolve,dirname} from 'node:path';
import {applicationManifestV1,readApplicationFileV1,applicationNeedV1 as need} from './runtime-application-config-v1.mjs';
import {fieldMapSiteRuntimeConfigV1} from './field-map-site-runtime-v1.mjs';

const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export function applicationManifestV2(raw){
 need(exact(raw,['format','purpose','registryDirectory','trustFile','authorityRuntimeFile','binding','tenantIds','components','field'])&&raw.format===2&&raw.purpose==='RUNTIME_APPLICATION_SUITE_V2','APPLICATION_MANIFEST_FIELDS');
 const {field,...base}=raw;applicationManifestV1({...base,format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1'});
 need(field&&typeof field.enabled==='boolean'&&(field.enabled?exact(field,['enabled','siteComponentId']):exact(field,['enabled'])),'APPLICATION_FIELD_FIELDS');
 const site=raw.components.find(c=>c.kind==='SITE');
 need(!field.enabled||field.siteComponentId===site.id,'APPLICATION_FIELD_SITE_SLOT');
 return structuredClone(raw);
}

/** Read only the SITE wrapper; a mismatched switch never follows gatewayFile. */
export async function inspectApplicationFieldSlotV2(manifestFile,input){
 const manifest=applicationManifestV2(input),site=manifest.components.find(c=>c.kind==='SITE');
 const item=await readApplicationFileV1(resolve(dirname(resolve(manifestFile)),site.runtimeFile));
 let wrapper;try{wrapper=fieldMapSiteRuntimeConfigV1(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(item.bytes).replace(/^\uFEFF/,'')));}catch{throw Error('APPLICATION_FIELD_SITE_RUNTIME');}
 need(wrapper.field.enabled===manifest.field.enabled,'APPLICATION_FIELD_ENABLED_MISMATCH');
 return{component:site,runtimeFile:item.path,pin:{path:item.path,sha256:item.sha256},enabled:wrapper.field.enabled};
}
