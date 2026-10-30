import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createPlatformDependenciesV7} from '../scripts/platform-dependency-controller-v7.mjs';
import {dependencyV3Files} from './fixtures/platform-dependency-v3-input.mjs';

test('cancelled V7 controller retains its own API, fixed stop request, and zero actual resource creation',async()=>{
 const f=await dependencyV3Files('controller-cancel'),abort=new AbortController();abort.abort();const api=await createPlatformDependenciesV7(f.config,{startupSignal:abort.signal});await assert.rejects(api.ready,/PLATFORM_DEPENDENCY_START_CANCELLED/);const done=await api.closed;
 assert(done.normal&&done.startupCancelled&&done.allOwnedResourcesRetired&&!done.fullyReady);assert.equal(done.componentsCreated,0);assert.equal(done.formalFieldActivationGranted,false);assert.deepEqual(api.resources(),[]);assert.deepEqual(await api.close({requestId:done.requestId}),done);assert.throws(()=>api.close({requestId:randomUUID()}),/PLATFORM_DEPENDENCY_STOP_REQUEST_CHANGED/);assert.throws(()=>api.close({pid:12345}),/PLATFORM_DEPENDENCY_STOP_REQUEST/);assert(!(await readdir(f.base)).some(n=>n.includes('not-created')));
});
