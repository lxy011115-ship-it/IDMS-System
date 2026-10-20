import {readEntities} from '../server/entity-repository.ts';
import {FieldReviewFiles} from './field-recovery-review-files.mjs';
import {verifyReviewCommitted} from './field-recovery-review-audit.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
export function maintenancePlanSummary(review){
 if(!review)return null;const {plan,attempt}=review;
 return {planId:plan.planId,planSha256:sourceFreezeSha(plan),authorId:plan.author.actorId,contributors:plan.contributors,createdAt:plan.createdAt,expiresAt:new Date(Date.parse(plan.createdAt)+1800000).toISOString(),identity:plan.identity,policyReferences:plan.policies,workflowSha256:plan.workflowSha256,...(plan.registration?{registration:plan.registration}:{}),approval:attempt.action==='APPROVE'?{actorId:attempt.observation.actor.actorId,recordedAt:attempt.createdAt}:null};
}
// This adapter exposes no journal mutation and uses the SELECT-only backup connection.
export async function verifyMaintenanceReview(client,cap,fence,facts){
 const source=new FieldReviewFiles(null,{controlFile:cap.controlFile,currentIntent:fence.main}),journal={read:(...args)=>source.read(...args)};
 await source.plans();if(cap.review.phase.format!=='idms-field-recovery-review-phase-v1')return null;
 const loaded=await readEntities(client,cap.tenantId),c={root:client,journal,main:fence.main,intent:fence.intent,flow:{result:fence.result},state:{provision:fence.provision},manifest:{backupId:cap.backupId},account:cap.account,tenantId:cap.tenantId};
 return verifyReviewCommitted(c,{phase:cap.review.phase,facts,loaded});
}
