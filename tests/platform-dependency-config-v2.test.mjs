import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {writeFile,readFile,readdir,link,unlink} from 'node:fs/promises';
import {platformDependencyConfigV2,inspectPlatformDependencyFilesV2} from '../scripts/platform-dependency-config-v2.mjs';
import {dependencyV2Config,dependencyV2Files} from './fixtures/platform-dependency-v2-input.mjs';

test('the predictor is required and cannot inject a process, program or undeclared field',()=>{
 const c=dependencyV2Config(resolve('work/platform-dependency-v2-pure'));
 assert.deepEqual(platformDependencyConfigV2(c),c);const missing=structuredClone(c);delete missing.predictor;assert.throws(()=>platformDependencyConfigV2(missing),/PLATFORM_DEPENDENCY_FIELDS/);
 for(const key of ['pid','entry','environment','command']){const bad=structuredClone(c);bad.predictor[key]=key==='pid'?12345:'arbitrary';assert.throws(()=>platformDependencyConfigV2(bad),/PLATFORM_PREDICTOR_FIELDS/);}
 const id=structuredClone(c);id.predictor.id='applications';assert.throws(()=>platformDependencyConfigV2(id),/PLATFORM_PREDICTOR_ID/);
});

test('predictor records and endpoints cannot collide with PGDATA, SQL, JVM or management ports',()=>{
 const c=dependencyV2Config(resolve('work/platform-dependency-v2-pure'));
 for(const port of [24501,24502,34501,44501,1024,65536]){const bad=structuredClone(c);bad.predictor.port=port;assert.throws(()=>platformDependencyConfigV2(bad),/PLATFORM_PREDICTOR_PORT_COLLISION/);}
 for(const field of ['workDirectory','runtimeFile']){const bad=structuredClone(c);bad.predictor[field]=join(bad.postgres[0].dataDirectory,'predictor');assert.throws(()=>platformDependencyConfigV2(bad),/PLATFORM_RECORD_OR_PROGRAM_IN_PGDATA/);}
});

test('every tenant must use the unchanged exact service address, token and tenant binding',async()=>{
 const f=await dependencyV2Files('bindings'),valid=await inspectPlatformDependencyFilesV2(f.config);assert.equal(valid.pins.length,7);
 for(const base of f.bases){
  for(const client of [{...base.value.predictor,baseUrl:'http://localhost:24503'},{...base.value.predictor,baseUrl:'http://127.0.0.1:24504'},{...base.value.predictor,serviceToken:f.serviceToken+'changed'},{...base.value.predictor,pid:1234}]){
   try{await writeFile(base.file,JSON.stringify({...base.value,predictor:client}));await assert.rejects(inspectPlatformDependencyFilesV2(f.config),e=>e.message==='PLATFORM_PREDICTOR_CLIENT_BINDING'&&!e.message.includes(f.serviceToken));}finally{await writeFile(base.file,JSON.stringify(base.value));}
  }
  try{await writeFile(base.file,JSON.stringify({...base.value,business:{binding:{tenantId:base.tenant==='acme'?'sandbox':'acme'}}}));await assert.rejects(inspectPlatformDependencyFilesV2(f.config),/PLATFORM_PREDICTOR_CLIENT_TENANT/);}finally{await writeFile(base.file,JSON.stringify(base.value));}
 }
 assert.deepEqual(await readdir(f.config.workDirectory),[]);assert.equal((await inspectPlatformDependencyFilesV2(f.config)).pins.length,7);
});

test('invalid, aliased and redirected predictor runtime files fail before records or programs are created',async()=>{
 const f=await dependencyV2Files('runtime'),before=await readFile(f.config.predictor.runtimeFile),runtime=JSON.parse(before);
 for(const value of [{...runtime,host:'0.0.0.0'},{...runtime,port:24504},{...runtime,serviceToken:'short'}]){
  try{await writeFile(f.config.predictor.runtimeFile,JSON.stringify(value));await assert.rejects(inspectPlatformDependencyFilesV2(f.config),/PLATFORM_PREDICTOR_RUNTIME(?:_ENDPOINT)?$/);}finally{await writeFile(f.config.predictor.runtimeFile,before);}
 }
 const alias=join(f.base,'predictor-alias.json');await link(f.config.predictor.runtimeFile,alias);try{await assert.rejects(inspectPlatformDependencyFilesV2(f.config),/PLATFORM_DEPENDENCY_FILE_READ/);}finally{await unlink(alias);}
 try{await writeFile(f.config.predictor.runtimeFile,'{"serviceToken":"sensitive-fragment" invalid}');await assert.rejects(inspectPlatformDependencyFilesV2(f.config),e=>e.message==='PLATFORM_DEPENDENCY_FILE_READ'&&!e.message.includes('sensitive-fragment'));}finally{await writeFile(f.config.predictor.runtimeFile,before);}
 assert.deepEqual(await readdir(f.config.workDirectory),[]);
});

test('an alternate wrapper kind cannot conceal a predictive consumer',async()=>{
 const f=await dependencyV2Files('wrapper'),file=f.bases[1].wrapperFile,before=await readFile(file),value=JSON.parse(before);
 try{await writeFile(file,JSON.stringify({...value,kind:'GOVERNANCE'}));await assert.rejects(inspectPlatformDependencyFilesV2(f.config),/PLATFORM_PREDICTOR_WORKER_ENTRY/);}finally{await writeFile(file,before);}
});
