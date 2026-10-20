import test from 'node:test';
import assert from 'node:assert/strict';
import {readFingerprint,readRelations} from './read-integrity.ts';
const stamp=()=>({isolation:'repeatable read',read_only:'on',database:'one',username:'app',database_oid:'1',server_started:'2026-10-16 00:00:00+00',xid_epoch:'0',view_definition:'digest',relations:readRelations.map((t,i)=>[t,String(i+1),String(i+100),'1000','tuples'])});
test('read proof cannot be reused across tenant, server, XID epoch, relation generation or tuple version',()=>{
 const base=stamp(),key=readFingerprint(base,'acme');assert.equal(readFingerprint(structuredClone(base),'acme'),key);assert.notEqual(readFingerprint(base,'sandbox'),key);
 for(const patch of [{database_oid:'2'},{server_started:'2026-10-17 00:00:00+00'},{xid_epoch:'1'},{view_definition:'other'},{username:'other'}])assert.notEqual(readFingerprint({...base,...patch},'acme'),key);
 for(const column of [1,2,3,4]){const changed=stamp();changed.relations[0][column]='changed';assert.notEqual(readFingerprint(changed,'acme'),key);}
});
test('read proof rejects incomplete dependencies and snapshots that can change between statements',()=>{
 const base=stamp();for(const patch of [{isolation:'read committed'},{read_only:'off'},{relations:base.relations.slice(1)},{relations:[...base.relations].reverse()},{relations:[null,...base.relations.slice(1)]},{server_started:undefined}])assert.throws(()=>readFingerprint({...base,...patch},'acme'));
});
