import {canonical} from '../server/imports.ts';
import {readEntities} from '../server/entity-repository.ts';
import {inspectFieldRecoveryRegistration,loadFieldPlatformConfig,clearFieldPlatformConfig} from '../server/field-config.ts';
import {fieldAdmissionDecision} from '../server/field-admission.ts';
import {readBoundedFieldFile} from '../services/field/profile.ts';
import {sourceFreezeSha as sha} from './field-source-freeze-policy.mjs';
import {sourceSecurityFrame} from './field-source-freeze-security.mjs';
import {recoveryExternalConfig} from './field-recovery-external-config.mjs';
import {captureRecoveryExternalState} from './field-recovery-external-state.mjs';
import {verifyReviewCommitted} from './field-recovery-review-audit.mjs';
import {reviewSessionAllowed} from './field-recovery-review-sessions.mjs';
import {activationBaseline,activationAttempt,activationPrepared,readActivationPhase,activationFail as fail} from './field-activation-record.mjs';
import {FieldActivationFiles} from './field-activation-files.mjs';
import {stageActivationAudit,readActivationTransactionFacts,verifyActivationDelta} from './field-activation-audit.mjs';
import {stageFieldRuntimePrivileges} from './field-activation-security.mjs';
import {FieldActivationMaterialInspection} from './field-activation-materials.mjs';
const same=(a,b)=>canonical(a)===canonical(b);

// Prepares the complete DB transaction, but exposes no COMMIT or activation CLI.
// Supplying materialConfiguration selects v2 with actual read-only OPCUA/TLS
// evidence. A future operator coordinator must require that branch.
export async function prepareFieldActivationCommit(c,image,{publication,registrationConfig,externalConfig,accessToken,assertConfiguration,materialConfiguration}){
 let materialInspection;try{
 if(c.root.getTransactionStatus?.()!=='T')fail('FIELD_ACTIVATION_TRANSACTION_REQUIRED');const fresh=await c.read();fresh.review=await verifyReviewCommitted(c,fresh);if(fresh.facts.factsSha256!==image.facts.factsSha256||!same(fresh.phase,image.phase))fail('FIELD_ACTIVATION_BASELINE_CHANGED');image=fresh;const plan=image.review?.plan,pub=publication.intent;
 if(image.phase.stage!=='APPROVED'||plan?.format!=='idms-field-recovery-plan-v2'||!same(image.phase,pub.approvalPhase)||sha(plan)!==pub.planSha256||!same(plan.registration.registry.recovery,pub.after.identity))fail('FIELD_ACTIVATION_APPROVED_V2_REQUIRED');
 const config=recoveryExternalConfig(externalConfig);if(config.tenantId!==c.tenantId||plan.externalConfigSha256!==sha(config))fail('FIELD_ACTIVATION_EXTERNAL_BINDING_CHANGED');
 const checkAge=()=>{if(Date.parse(plan.createdAt)>Date.now()||Date.now()-Date.parse(plan.createdAt)>1800000)fail('FIELD_ACTIVATION_PLAN_EXPIRED');};checkAge();
 const inspectRegistration=async()=>{
  const state=await publication.inspect(),bytes=await readBoundedFieldFile(registrationConfig,2097152);if(sha(bytes)!==plan.registration.configSha256)fail('FIELD_ACTIVATION_MATERIAL_CHANGED');
  if(state.control.state==='RESTORING'){if(!state.markerPresent||!same(await inspectFieldRecoveryRegistration(registrationConfig,c.files.controlFile,c.main.after),plan.registration))fail('FIELD_ACTIVATION_MATERIAL_CHANGED');}
  else{if(!state.released||state.markerPresent||!same(state.control,pub.after))fail('FIELD_ACTIVATION_FILE_PHASE_INVALID');const loaded=await loadFieldPlatformConfig(registrationConfig);try{if(loaded.tenants.size!==1||!same(loaded.tenants.get(c.tenantId)?.snapshot,plan.registration.registry))fail('FIELD_ACTIVATION_MATERIAL_CHANGED');}finally{clearFieldPlatformConfig(loaded);}}
  if(sha(await readBoundedFieldFile(registrationConfig,2097152))!==plan.registration.configSha256)fail('FIELD_ACTIVATION_MATERIAL_CHANGED');
  for(const channel of plan.registration.registry.channels){const decision=fieldAdmissionDecision({...image.loaded.payload.business,audits:image.loaded.payload.audits},image.loaded.payload.imports,channel.profile,Date.now());if(!decision.allowed)fail('FIELD_ACTIVATION_POLICY_DENIED');}
 };
 await inspectRegistration();
 const observe=async()=>{checkAge();const o=await captureRecoveryExternalState(config,accessToken,image.orders,{purpose:'REVIEWER',otherActorId:plan.author.actorId,recordedAuthor:plan.author});if(o.actor.actorId!==image.review.attempt.observation.actor.actorId||plan.contributors.includes(o.actor.actorId)||o.workflowSha256!==plan.workflowSha256)fail('FIELD_ACTIVATION_CURRENT_REVIEWER_CHANGED');return o;};
 if(materialConfiguration){materialInspection=new FieldActivationMaterialInspection(materialConfiguration,plan.registration);await materialInspection.inspect({assertAuthorized:async()=>{await c.guard.assertHeld();await c.check();await observe();}});await materialInspection.revalidate();}
 const observation=await observe(),security=await sourceSecurityFrame(c.root,c.account,c.migrator,'FROZEN');
 const baseline=activationBaseline({format:'idms-field-activation-baseline-v1',operationId:c.intent.operationId,attemptId:pub.attemptId,facts:image.facts,rootRecord:image.rootRecord});
 const attempt=activationAttempt({format:materialInspection?'idms-field-activation-attempt-v2':'idms-field-activation-attempt-v1',...(materialInspection?{materialEvidence:materialInspection.evidence}:{}),tenantId:c.tenantId,operationId:c.intent.operationId,attemptId:pub.attemptId,backupId:plan.backupId,planId:plan.planId,planSha256:sha(plan),baselineSha256:sha(baseline),restoreResultSha256:sha(c.flow.result),publicationSha256:sha(pub),targetBindingSha256:sha(c.intent.targetBinding),runtimePolicySha256:security.policySha256,authorityId:c.guard.authorityId,createdAt:new Date(pub.createdAtMs).toISOString(),approvalPhase:image.phase,registration:plan.registration,observation});
 const journal=new FieldActivationFiles(c.guard,publication);await journal.write('baseline',baseline);await journal.write('attempt',attempt);
 await c.check();const pending=await stageActivationAudit(c,image,attempt,baseline,pub);await stageFieldRuntimePrivileges(c.root,c.account,c.migrator,c.tenantId);
 const runtimeFacts=await readActivationTransactionFacts(c,image.facts,{runtime:true});if(runtimeFacts.factsSha256!==pending.facts.factsSha256)fail('FIELD_ACTIVATION_RUNTIME_FACTS_CHANGED');
 await verifyActivationDelta(c,attempt,baseline,pub,pending.phase,runtimeFacts,await readEntities(c.root,c.tenantId));
 const prepared=activationPrepared({format:'idms-field-activation-prepared-v1',operationId:attempt.operationId,attemptId:attempt.attemptId,phase:pending.phase,facts:runtimeFacts,rootRecord:(await c.root.query('SELECT to_jsonb(t)::text AS value FROM public.business_state t WHERE tenant_id=$1',[c.tenantId])).rows[0]?.value});await journal.write('prepared',prepared);
 const revalidateBeforeCommit=async()=>{
  await c.guard.assertHeld();checkAge();if(!same(await journal.read('baseline'),baseline)||!same(await journal.read('attempt'),attempt)||!same(await journal.read('prepared'),prepared))fail('FIELD_ACTIVATION_JOURNAL_CHANGED');await inspectRegistration();
  if(materialInspection&&!same(await materialInspection.revalidate(),attempt.materialEvidence))fail('FIELD_ACTIVATION_MATERIAL_CHANGED_BEFORE_COMMIT');
  const final=await observe();if(final.actor.sha256!==observation.actor.sha256||final.authorCurrentSha256!==observation.authorCurrentSha256||final.workflowSha256!==observation.workflowSha256||Date.now()>=Date.parse(observation.expiresAt))fail('FIELD_ACTIVATION_EXTERNAL_CHANGED_BEFORE_COMMIT');
  await assertConfiguration?.();await c.guard.assertHeld();const s=await sourceSecurityFrame(c.root,c.account,c.migrator,'RUNTIME');if(s.policySha256!==attempt.runtimePolicySha256||!same(await readActivationPhase(c.root,c.account.database),pending.phase))fail('FIELD_ACTIVATION_PENDING_PHASE_CHANGED');
  const rows=(await c.observer.query('SELECT pid,usesysid::text,backend_type,leader_pid FROM pg_stat_activity WHERE datid=$1::oid AND pid<>ALL($2::int[])',[c.state.provision.database.oid,[c.root.processID,c.reader.processID]])).rows;if(rows.some(r=>!reviewSessionAllowed(r,{rootPid:c.root.processID,readerPid:c.reader.processID,backupOid:c.state.roles.roles.backup.oid})))fail('FIELD_ACTIVATION_OTHER_TARGET_SESSION');
 };
 return {...pending,attempt,baseline,prepared,journal,revalidateBeforeCommit,closeMaterialInspection:async()=>{await materialInspection?.close();}};
 }catch(e){await materialInspection?.close();throw e;}
}
