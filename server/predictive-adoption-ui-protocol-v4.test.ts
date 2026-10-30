import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRecords,unresolved} from '../public/predictive-console-protocol-v4-r2.js';
const command='341058d1-e6a3-4af1-9965-1ae10da541e5',control='b1a1c375-9bfd-419c-9bfc-9cd695f9a51a',job='65e9c739-2ce6-401c-84bb-d85c94933248';
test('adoption storage retains only bounded recovery metadata, never historical context or current credentials',()=>{
 const value={kind:'ADOPTION',commandId:command,controlId:control,expectedNativeHash:'a'.repeat(64),recoverClosedAcceptance:true,status:'UNKNOWN',jobId:job,action:'REVIEW',context:{actorId:'other'},sid:'credential',result:{order:{}},plan:{envelope:{}},comment:'private review',reference:{kind:'SESSION',value:'credential'}};
 assert.deepEqual(safeRecords([value]),[{kind:'ADOPTION',controlId:control,commandId:command,recoverClosedAcceptance:true,status:'UNKNOWN',expectedNativeHash:'a'.repeat(64),jobId:job,action:'REVIEW'}]);assert.ok(unresolved(safeRecords([value])[0]));
});
test('malformed or duplicated adoption decisions cannot replace an earlier recovery identity',()=>{
 const base={kind:'ADOPTION',commandId:command,controlId:control,recoverClosedAcceptance:false,status:'ACCEPTED'};
 assert.equal(safeRecords([{...base,expectedNativeHash:'bad'},{...base,jobId:'bad'},{...base,recoverClosedAcceptance:'true'}]).length,0);
 assert.deepEqual(safeRecords([base,{...base,commandId:job,status:'COMMITTED'}]),[base]);
 assert.equal(safeRecords(Array.from({length:100},(_,i)=>({...base,controlId:control.slice(0,-3)+i.toString(16).padStart(3,'0')}))).length,30);
});
test('read-only control lookup can be saved without a resend hash; ordinary command and independent retry keep separate identities',()=>{
 const values=safeRecords([{kind:'ADOPTION',controlId:control,commandId:command,recoverClosedAcceptance:false,status:'COMMITTED'},{kind:'COMMAND',commandId:command,status:'UNKNOWN'},{kind:'RETRY',controlId:control,jobId:job,expectedGrantRevision:'3',status:'UNKNOWN'}]);
 assert.equal(values.length,3);assert.equal('expectedNativeHash'in values[0],false);assert.equal(unresolved(values[0]),false);assert.ok(unresolved(values[1])&&unresolved(values[2]));
});
