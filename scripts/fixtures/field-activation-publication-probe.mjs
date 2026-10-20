import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FieldActivationPublication} from '../field-activation-publication.mjs';
import {readCurrentRecoveryReview} from '../field-recovery-review.mjs';
import {sourceFreezeSha as sha} from '../field-source-freeze-policy.mjs';
import {stageFieldRuntimePrivileges} from '../field-activation-security.mjs';
import {inspectFieldRecoveryRegistration,loadFieldPlatformConfig,clearFieldPlatformConfig} from '../../server/field-config.ts';
import {openPublicationQaContext} from './field-activation-publication-context.mjs';
let c,publication,pending;
try{
 const input=JSON.parse(await readFile(process.argv[2],'utf8'));c=await openPublicationQaContext(input.args);
 const image=await readCurrentRecoveryReview(c);assert.equal(image.phase.stage,'APPROVED');assert.equal(image.review.plan.format,'idms-field-recovery-plan-v2');
 const registration=await inspectFieldRecoveryRegistration(input.args['--registration-config'],c.files.controlFile,c.main.after);assert.deepEqual(registration,image.review.plan.registration);
 publication=new FieldActivationPublication(c.guard,c.files.controlFile);
 await publication.prepare({operationId:c.intent.operationId,attemptId:input.attemptId,planSha256:sha(image.review.plan),approvalPhase:image.phase,registration});
 if(process.env.IDMS_FIELD_ACTIVATION_TRANSACTION_QA==='1'){const {prepareFieldActivationCommit}=await import('../field-activation-prepare.mjs');pending=await prepareFieldActivationCommit(c,image,{publication,registrationConfig:input.args['--registration-config'],externalConfig:JSON.parse(await readFile(input.args['--external-config'],'utf8')),materialConfiguration:input.args['--material-configuration'],accessToken:await readFile(input.args['--access-token-file'],'utf8')});}else await stageFieldRuntimePrivileges(c.root,c.account,c.migrator,c.tenantId);
 await publication.publish();
 await pending?.revalidateBeforeCommit();
 if(input.args['--material-configuration']){assert.equal(pending.attempt.format,'idms-field-activation-attempt-v2');assert.equal(pending.attempt.materialEvidence.leaseIssued,false);assert.ok(pending.attempt.materialEvidence.channels.every(c=>c.mqttTls.every(p=>p.peerRequiresClientCertificate&&p.mqttClientCreated===false)));}
 const active=await loadFieldPlatformConfig(input.args['--registration-config']);try{assert.deepEqual(active.tenants.get(c.tenantId).snapshot,registration.registry);}finally{clearFieldPlatformConfig(active);}
 if(input.action==='COMMIT'){
  assert.equal(process.env.IDMS_FIELD_ACTIVATION_COMMIT_QA,'1');assert.ok(pending);await c.root.query('/* IDMS_FIELD_ACTIVATION_COMMIT */ COMMIT');await c.reader.query('ROLLBACK');process.send({type:'COMMITTED_NO_RESULT',attemptId:input.attemptId,backend:c.root.processID,phase:pending.phase,...(pending.attempt.materialEvidence?{materialEvidenceSha256:pending.attempt.materialEvidence.sha256}:{})});
 }else process.send({type:'PUBLISHED_UNCOMMITTED',attemptId:input.attemptId,backend:c.root.processID,factsSha256:image.facts.factsSha256,phaseSha256:sha(image.phase),controlSha256:sha(publication.intent.after)});
 await new Promise((_,no)=>{process.once('disconnect',()=>no(Error('Owner disconnected')));process.once('message',()=>no(Error('Unexpected probe command')));});
}catch(e){process.stderr.write(JSON.stringify({code:e.code||'FIELD_ACTIVATION_PUBLICATION_PROBE_FAILED',message:e.message})+'\n');process.exitCode=1;}
finally{await pending?.closeMaterialInspection();await c?.close();await publication?.close();if(process.connected)process.disconnect();}
