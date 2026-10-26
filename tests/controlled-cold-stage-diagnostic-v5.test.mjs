import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {observeControlledColdStageQaV4} from '../scripts/fixtures/controlled-cold-stage-diagnostic-v4-qa.mjs';

test('every literal stage used by the whole core/FIELD case runs through the fixed diagnostic boundary',async()=>{
  const stages=new Set();
  for(const path of ['scripts/verify-cold-core-field-composition-native-v4.mjs','scripts/fixtures/cold-core-field-composition-native-v3-qa.mjs']){
    const source=await readFile(path,'utf8');
    for(const match of source.matchAll(/\bobserve\('([A-Z][A-Z0-9_]+)'/g))stages.add(match[1]);
  }
  assert(stages.has('CORE_FIELD_CURRENT_VERIFY'));
  assert.deepEqual([...stages].sort(),['BUSINESS_CLUSTER_CREATE','CORE_FIELD_CURRENT_VERIFY','FIELD_CURRENT_ARCHIVE','FIELD_CURRENT_FREEZE','FIELD_CURRENT_PREPARE','FIELD_CURRENT_READER_BUILD','FIELD_CURRENT_RESTORE','IDENTITY_CLUSTER_CREATE','IDENTITY_CREATE','ROOT_CLEANUP','SITE_FACTORY','SITE_SEAL','WORKFLOW_BUILD']);
  for(const stage of stages){
    const report={},emitted=[],token={stage};let invoked=0;
    assert.equal(await observeControlledColdStageQaV4(stage,async()=>{invoked++;return token;},{report,emit:value=>emitted.push(value)}),token);
    assert.equal(invoked,1);
    assert.deepEqual(emitted.map(value=>value.phase),['STARTED','SUCCEEDED']);
    assert.equal(report.controlledColdCurrentStage,stage);
    assert(emitted.every(value=>value.stage===stage&&value.rawFailureOrCredentialsPrinted===false));
  }
});

test('new combined stage preserves the original failure without printing its private message',async()=>{
  const error=Error('private-diagnostic-regression-sentinel'),report={},emitted=[];
  await assert.rejects(observeControlledColdStageQaV4('CORE_FIELD_CURRENT_VERIFY',async()=>{throw error;},{report,emit:value=>emitted.push(value)}),value=>value===error);
  assert.deepEqual(emitted.map(value=>value.phase),['STARTED','FAILED']);
  assert.equal(emitted[1].failure.rawFailureOrCredentialsPrinted,false);
  assert.equal(JSON.stringify(emitted).includes(error.message),false);
  assert.match(emitted[1].failure.messageSha256,/^[a-f0-9]{64}$/);
});

test('unknown or private stage names are rejected before invoking the operation',async()=>{
  let invoked=false;
  await assert.rejects(observeControlledColdStageQaV4('PRIVATE_STAGE_SENTINEL',async()=>{invoked=true;},{report:{},emit:()=>{}}),/CONTROLLED_COLD_DIAGNOSTIC_INPUT/);
  assert.equal(invoked,false);
});
