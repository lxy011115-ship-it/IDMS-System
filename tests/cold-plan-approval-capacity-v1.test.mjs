import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from '../scripts/backup-support.mjs';
import {reviewSourceHashV1 as hash} from '../scripts/workflow-review-source-facts-v1.mjs';
import {readColdPlanApprovalsV1,approveColdPlanJournalV1,coldPlanApprovalHistoryStatusV1} from '../scripts/cold-plan-approval-journal-v1.mjs';
import {coldPlanApprovalCapacityInputQaV1} from './fixtures/cold-plan-approval-capacity-input-v1.mjs';

// Capacity fixture uses a known test key to bulk-construct canonical authenticated
// history. It does not pretend that2048 humans were authenticated. The real module
// authenticates the whole prefix, appends the final row and verifies complete read,
// replay and actual process reopen without an O(n²) setup through2048 API calls.
test('all2048 signed rows across64 complete32-tenant plans remain readable, appendable at the final slot and reopenable without truncation',async t=>{
 const f=await coldPlanApprovalCapacityInputQaV1();t.after(()=>f.close());const args=()=>({db:f.db,details:f.details,context:f.context,credentials:f.credentials}),binding={controlId:f.context.trust.controlId,sourceHash:f.context.trust.sourceHash,sourceFullFactsSha256:f.context.source.fullFacts.sha256,recoveryId:f.context.recoveryId,intentSha256:f.context.intentSha256,credentialSha256:f.context.credentialSha256},key=createHmac('sha256',Buffer.from(f.credentials.key,'hex')).update('IDMS_COLD_PLAN_APPROVAL_JOURNAL_V1\n').digest(),sign=(domain,body)=>createHmac('sha256',key).update(domain+'\n'+canonical(body)).digest('hex');t.after(()=>key.fill(0));
 const schema='CREATE TABLE cold_plan_approvals_v1(sequence INTEGER PRIMARY KEY,approval_id TEXT NOT NULL UNIQUE,plan_sha256 TEXT NOT NULL,tenant_id TEXT NOT NULL,body TEXT NOT NULL,body_sha256 TEXT NOT NULL UNIQUE,signature TEXT NOT NULL,UNIQUE(plan_sha256,tenant_id))';let sequence=0,parent=null,planParent=null,lastPlan;
 for(let revision=1;revision<=64;revision++){
  f.begin();const plan=await f.plan({parent:planParent});assert.equal(plan.revision,revision);planParent=plan.planSha256;lastPlan=plan;if(revision===1)f.db.exec(schema);const insert=f.db.prepare('INSERT INTO cold_plan_approvals_v1 VALUES(?,?,?,?,?,?,?)');
  for(let index=0;index<32;index++){
   if(revision===64&&index===31)break;
   const tenantId=f.tenants[index],current=await f.current(plan,{tenantId}),o=current.observation,ref={evidenceFile:o.evidenceFile,sha256:o.sha256,capturedAt:o.capturedAt,expiresAt:o.expiresAt},body={format:'COLD_CURRENT_PLAN_APPROVAL_V1',...binding,sequence:++sequence,parentSha256:parent,approvalId:randomUUID(),planId:plan.plan.planId,planRevision:plan.plan.revision,planSha256:plan.planSha256,tenantId,reviewerId:plan.plan.tenants[index].observedIndependentReviewerId,decision:'APPROVE',createdAt:o.capturedAt,expiresAt:plan.plan.expiresAt,originalPlanObservationSha256:plan.plan.observation.sha256,contributorsSha256:hash(plan.plan.tenants.map(t=>({tenantId:t.tenantId,contributorIds:t.contributorIds}))),observation:ref,approvalRecorded:true,formalFieldActivationGranted:false},bytes=canonical(body);parent=hash(bytes);insert.run(sequence,body.approvalId,body.planSha256,tenantId,bytes,parent,sign('ENTRY',body));const anchor={format:'COLD_PLAN_APPROVAL_ANCHOR_V1',...binding,sequence,headSha256:parent};f.details.planApprovals={body:anchor,signature:sign('ANCHOR',anchor)};
  }
  f.commit();
 }
 assert.equal(sequence,2047);const id=randomUUID(),current=await f.current(lastPlan,{tenantId:f.tenants[31]});f.begin();const final=await approveColdPlanJournalV1({...args(),current,request:{approvalId:id,tenantId:f.tenants[31],expectedPlanSha256:lastPlan.planSha256,decision:'APPROVE'}});assert.equal(final.sequence,2048);assert(!final.alreadyRecorded);f.commit();f.reopen();
 f.begin();const full=await readColdPlanApprovalsV1(args());assert.equal(full.records.length,2048);assert.equal(full.plans.records.length,64);assert.deepEqual(full.records.map(r=>r.body.sequence),Array.from({length:2048},(_,i)=>i+1));const status=coldPlanApprovalHistoryStatusV1(full);assert.equal(status.approvedTenantIds.length,32);assert(status.currentPlanHistoricalApprovalSetComplete&&!status.currentReviewerAuthenticated&&!status.businessWritesEnabled);f.rollback();
 f.begin();const replay=await approveColdPlanJournalV1({...args(),current:await f.current(lastPlan,{tenantId:f.tenants[31]}),request:{approvalId:id,tenantId:f.tenants[31],expectedPlanSha256:lastPlan.planSha256,decision:'APPROVE'}});assert(replay.alreadyRecorded&&replay.sequence===2048);assert.equal(replay.approvalSha256,final.approvalSha256);assert.equal(replay.approval.expiresAt,final.approval.expiresAt);f.commit();
 const input=join(f.directory,'reopen.private.json');await privateNewFile(input,canonical({format:'COLD_PLAN_APPROVAL_REOPEN_INPUT_V1',context:f.context,credentials:f.credentials,storeFile:f.storeFile}));const reopened=JSON.parse((await promisify(execFile)(process.execPath,['scripts/fixtures/cold-plan-approval-reopen-v1-qa.mjs',input],{windowsHide:true,maxBuffer:1024**2})).stdout);assert.equal(reopened.approvalHistorySequence,2048);assert.equal(reopened.approvedTenantIds.length,32);assert(reopened.actualFreshProcessHistoryRead&&!reopened.liveAuthenticationPerformed&&!reopened.businessWritesEnabled);
});
