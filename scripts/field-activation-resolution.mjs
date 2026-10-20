import {canonical} from '../server/imports.ts';
import {readEntities} from '../server/entity-repository.ts';
import {readFrozenSourceFacts,sourceSecurityFrame} from './field-source-freeze-security.mjs';
import {openActivationResolutionContext} from './field-activation-context.mjs';
import {readReviewPhase} from './field-recovery-review-record.mjs';
import {verifyReviewCommitted} from './field-recovery-review-audit.mjs';
import {recoveryReviewInputs} from './field-recovery-review-context.mjs';
import {reviewSessionAllowed} from './field-recovery-review-sessions.mjs';
import {verifyCommittedFieldActivation} from './field-activation-receipt.mjs';
import {authorizeFieldActivation} from './field-activation-authorize.mjs';
import {bindActivationRecords,readActivationPhase,activationFail as fail} from './field-activation-record.mjs';
import {sourceFreezeSha as sha} from './field-source-freeze-policy.mjs';
const same=(a,b)=>canonical(a)===canonical(b);

// Caller owns the authority lock. This function never guesses a transaction
// outcome from an exception and never enables a database role.
export async function resolveFieldActivation(options){
 const c=await openActivationResolutionContext(options);
 try{
  await c.begin();const pub=c.publication.intent;
  if(pub.planId!==options.planId||options.expectedFactsSha256&&options.expectedFactsSha256!==pub.approvalPhase.contentSha256)fail('FIELD_ACTIVATION_EXPECTED_APPROVAL_CHANGED');
  const plan=await c.journal.read('plan',pub.planId),approval=await c.journal.read('approve',pub.approvalPhase.attemptId),attempt=await c.activationJournal.read('attempt'),baseline=await c.activationJournal.read('baseline'),prepared=await c.activationJournal.read('prepared');
  if(plan?.format!=='idms-field-recovery-plan-v2'||sha(plan)!==pub.planSha256||!approval)fail('FIELD_ACTIVATION_APPROVED_V2_REQUIRED');
  if(attempt){if(attempt.format!=='idms-field-activation-attempt-v2'||!baseline)fail('FIELD_ACTIVATION_MATERIAL_V2_REQUIRED');bindActivationRecords(attempt,baseline,pub);}
  if(!attempt&&prepared)fail('FIELD_ACTIVATION_COMMITTED_JOURNAL_MISSING');
  // No cached result is inspected or returned as authorization. Current JWT,
  // author, role/scope and complete current Flowable state precede the result.
  await authorizeFieldActivation(c,plan,approval.observation.actor.actorId,options);
  if(c.resolution==='COMMITTED'){
   if(!attempt||!prepared)fail('FIELD_ACTIVATION_COMMITTED_JOURNAL_MISSING');
   const verified=await verifyCommittedFieldActivation(c,{publication:c.publication,journal:c.activationJournal});
   await options.assertConfiguration();await c.guard.assertHeld();
   await c.activationJournal.write('result',verified.result);
   return {format:'idms-field-activation-operation-result-v1',state:'ACTIVE',stage:'ACTIVATED',operationId:pub.operationId,attemptId:pub.attemptId,planId:pub.planId,receipt:verified.result,alreadyRecorded:verified.alreadyRecorded,currentRevision:verified.currentRevision,currentAuditEvents:verified.currentAuditEvents,fieldRuntimeStarted:false,productionAcceptance:false};
  }
  if(await c.activationJournal.read('result')||await readActivationPhase(c.root,c.account.database)||!same(await readReviewPhase(c.root,c.account.database),pub.approvalPhase))fail('FIELD_ACTIVATION_RESOLUTION_PHASE_UNKNOWN');
  const security=await sourceSecurityFrame(c.root,c.account,c.migrator,'FROZEN');
  if(!same(security.database,c.state.provision.database)||!same(security.roles,c.state.roles.roles))fail('FIELD_ACTIVATION_RECEIPT_ROLE_OID_CHANGED');
  const facts=await readFrozenSourceFacts(c.root,c.account,c.migrator,c.tenantId,{sequenceClient:c.reader}),loaded=await readEntities(c.root,c.tenantId),image={facts,loaded,phase:await readReviewPhase(c.root,c.account.database),...recoveryReviewInputs(loaded)};
  await c.journal.plans();await verifyReviewCommitted(c,image);
  if(facts.factsSha256!==pub.approvalPhase.contentSha256||baseline&&baseline.facts.factsSha256!==facts.factsSha256)fail('FIELD_ACTIVATION_ROLLBACK_FACTS_CHANGED');
  const sessions=(await c.root.query('SELECT pid,usesysid::text,backend_type,leader_pid FROM pg_stat_activity WHERE datid=$1::oid AND pid<>ALL($2::int[])',[c.state.provision.database.oid,[c.root.processID,c.reader.processID]])).rows;
  if(sessions.some(r=>!reviewSessionAllowed(r,{rootPid:c.root.processID,readerPid:c.reader.processID,backupOid:c.state.roles.roles.backup.oid})))fail('FIELD_ACTIVATION_OTHER_TARGET_SESSION');
  await options.assertConfiguration();await c.guard.assertHeld();
  await c.publication.rearmRestoring();
  return {format:'idms-field-activation-operation-result-v1',state:'RESTORING',stage:'APPROVED',operationId:pub.operationId,attemptId:pub.attemptId,planId:pub.planId,activationCommitted:false,newAttemptIdRequired:true,ordinaryRolesRemainFrozen:true,fieldRuntimeStarted:false,productionAcceptance:false};
 }finally{await c.close();}
}
