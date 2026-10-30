import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sumColdCoreQueueRelationRowsQaV1 as sum} from '../scripts/fixtures/cold-core-field-queue-row-count-v1-qa.mjs';
import {readRuntimeColdReviewWithFieldSourceV2} from '../scripts/runtime-cold-readonly-control-v7.mjs';
const file='work/ccf-native-v6-20261026/a1e9ccb7f4c7/verification.json',bytes=await readFile(file),report=JSON.parse(bytes),sha=bytes=>createHash('sha256').update(bytes).digest('hex');assert(report.passed&&report.checks.length===44&&report.implementationVersion===6);
const schemas=new Set(['governance_jobs_v4','maintenance_jobs_v4','predictive_jobs_v4','reconciliation_jobs_v1']),vectors=[],originals=new Map([[file,sha(bytes)]]);
for(const item of report.fieldCurrentMaterialsNative.cases){originals.set(item.trust.storeFile,sha(await readFile(item.trust.storeFile)));const state=await readRuntimeColdReviewWithFieldSourceV2(item.trust);for(const proof of item.coreFieldReview.coreQueueSql){const database=state.source.fullFacts.databases.find(value=>value.map?.tenantId===proof.tenantId),relations=database.sqlFacts.relations.filter(value=>schemas.has(value.schema));vectors.push({relations,expected:proof.queueSql.queueRows});}}
test('all four actual captured queue proofs count tables and exclude genuine sequences',()=>{assert.equal(vectors.length,4);for(const {relations,expected}of vectors){assert(relations.some(value=>value.kind==='S'));assert(Number.isNaN(relations.reduce((n,value)=>n+value.rows,0)));assert.equal(sum(relations),expected);}});
test('missing table row counts cannot be silently interpreted as empty',()=>{const input=structuredClone(vectors[0].relations),table=input.find(value=>value.kind==='r');delete table.rows;assert.throws(()=>sum(input),/CORE_FIELD_QUEUE_TABLE_ROWS/);});
test('unexpected row metadata on a sequence is rejected',()=>{const input=structuredClone(vectors[0].relations);input.find(value=>value.kind==='S').rows=0;assert.throws(()=>sum(input),/CORE_FIELD_QUEUE_SEQUENCE_ROW_METADATA/);});
test('negative unsafe or foreign table kinds reject',()=>{for(const value of [-1,Number.MAX_SAFE_INTEGER+1]){const input=structuredClone(vectors[0].relations);input.find(row=>row.kind==='r').rows=value;assert.throws(()=>sum(input),/CORE_FIELD_QUEUE_TABLE_ROWS/);}assert.throws(()=>sum([{kind:'LARGE_OBJECT',rows:0}]),/CORE_FIELD_QUEUE_TABLE_ROWS/);});
test('the original successful report and both actual SOURCE stores remain unchanged',async()=>{for(const [path,digest]of originals)assert.equal(sha(await readFile(path)),digest);});
