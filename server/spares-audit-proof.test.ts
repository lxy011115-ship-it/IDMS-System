import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {spareProofGeneration,spareSegmentBounds,SpareAuditProofCache} from './spares-audit-proof.ts';
import {beginSpareProofScope,stageSpareProof,discardSpareProofScope,commitSpareProofScope,hasSpareProofScope} from './spares-proof-scope.ts';
import {memoryTask,resident} from './capacity.ts';

const endpoint={host:'127.0.0.1',port:5432};
const generation={database:'qa',username:'app',isolation:'repeatable read',read_only:'on',database_oid:'123',server_started:'2026-10-30 01:00:00+00',address:'127.0.0.1',port:'5432',xid_epoch:'0',relation_oid:'456',relation_file:'456',catalog_xmin:'789',namespace_oid:'450',toast_oid:'460',relkind:'r'};
test('proof generation binds server, endpoint, user, database, epoch and relation identity',()=>{
 const initial=spareProofGeneration(generation,endpoint);
 for(const [key,value] of Object.entries({database:'qa2',username:'app2',database_oid:'124',server_started:'2026-10-30 02:00:00+00',address:'127.0.0.2',port:'5433',xid_epoch:'1',relation_oid:'457',relation_file:'458',catalog_xmin:'790',namespace_oid:'451',toast_oid:'461'}))assert.notEqual(spareProofGeneration({...generation,[key]:value},endpoint),initial,key);
 assert.notEqual(spareProofGeneration(generation,{...endpoint,host:'localhost'}),initial);
 assert.notEqual(spareProofGeneration(generation,{...endpoint,port:5433}),initial);
 assert.equal(spareProofGeneration({...generation,read_only:'off'},endpoint),initial);
 for(const patch of [{isolation:'read committed'},{database_oid:null},{xid_epoch:'-1'},{catalog_xmin:'4294967296x'},{relation_file:''},{relkind:'p'},{address:null},{port:'65536'},{port:undefined}])assert.throws(()=>spareProofGeneration({...generation,...patch},endpoint));
 for(const port of [0,-1,65536,NaN,'abc'])assert.throws(()=>spareProofGeneration(generation,{...endpoint,port}));
});
test('segment bounds reject gaps, deletions, omitted tails, overflow and extra segments',()=>{
 const first={segment:'0',count:'256',first:'1',last:'256',fingerprint:'a'.repeat(64)};
 assert.deepEqual(spareSegmentBounds(first,0n,513n),{first:1n,last:256n});
 assert.deepEqual(spareSegmentBounds({...first,segment:'2',count:'1',first:'513',last:'513'},2n,513n),{first:513n,last:513n});
 for(const patch of [{segment:'1'},{first:'0'},{last:'257'},{count:'255'},{fingerprint:'x'.repeat(64)},{first:'9223372036854775808'}])assert.throws(()=>spareSegmentBounds({...first,...patch},0n,513n));
 assert.throws(()=>spareSegmentBounds(first,0n,0n));assert.throws(()=>spareSegmentBounds(first,1n,256n));
 for(const n of [0,1025,1.5])assert.throws(()=>new SpareAuditProofCache(n));
});
test('pending proofs publish only on confirmed commit, release accounting, and cap at 1024',async()=>{
 const client={} as pg.PoolClient,baseline=resident.snapshot().total;let published=0;
 await memoryTask(async()=>{
  assert.equal(stageSpareProof(client,'absent',{},()=>published++),false);
  beginSpareProofScope(client);assert.equal(hasSpareProofScope(client),true);
  for(let i=0;i<1500;i++)stageSpareProof(client,String(i),{fingerprint:'a'.repeat(64)},()=>published++);
  assert.equal(published,0);commitSpareProofScope(client);assert.equal(published,1024);assert.equal(hasSpareProofScope(client),false);
  beginSpareProofScope(client);stageSpareProof(client,'rollback',{},()=>published++);discardSpareProofScope(client);assert.equal(published,1024);
  beginSpareProofScope(client);stageSpareProof(client,'same',{},()=>{throw Error('replaced callback ran');});stageSpareProof(client,'same',{},()=>published++);commitSpareProofScope(client);assert.equal(published,1025);
  beginSpareProofScope(client);stageSpareProof(client,'failure',{},()=>{throw Error('optional cache budget');});assert.doesNotThrow(()=>commitSpareProofScope(client));
 });
 assert.equal(resident.snapshot().total,baseline);
});
