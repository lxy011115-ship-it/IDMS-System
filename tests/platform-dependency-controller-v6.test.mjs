import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createPlatformDependenciesV6} from '../scripts/platform-dependency-controller-v6.mjs';
import {dependencyV2Files} from './fixtures/platform-dependency-v2-input.mjs';

test('an already-cancelled controller retains its API and creates no PG, JVM, predictor or application',async()=>{
 const f=await dependencyV2Files('cancel'),abort=new AbortController();abort.abort();
 const api=await createPlatformDependenciesV6(f.config,{startupSignal:abort.signal});await assert.rejects(api.ready,/PLATFORM_DEPENDENCY_START_CANCELLED/);
 const done=await api.closed;assert(done.normal&&done.startupCancelled&&done.allOwnedResourcesRetired&&!done.fullyReady);assert.equal(done.componentsCreated,0);assert.deepEqual(api.resources(),[]);
 assert.equal(api.status().phase,'CLOSED');assert.deepEqual(await api.close({requestId:done.requestId}),done);assert.throws(()=>api.close({requestId:randomUUID()}),/PLATFORM_DEPENDENCY_STOP_REQUEST_CHANGED/);
 assert.throws(()=>api.close([]),/PLATFORM_DEPENDENCY_STOP_REQUEST/);assert.throws(()=>api.close({pid:12345}),/PLATFORM_DEPENDENCY_STOP_REQUEST/);
 assert(!(await readdir(f.base)).some(n=>n.includes('not-created')));
});

test('credential and malformed graph failures happen before any controller record and remain redacted',async()=>{
 const f=await dependencyV2Files('preflight'),records=await readdir(f.config.workDirectory),base=f.bases[1],before=await readFile(base.file);
 try{
  await writeFile(base.file,JSON.stringify({...base.value,predictor:{...base.value.predictor,serviceToken:f.serviceToken+'wrong'}}));await assert.rejects(createPlatformDependenciesV6(f.config),e=>e.message==='PLATFORM_PREDICTOR_CLIENT_BINDING'&&!e.message.includes(f.serviceToken));assert.deepEqual(await readdir(f.config.workDirectory),records);
  await writeFile(base.file,before);const graph=f.bases[0].wrapperFile,original=await readFile(graph);
  try{await writeFile(graph,'{"password":"sensitive-private-graph-fragment" invalid}');await assert.rejects(createPlatformDependenciesV6(f.config),e=>e.message==='PLATFORM_DEPENDENCY_FILE_READ'&&!e.message.includes('sensitive-private-graph-fragment'));}finally{await writeFile(graph,original);}
  assert.deepEqual(await readdir(f.config.workDirectory),records);
 }finally{await writeFile(base.file,before);}
});
