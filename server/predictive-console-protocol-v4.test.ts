import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {safeRecords,unresolved,canonical,digest} from '../public/predictive-console-protocol-v4.js';
const commandId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',controlId='33333333-3333-4333-8333-333333333333';
test('browser recovery storage strips bodies, results, identity credentials and unknown fields',()=>{
 const row={kind:'COMMAND',commandId,jobId,requestHash:'a'.repeat(64),action:'REVIEW',status:'COMMITTED',csrfToken:'private',sid:'private',body:{comment:'private'},result:{evidence:'private'}};
 assert.deepEqual(safeRecords([row]),[{kind:'COMMAND',commandId,jobId,requestHash:'a'.repeat(64),action:'REVIEW',status:'COMMITTED'}]);
 assert.equal(JSON.stringify(safeRecords([row])).includes('private'),false);
 assert.equal(safeRecords(Array.from({length:40},(_,i)=>({...row,commandId:i.toString(16).padStart(8,'0')+commandId.slice(8)}))).length,30);
});
test('retry recovery requires its original SQL job and canonical positive bounded grant revision',()=>{
 const row={kind:'RETRY',controlId,jobId,expectedGrantRevision:'9223372036854775807',status:'UNKNOWN'};
 assert.deepEqual(safeRecords([row]),[row]);assert.ok(unresolved(row));
 for(const patch of [{jobId:undefined},{controlId:'invalid'},{expectedGrantRevision:'0'},{expectedGrantRevision:'01'},{expectedGrantRevision:'9223372036854775808'},{expectedGrantRevision:1}])assert.deepEqual(safeRecords([{...row,...patch}]),[]);
});
test('unknown command acceptance remains unresolved until an original job or durable close is known',()=>{
 assert.ok(unresolved({kind:'COMMAND',commandId,status:'UNKNOWN'}));
 assert.ok(unresolved({kind:'COMMAND',commandId,status:'ACCEPTED'}));
 for(const status of ['CLOSED','NOT_ENQUEUED','COMMITTED','CANCELLED','FAILED'])assert.equal(unresolved({kind:'COMMAND',commandId,status}),false);
 assert.equal(unresolved({kind:'COMMAND',commandId,jobId,status:'RUNNING'}),false);
 assert.equal(safeRecords([{kind:'COMMAND',commandId,status:'INVENTED'}])[0].status,'UNKNOWN');
 assert.equal(safeRecords([{kind:'COMMAND',commandId},{kind:'COMMAND',commandId}]).length,1);
});
test('browser command hash is canonical and matches the native SHA-256 request digest',async()=>{
 const a={command:{kind:'REVIEW',decision:'APPROVED',comment:'独立复核'},commandId},b={commandId,command:{comment:'独立复核',decision:'APPROVED',kind:'REVIEW'}};
 assert.equal(canonical(a),canonical(b));assert.equal(await digest(a),createHash('sha256').update(canonical(a)).digest('hex'));
 assert.notEqual(await digest(a),await digest({...a,command:{...a.command,comment:'修改意见'}}));
});
