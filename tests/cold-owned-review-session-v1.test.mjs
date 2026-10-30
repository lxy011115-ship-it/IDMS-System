import test from 'node:test';
import assert from 'node:assert/strict';
import {coldReadonlyInputQaV3,coldReviewUnitIdV3 as recoveryId} from './fixtures/cold-readonly-review-input-v3.mjs';
import {assertColdOwnedReviewSessionBindingV1,assertColdOwnedReviewPeersV1,captureColdOwnedReviewWorkflowsV1,createColdOwnedReviewSessionV1} from '../scripts/cold-owned-review-session-v1.mjs';
import {RuntimeColdReadOnlyPreparationV4} from '../scripts/runtime-cold-review-prepare-v6.mjs';
test('forged session and caller process or role claims reject before SQL is inspected',async()=>{
 let queries=0;const sql={query(){queries++;throw Error('SQL_MUST_NOT_RUN');}},fakes=[{},Object.freeze({phase:'HELD',pid:1,role:'idms_bootstrap'}),{state:()=>({phase:'HELD'}),acquire:async()=>true}];
 for(const session of fakes){assert.throws(()=>assertColdOwnedReviewSessionBindingV1(session,{trust:{},recoveryId}),/COLD_OWNED_SESSION_NOT_MINTED/);await assert.rejects(assertColdOwnedReviewPeersV1(sql,session,{}),/COLD_OWNED_SESSION_NOT_MINTED/);await assert.rejects(captureColdOwnedReviewWorkflowsV1(sql,session,{}),/COLD_OWNED_SESSION_NOT_MINTED/);}
 assert.equal(queries,0);
});
test('running-reader inspection requires a real brand before it opens a missing state store',async()=>{
 const {config}=coldReadonlyInputQaV3(),p=new RuntimeColdReadOnlyPreparationV4(config);
 assert.throws(()=>p.inspectOwnedReader({recoveryId,session:{}}),/COLD_OWNED_SESSION_NOT_MINTED/);
 for(const value of [{recoveryId},{recoveryId,session:{},approved:true},{recoveryId,session:{},allowedPids:[1]}])assert.throws(()=>p.inspectOwnedReader(value),/COLD_OWNED_REVIEW_REQUEST/);
 assert.deepEqual(p.state(),{busy:false,closed:false,ownedSqlClients:0});await p.close();
});
test('session constructor never accepts arbitrary SQL options, approval or remote endpoint callbacks',async()=>{
 for(const mutate of [c=>c.approved=true,c=>c.account.options='-c role=other',c=>c.account.host='example.com',c=>c.execute=()=>true]){
  const {config}=coldReadonlyInputQaV3();mutate(config);await assert.rejects(createColdOwnedReviewSessionV1({config,recoveryId,reader:{},peerTools:{}}),/COLD_(?:OWNED|REVIEW)_/);
 }
});
test('old preparation entry retains strict ordinary status; no active session can be passed as an arbitrary constructor parameter',async()=>{
 const {config}=coldReadonlyInputQaV3();assert.throws(()=>new RuntimeColdReadOnlyPreparationV4({...config,session:{}}),/COLD_REVIEW_CONFIG/);
 const raw=structuredClone(config),p=new RuntimeColdReadOnlyPreparationV4(config);await p.close();assert.deepEqual(config,raw);await assert.rejects(p.status({recoveryId}),/COLD_REVIEW_REQUEST/);
});
