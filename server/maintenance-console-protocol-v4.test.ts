import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonicalDigest} from './canonical-state.ts';
import {canonical,commandDigest,safeRecords,unresolved} from '../public/maintenance-console-protocol-v4.js';
test('maintenance browser recovery digest matches server canonical bytes for numeric keys and Unicode',async()=>{
 const command={id:randomUUID(),action:'submit',input:{customFields:{'10':'十😀','2':'二',z:false},minutes:0.1,partsUsed:['轴承','垫片'],cause:'\ud800'}};
 assert.equal(await commandDigest(command),canonicalDigest(command));assert.ok(canonical(command).includes('"10":"十😀","2":"二"'));
});
test('maintenance recovery storage strips all command text, identity tokens, results and unknown properties',()=>{
 const commandId=randomUUID(),jobId=randomUUID(),raw={commandId,jobId,requestHash:'a'.repeat(64),action:'submit',status:'ACCEPTED',command:{input:{cause:'confidential repair'}},result:{verification:'secret'},tokens:{access_token:'secret'},csrf:'secret',orderId:'secret'};
 assert.deepEqual(safeRecords([raw,raw,{commandId:'not-a-uuid',action:'submit'}]),[{commandId,jobId,requestHash:'a'.repeat(64),action:'submit',status:'ACCEPTED'}]);
 assert.equal(JSON.stringify(safeRecords([raw])).includes('secret'),false);assert.equal(unresolved({commandId,status:'UNKNOWN'}),true);assert.equal(unresolved({commandId,status:'CLOSED'}),false);
 assert.equal(safeRecords(Array.from({length:50},()=>({commandId:randomUUID(),status:'UNKNOWN'}))).length,30);
});
