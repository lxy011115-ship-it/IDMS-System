import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {readdir,link,unlink} from 'node:fs/promises';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {predictorRuntimeV1} from '../scripts/predictor-runtime-v1.mjs';
import {launchPredictorLifecycleV1,bindPredictorLifecycleV1,stopPredictorLifecycleV1,inspectPredictorLifecycleV1} from '../scripts/predictor-lifecycle-v1.mjs';

test('predictor fixed runtime rejects non-loopback, unknown controls and invalid private credentials',()=>{
 const value={format:1,purpose:'PREDICTOR_SERVICE',host:'127.0.0.1',port:24500,serviceToken:'t'.repeat(43)};assert.deepEqual(predictorRuntimeV1(value),value);
 for(const wrong of[{...value,host:'0.0.0.0'},{...value,port:0},{...value,port:65536},{...value,pid:1234},{...value,entry:'foreign.mjs'},{...value,serviceToken:'short'},{...value,serviceToken:'t'.repeat(40)+'\r\n'}])assert.throws(()=>predictorRuntimeV1(wrong),/^Error: PREDICTOR_CONFIG_[A-Z_]+$/);
});
test('predictor lifetime rejects PID-shaped and cloned handles without adopting processes',async()=>{
 const forged=Object.freeze({process:{pid:process.pid},directory:process.cwd()});assert.throws(()=>stopPredictorLifecycleV1(forged),/PREDICTOR_LIFECYCLE_HANDLE/);assert.throws(()=>inspectPredictorLifecycleV1(forged),/PREDICTOR_LIFECYCLE_HANDLE/);await assert.rejects(bindPredictorLifecycleV1(forged),/PREDICTOR_LIFECYCLE_HANDLE/);
 await assert.rejects(launchPredictorLifecycleV1({runtimeFile:'unused',workDirectory:'unused',pid:process.pid}),/PREDICTOR_LIFECYCLE_INPUT/);await assert.rejects(launchPredictorLifecycleV1({runtimeFile:'unused',workDirectory:'unused',execPath:process.execPath}),/PREDICTOR_LIFECYCLE_INPUT/);
});
test('invalid and hard-linked private runtime files are refused before any child record is created',async()=>{
 const base=resolve('work/predictor-owned-lifecycle-unit-v1-20261024',randomUUID()),records=join(base,'records'),runtime=join(base,'runtime.private.json'),alias=join(base,'runtime-alias.private.json');await privateDirectory(records);await privateNewFile(runtime,'{"serviceToken":"private-input-fragment" broken}');
 await assert.rejects(launchPredictorLifecycleV1({runtimeFile:runtime,workDirectory:records}),error=>error.message==='PREDICTOR_RUNTIME_READ'&&!error.message.includes('private-input-fragment'));assert.deepEqual(await readdir(records),[]);
 const valid=join(base,'valid.private.json');await privateNewFile(valid,JSON.stringify({format:1,purpose:'PREDICTOR_SERVICE',host:'127.0.0.1',port:24501,serviceToken:'u'.repeat(43)}));await link(valid,alias);try{await assert.rejects(launchPredictorLifecycleV1({runtimeFile:alias,workDirectory:records}),/PREDICTOR_RUNTIME_READ/);assert.deepEqual(await readdir(records),[]);}finally{await unlink(alias);}
});
