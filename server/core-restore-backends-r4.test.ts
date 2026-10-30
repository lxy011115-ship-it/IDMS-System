import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRestoreBackendR4,observeIsolatedTargetBackendsToZero} from '../scripts/core-upgrade-archives-observed-r4.mjs';
const owned={pid:123,started:'2026-10-20 22:00:00+08',role_oid:'321',usename:'idms_restore_acme_example',backend_type:'client backend'};
test('restore observation recognizes its exact role and native autovacuum without treating a foreign login as a worker',()=>{
 assert.equal(classifyRestoreBackendR4(owned,'321',owned.usename),'OWNED_RESTORE');
 assert.equal(classifyRestoreBackendR4({...owned,backend_type:'parallel worker'},'321',owned.usename),'OWNED_RESTORE');
 assert.equal(classifyRestoreBackendR4({...owned,role_oid:null,usename:null,backend_type:'autovacuum worker'},'321',owned.usename),'POSTGRES_AUTOVACUUM');
 for(const changed of [{role_oid:'999',usename:'foreign'},{role_oid:'999',usename:'foreign',backend_type:'autovacuum worker'},{role_oid:null,usename:null,backend_type:'background worker'}])assert.throws(()=>classifyRestoreBackendR4({...owned,...changed},'321',owned.usename),/Unexpected principal/);
});
test('natural worker completion must be followed by an actual empty observation; only SELECT metadata is used',async()=>{
 const batches=[[owned],[{...owned,pid:124,role_oid:null,usename:null,backend_type:'autovacuum worker'}],[]],queries:string[]=[];
 const admin={async query(sql:string,args:unknown[]){queries.push(sql);assert.deepEqual(args,['42']);return {rows:batches.shift()};}};
 const proof=await observeIsolatedTargetBackendsToZero(admin,'42','321',owned.usename);
 assert.equal(queries.length,3);assert.ok(queries.every(q=>q.startsWith('SELECT pid,backend_start::text')));assert.equal(proof.allActualTargetBackendsAbsent,true);assert.equal(proof.noConnectionTerminated,true);assert.deepEqual(proof.observedIdentities.map(r=>r.kind),['OWNED_RESTORE','POSTGRES_AUTOVACUUM']);
});
test('unknown principal is refused immediately and cannot be silently waited out by the normal cleanup path',async()=>{
 let queries=0;const admin={async query(){queries++;return {rows:[{...owned,role_oid:'999',usename:'foreign'}]};}};
 await assert.rejects(()=>observeIsolatedTargetBackendsToZero(admin,'42','321',owned.usename),/Unexpected principal/);assert.equal(queries,1);
});
test('an absent start identity or reused role name with a different OID does not establish ownership',()=>{
 assert.throws(()=>classifyRestoreBackendR4({...owned,started:null},'321',owned.usename),/identity missing/);
 assert.throws(()=>classifyRestoreBackendR4(owned,'322',owned.usename),/Unexpected principal/);
});
