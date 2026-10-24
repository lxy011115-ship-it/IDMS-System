import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {platformDependencyConfigV3,inspectPlatformDependencyFilesV3} from '../scripts/platform-dependency-config-v3.mjs';
import {dependencyV3Config,dependencyV3Files,fieldSlotFixtureV3} from './fixtures/platform-dependency-v3-input.mjs';

test('strict explicit field slots reject hidden disabled resources, collisions, partial coverage and PGDATA placement',()=>{
 const base=resolve('work/platform-field-schema-not-created'),raw=dependencyV3Config(base);assert.deepEqual(platformDependencyConfigV3(raw),raw);const enabled={...raw,field:fieldSlotFixtureV3(base)};assert.deepEqual(platformDependencyConfigV3(enabled),enabled);
 for(const mutate of [v=>v.field.extra=true,v=>v.field.brokers[0].id='applications',v=>v.field.brokers[0].port=v.identity.port+10000,v=>v.field.edges[0].brokerId='foreign',v=>v.field.edges.push({...v.field.edges[0],id:'duplicate-channel'}),v=>v.field.edges[0].workDirectory=v.postgres[0].dataDirectory,v=>v.field.edges[0].registrationFile='relative.json',v=>v.field.brokers.push({...v.field.brokers[0],id:'unused',port:24505})]){const bad=structuredClone(enabled);mutate(bad);assert.throws(()=>platformDependencyConfigV3(bad),/PLATFORM_/);}
 assert.throws(()=>platformDependencyConfigV3({...raw,field:{enabled:false,brokers:[]}}),/PLATFORM_FIELD_FIELDS/);
});

test('disabled V3 inspection retains workflow/predictor checks and does not load any broker or edge material',async()=>{
 const f=await dependencyV3Files('disabled'),value=await inspectPlatformDependencyFilesV3(f.config);assert.equal(value.field,null);assert(value.pins.some(p=>p.path===f.siteFile));assert(!(await readdir(f.base)).some(n=>n.includes('not-created')));
 const base=f.bases[1],before=await readFile(base.file);try{await writeFile(base.file,JSON.stringify({...base.value,predictor:{...base.value.predictor,serviceToken:'wrong'}}));await assert.rejects(inspectPlatformDependencyFilesV3(f.config),/PLATFORM_PREDICTOR_CLIENT_BINDING/);}finally{await writeFile(base.file,before);}
});

test('manifest switch disagreement refuses before absent field gateway or transport files are read',async()=>{
 const f=await dependencyV3Files('switch'),m={...f.manifest,field:{enabled:true,siteComponentId:'site'}};await writeFile(f.config.applicationManifestFile,JSON.stringify(m));await assert.rejects(inspectPlatformDependencyFilesV3(f.config),/PLATFORM_FIELD_ENABLED_MISMATCH/);
});
