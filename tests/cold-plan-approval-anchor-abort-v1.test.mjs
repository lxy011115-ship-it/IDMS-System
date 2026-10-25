import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical} from '../server/imports.ts';
import {coldPlanApprovalInputQaV1} from './fixtures/cold-plan-approval-input-v1.mjs';
import {approveColdPlanJournalV1,readColdPlanApprovalsV1} from '../scripts/cold-plan-approval-journal-v1.mjs';
import {armColdApprovalAnchorAbortQaV1,disarmColdApprovalAnchorAbortQaV1} from '../scripts/fixtures/cold-plan-approval-sqlite-abort-v1-qa.mjs';

test('a real SQLite anchor-save abort after the real approval INSERT rolls back the first row and schema, then the same id commits once',async t=>{
 const f=await coldPlanApprovalInputQaV1();t.after(()=>f.close());assert.equal(f.db.prepare('PRAGMA journal_mode=WAL').get().journal_mode,'wal');f.begin();const plan=await f.plan();f.commit();const before=canonical(f.details),id=randomUUID(),fault=armColdApprovalAnchorAbortQaV1(f.db,id),args=()=>({db:f.db,details:f.details,context:f.context,credentials:f.credentials}),request={approvalId:id,tenantId:'acme',expectedPlanSha256:plan.planSha256,decision:'APPROVE'};
 f.begin();const candidate=await approveColdPlanJournalV1({...args(),current:await f.current(plan),request});assert.equal(candidate.sequence,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM cold_plan_approvals_v1 WHERE approval_id=?').get(id).n,1);assert.equal(f.details.planApprovals.body.headSha256,candidate.approvalSha256);let failure;try{f.commit();}catch(e){failure=e;}assert(failure);assert.equal(failure.code,'ERR_SQLITE_ERROR');assert.equal(failure.errcode&255,19);assert.equal(failure.message,fault.message);assert.equal(f.db.isTransaction,true);f.rollback();
 const observer=new DatabaseSync(f.storeFile,{readOnly:true,allowExtension:false});try{assert.equal(observer.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='cold_plan_approvals_v1'").get().n,0);assert.equal(observer.prepare('SELECT details FROM cold_control WHERE id=1').get().details,before);}finally{observer.close();}
 assert.equal(canonical(f.details),before);disarmColdApprovalAnchorAbortQaV1(f.db,fault);f.reopen();f.begin();assert.equal((await readColdPlanApprovalsV1(args())).sequence,0);const committed=await approveColdPlanJournalV1({...args(),current:await f.current(plan),request});assert.equal(committed.sequence,1);assert(!committed.alreadyRecorded);f.commit();f.reopen();f.begin();const history=await readColdPlanApprovalsV1(args());assert.equal(history.sequence,1);assert.equal(history.records[0].body.approvalId,id);f.rollback();
});
