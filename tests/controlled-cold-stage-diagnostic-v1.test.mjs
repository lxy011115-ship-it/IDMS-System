import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {summarizeControlledColdFailureQaV1,observeControlledColdStageQaV1} from '../scripts/fixtures/controlled-cold-stage-diagnostic-v1-qa.mjs';

test('unknown failure body, command arguments and child output are represented only by digests',()=>{
  const secret=randomBytes(32).toString('base64url'),error=Object.assign(Error(secret),{code:'ECONNREFUSED',cmd:'fixed-program '+secret,stdout:secret,stderr:secret+'\nSITE_AUTHORITY_RUNTIME_FAILED\n',signal:'SIGTERM'}),summary=summarizeControlledColdFailureQaV1(error);
  assert.equal(summary.errorCode,'ECONNREFUSED');assert.deepEqual(summary.knownChildFailureCodes,['SITE_AUTHORITY_RUNTIME_FAILED']);assert(summary.childExecFailure);assert.match(summary.messageSha256,/^[a-f0-9]{64}$/);assert(!JSON.stringify(summary).includes(secret));assert.equal(summary.rawFailureOrCredentialsPrinted,false);
});
test('an actual owned child exit is classified without replacing the original failure or leaking its output',async()=>{
  const marker=randomBytes(24).toString('hex'),report={},events=[];let original;
  const task=promisify(execFile)(process.execPath,['-e','process.stderr.write('+JSON.stringify(marker)+');process.exitCode=7;'],{windowsHide:true});task.catch(()=>{});
  await assert.rejects(observeControlledColdStageQaV1('WORKFLOW_REATTACH',async()=>{try{return await task;}catch(error){original=error;throw error;}},{report,emit:value=>events.push(value)}),error=>error===original);
  assert.equal(task.child.exitCode,7);assert.equal(task.child.signalCode,null);assert(task.child.stdout.closed&&task.child.stderr.closed);
  const failure=events.find(value=>value.phase==='FAILED').failure;assert.equal(failure.childExitCode,7);assert(failure.childExecFailure&&failure.childStderrBytes>0);assert.match(failure.childStderrSha256,/^[a-f0-9]{64}$/);assert(!JSON.stringify(events).includes(marker));assert.equal(report.controlledColdCurrentStage,'WORKFLOW_REATTACH');
});
test('a pending stage reports a bounded resource heartbeat and then preserves its actual result',async()=>{
  const report={},events=[];let release;const pending=new Promise(ok=>release=ok);
  const result=await observeControlledColdStageQaV1('LOCAL_RUNTIME_LOAD',()=>pending,{report,heartbeatMs:10,emit:value=>{events.push(value);if(value.phase==='WAITING')release(42);}});
  assert.equal(result,42);assert(events.some(value=>value.phase==='WAITING'));assert.deepEqual(report.controlledColdStageDiagnostics.map(value=>value.phase),['STARTED','SUCCEEDED']);
  for(const value of events)assert(Object.values(value.resources).every(count=>Number.isInteger(count)&&count>=0));
});
