import test from 'node:test';
import assert from 'node:assert/strict';
import {TelemetryIntakeDiagnostics} from './telemetry-intake-diagnostics.ts';
import {confirmCommit} from './sql-commit.ts';
test('intake diagnostics classify fixed failures and never expose arbitrary errors or event data',()=>{
 const d=new TelemetryIntakeDiagnostics();for(const code of ['MEMORY_BUDGET','COMMIT_UNCONFIRMED','WRITE_POSTIMAGE_MISMATCH','QUEUE_EXPIRED','SECRET SQL tenant=customer'])d.begin().failed({code,message:'password and payload'});
 const s=d.snapshot();assert.equal(s.counters.received,5);assert.equal(s.counters.capacityRejected,1);assert.equal(s.counters.integrityRejected,1);assert.equal(s.counters.commitUnconfirmed,1);assert.equal(s.counters.queueRejected,1);assert.equal(s.counters.transactionFailed,1);assert.equal(s.code,'TRANSACTION_FAILED');assert.equal(JSON.stringify(s).includes('password'),false);assert.equal(JSON.stringify(s).includes('customer'),false);
});
test('commit, queued ACK and broker confirmation remain distinct; late ACK does not overwrite newer failure',()=>{
 const d=new TelemetryIntakeDiagnostics(),a=d.begin();a.stage('TRANSACTION');assert.equal(d.snapshot().counters.ackQueued,0);a.committed('REJECTED');a.ackQueued();assert.equal(d.snapshot().stage,'ACK_QUEUED');const b=d.begin();b.failed({code:'MEMORY_BUDGET'});a.acknowledged(true);assert.equal(d.snapshot().stage,'FAILED');assert.equal(d.snapshot().code,'MEMORY_BUDGET');assert.equal(d.snapshot().counters.ackConfirmed,1);assert.equal(d.snapshot().endToEndDeliveryConfirmed,false);
});
test('COMMIT transport failure is explicitly unconfirmed and does not retry',async()=>{
 const calls:string[]=[];await assert.rejects(confirmCommit({query:async sql=>{calls.push(sql);throw Error('wire lost after server commit');}}),(error:any)=>error.code==='COMMIT_UNCONFIRMED'&&!error.message.includes('wire lost'));assert.deepEqual(calls,['COMMIT']);await confirmCommit({query:async sql=>{calls.push(sql);}});assert.deepEqual(calls,['COMMIT','COMMIT']);
});
