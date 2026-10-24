import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {privateDirectory} from '../scripts/backup-support.mjs';
import {createFieldSiteStageObserverQaV1} from '../scripts/fixtures/field-site-stage-observer-v1-qa.mjs';

test('observer persists bounded live stages and preserves the exact operation result and failure',async()=>{
 const nonce=randomBytes(6).toString('hex'),work=resolve('work/field-site-observer-v1-tests',nonce),report={},result={value:'actual-result'},failure=Error('ACTUAL_QA_FAILURE');await privateDirectory(work);const observer=await createFieldSiteStageObserverQaV1({work,nonce,report,snapshot:()=>({owned:1}),heartbeatMs:20});
 assert.equal(await observer.observe('ACTUAL_WAIT',async()=>{await new Promise(ok=>setTimeout(ok,55));return result;}),result);await assert.rejects(observer.observe('ACTUAL_FAILURE',async()=>{throw failure;}),e=>e===failure);await observer.close();const records=(await readFile(join(work,'field-site-stage.private.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert(records.some(r=>r.stage==='ACTUAL_WAIT'&&r.phase==='WAITING'));assert.equal(records.at(-1).phase,'FAILED');assert(records.every((r,i)=>r.sequence===i+1&&r.nonce===nonce&&r.rawCredentialsPrinted===false));assert.equal(report.fieldSiteObservationFailed,undefined);await assert.rejects(observer.observe('AFTER_CLOSE',async()=>null),/FIELD_SITE_OBSERVER_STAGE/);
});
