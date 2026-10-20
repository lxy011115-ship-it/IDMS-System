import {resolve} from 'node:path';
import {memoryTask} from '../server/capacity.ts';
import {FieldRecoveryAuthorityLock} from './field-recovery-lock.mjs';
import {FieldRecoveryFiles} from './field-recovery-files.mjs';
import {FieldActivationPublication} from './field-activation-publication.mjs';
import {openReviewContext} from './field-recovery-review-context.mjs';
import {readCurrentRecoveryReview} from './field-recovery-review.mjs';
import {prepareFieldActivationCommit} from './field-activation-prepare.mjs';
import {readMaintenanceJson} from './field-maintenance-record.mjs';
import {authorizeFieldActivation} from './field-activation-authorize.mjs';
import {resolveFieldActivation} from './field-activation-resolution.mjs';
import {externalUuid as uuid} from './field-recovery-external-config.mjs';
import {sourceFreezeSha as sha} from './field-source-freeze-policy.mjs';
import {activationFail as fail} from './field-activation-record.mjs';

export async function executeFieldActivation(options){return memoryTask(async()=>{
 const {action,operationId,attemptId,planId,expectedFactsSha256,controlFile,authority,tenantId}=options;
 if(!['ACTIVATE','RECOVER'].includes(action)||![operationId,attemptId,planId].every(uuid)||typeof options.assertConfiguration!=='function'||!options.materialConfiguration||!options.registrationConfig||action==='ACTIVATE'&&!/^[a-f0-9]{64}$/.test(expectedFactsSha256||''))fail('FIELD_ACTIVATION_REQUEST_INVALID');
 const guard=new FieldRecoveryAuthorityLock(authority,tenantId);guard.setWorkspace(controlFile);
 let files,c,publication,pending;
 const close=async()=>{const result=await Promise.allSettled([pending?.closeMaterialInspection(),c?.close(),files?.close(),publication?.close()]);pending=c=files=publication=null;const error=result.find(r=>r.status==='rejected');if(error)throw error.reason;};
 try{
  await options.assertConfiguration();await guard.acquire();const owned={...options,guard};
  const publicationPath=resolve(controlFile+'.operations',operationId+'.activation-publication-'+attemptId+'.json');let existing;
  try{existing=await readMaintenanceJson(publicationPath,1048576);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing)return await resolveFieldActivation(owned);
  if(action==='RECOVER')fail('FIELD_ACTIVATION_PUBLICATION_INTENT_REQUIRED');
  files=new FieldRecoveryFiles(guard,controlFile);await files.validatePath();await files.resume(operationId);await files.quiet();
  c=await openReviewContext({...owned,files});const image=await readCurrentRecoveryReview(c);
  if(image.phase.stage!=='APPROVED'||image.phase.planId!==planId||image.facts.factsSha256!==expectedFactsSha256||image.review?.plan.format!=='idms-field-recovery-plan-v2')fail('FIELD_ACTIVATION_EXPECTED_APPROVAL_CHANGED');
  await authorizeFieldActivation(c,image.review.plan,image.review.attempt.observation.actor.actorId,owned);
  publication=new FieldActivationPublication(guard,controlFile);
  await publication.prepare({operationId,attemptId,planSha256:sha(image.review.plan),approvalPhase:image.phase,registration:image.review.plan.registration});
  try{
   pending=await prepareFieldActivationCommit(c,image,{...owned,publication});
   if(pending.attempt.format!=='idms-field-activation-attempt-v2')fail('FIELD_ACTIVATION_MATERIAL_V2_REQUIRED');
   await publication.publish();await pending.revalidateBeforeCommit();
   await c.root.query('/* IDMS_FIELD_ACTIVATION_COMMIT */ COMMIT');await c.reader.query('ROLLBACK');
  }catch(error){
   // Closing and awaiting the old SQL sockets precedes actual-state
   // resolution. A failed/lost COMMIT reply alone proves neither outcome.
   await close();
   const resolved=await resolveFieldActivation(owned);
   if(resolved.state==='ACTIVE')return resolved;
   throw error;
  }
  await close();return await resolveFieldActivation(owned);
 }finally{try{await close();}finally{await guard.close();}}
},true);}
