import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {observeControlledColdStageQaV3} from '../scripts/fixtures/controlled-cold-stage-diagnostic-v3-qa.mjs';
const stages=['FIELD_CURRENT_FREEZE','FIELD_CURRENT_ARCHIVE','FIELD_CURRENT_READER_BUILD','FIELD_CURRENT_RESTORE','FIELD_CURRENT_PREPARE','FIELD_CURRENT_VERIFY'];
test('every actual current FIELD helper stage executes once with a distinct bounded observation',async()=>{
 const helper=await readFile(new URL('../scripts/fixtures/field-current-materials-native-v1-qa.mjs',import.meta.url),'utf8');assert.deepEqual([...new Set([...helper.matchAll(/observe\('([A-Z_]+)'/g)].map(match=>match[1]))],stages);
 for(const stage of stages){const report={},events=[];let calls=0;const value=await observeControlledColdStageQaV3(stage,async()=>{calls++;return {actual:true};},{report,emit:event=>events.push(event)});assert.equal(calls,1);assert.deepEqual(value,{actual:true});assert.deepEqual(events.map(value=>[value.stage,value.phase]),[[stage,'STARTED'],[stage,'SUCCEEDED']]);assert.deepEqual(report.controlledColdStageDiagnostics,events);assert(events.every(value=>value.format==='IDMS_CONTROLLED_COLD_STAGE_DIAGNOSTIC_V3'&&!value.rawFailureOrCredentialsPrinted));}
});
test('unknown or externally supplied stages cannot execute an operation',async()=>{
 for(const stage of ['FIELD_CURRENT_UNKNOWN','FIELD_CURRENT_VERIFY extra',null,{},'']){let calls=0;await assert.rejects(observeControlledColdStageQaV3(stage,async()=>{calls++;},{report:{},emit(){}}),/CONTROLLED_COLD_DIAGNOSTIC_INPUT/);assert.equal(calls,0);}
});
test('failure preserves the actual exception while emitted records omit private messages',async()=>{
 const privateText='private-marker-that-must-never-be-emitted',error=Object.assign(Error(privateText),{password:privateText}),events=[],report={};await assert.rejects(observeControlledColdStageQaV3('FIELD_CURRENT_VERIFY',async()=>{throw error;},{report,emit:event=>events.push(event)}),actual=>actual===error);assert.deepEqual(events.map(value=>value.phase),['STARTED','FAILED']);assert(!JSON.stringify(events).includes(privateText));assert(events[1].failure.messageSha256);assert.equal(events[1].failure.rawFailureOrCredentialsPrinted,false);
});
test('observation emission failure is recorded without replacing the actual operation result',async()=>{
 const report={};let calls=0;assert.equal(await observeControlledColdStageQaV3('FIELD_CURRENT_RESTORE',async()=>{calls++;return 17;},{report,emit(){throw Error('private sink unavailable');}}),17);assert.equal(calls,1);assert.equal(report.controlledColdDiagnosticEmissionFailed,true);assert.equal(report.controlledColdStageDiagnostics.at(-1).emissionFailed,true);
});
