import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {coldSourceFullSetUnitV1 as input,rehashColdUnitV1 as rehash} from './fixtures/cold-source-full-set-v1.mjs';
import {validateColdSourceFullFactsV1,assertColdSourceMapFactsV1} from '../scripts/cold-source-full-facts-v1.mjs';
import {validateColdReviewSqlFactsV1,assertColdReviewSqlFactsV1} from '../scripts/cold-review-sql-facts-v1.mjs';
import {RuntimeColdReadOnlyPreparationV3} from '../scripts/runtime-cold-review-prepare-v4.mjs';
import {RuntimeColdReadOnlyPreparationV2} from '../scripts/runtime-cold-review-prepare-v3.mjs';
import {readRuntimeColdReviewV3} from '../scripts/runtime-cold-readonly-control-v4.mjs';
import {readRuntimeColdReviewV2} from '../scripts/runtime-cold-readonly-control-v3.mjs';
test('metadata descriptor validation retains complete database coverage and grants no approval',()=>{
 const x=input(),before=structuredClone(x.set),v=validateColdSourceFullFactsV1(x.frame,x.set,x.controlDirectory);assert.deepEqual(v,before);assert.deepEqual(x.set,before);assert.equal(v.databases.length,2);assert.equal(v.databases.filter(d=>d.map).length,1);assert.equal(v.databases[0].map.facts.currentOidcApprovalVerified,false);
});
test('omitted, reordered, repeated and additional database data refuse even after rehashing the descriptor',()=>{
 for(const mutate of [v=>v.databases.pop(),v=>v.databases.reverse(),v=>v.databases[1]=structuredClone(v.databases[0]),v=>v.allowWrite=true]){const x=input();mutate(x.set);rehash(x.set);assert.throws(()=>validateColdSourceFullFactsV1(x.frame,x.set,x.controlDirectory),/COLD_SOURCE_FULL_/);}
});
test('source evidence cannot move outside its private control directory or inherit another tenant profile',()=>{
 for(const mutate of [m=>m.evidenceFile=resolve('work/foreign.jsonl'),m=>m.tenantId='sandbox',m=>m.profile.binding.roleOid='102',m=>m.profile.targetDirectory=resolve('work/other-target')]){const x=input(),changed=structuredClone(x.set);mutate(changed.databases[0].map);rehash(changed);assert.throws(()=>validateColdSourceFullFactsV1(x.frame,changed,x.controlDirectory),/COLD_SOURCE_MAP_/);}
});
test('only environment profile and evidence-stream hashes may differ in restored full facts',()=>{
 const x=input(),original=x.set.databases[0].map.facts,actual=structuredClone(original);actual.profileSha256='1'.repeat(64);actual.evidencePrefixSha256='2'.repeat(64);rehash(actual,'factsSha256');assertColdSourceMapFactsV1(actual,original);
 for(const mutate of [v=>v.head.rootHash='3'.repeat(64),v=>v.receiptRows++,v=>v.auditSha256='4'.repeat(64),v=>v.payloadSha256='5'.repeat(64),v=>v.relations.push({table:'extra'}),v=>v.leaves++,v=>v.lookups++]){const changed=structuredClone(actual);mutate(changed);rehash(changed,'factsSha256');assert.throws(()=>assertColdSourceMapFactsV1(changed,original),/COLD_SOURCE_MAP_CHANGED/);}
 const approved=structuredClone(actual);approved.currentOidcApprovalVerified=true;rehash(approved,'factsSha256');assert.throws(()=>assertColdSourceMapFactsV1(approved,original),/COLD_SOURCE_MAP_FACTS/);
});
test('large-object coverage, SQL counters, unsupported relations and changed original bytes refuse',()=>{
 for(const mutate of [v=>v.relations.pop(),v=>v.totalBytes++,v=>v.relations[0].kind='f',v=>v.identity.extra=true]){const v=structuredClone(input().set.databases[0].sqlFacts);mutate(v);rehash(v);assert.throws(()=>validateColdReviewSqlFactsV1(v),/COLD_FULL_SQL_/);}
 const v=input().set.databases[0].sqlFacts,changed=structuredClone(v);changed.relations[0].sha256='7'.repeat(64);rehash(changed);assert.throws(()=>assertColdReviewSqlFactsV1(changed,v),/COLD_FULL_SQL_SOURCE_CHANGED/);
});
test('new full-source trust and earlier read-only trust never cross-read or construct the other coordinator',async()=>{
 const x=input();assert.throws(()=>new RuntimeColdReadOnlyPreparationV2(x.config),/COLD_REVIEW_TRUST_CONFIG/);assert.throws(()=>new RuntimeColdReadOnlyPreparationV3({...x.config,trust:{...x.trust,format:'RUNTIME_COLD_REVIEW_TRUST_V2'}}),/COLD_REVIEW_TRUST_CONFIG/);await assert.rejects(readRuntimeColdReviewV2(x.trust),/COLD_TRUST/);await assert.rejects(readRuntimeColdReviewV3({...x.trust,format:'RUNTIME_COLD_REVIEW_TRUST_V2'}),/COLD_TRUST/);
});
