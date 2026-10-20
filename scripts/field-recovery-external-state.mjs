import {performance} from 'node:perf_hooks';
import {CurrentRecoveryActor,revalidateRecoveryPlanAuthor} from './field-recovery-current-actor.mjs';
import {readCurrentRecoveryWorkflow} from './field-recovery-current-workflow.mjs';
import {recoveryExternalConfig,externalRequire as need} from './field-recovery-external-config.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
export async function captureRecoveryExternalState(configuration,accessToken,orders,{purpose,otherActorId,recordedAuthor,signal}={}){
 const c=recoveryExternalConfig(configuration),started=performance.now(),at=new Date().toISOString(),controller=new AbortController(),combined=signal?AbortSignal.any([controller.signal,signal,AbortSignal.timeout(30000)]):AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]),identity=new CurrentRecoveryActor(c);
 try{
  const actor=await identity.verify(accessToken,{purpose,otherActorId,signal:combined});
  const author=recordedAuthor?await revalidateRecoveryPlanAuthor(c,recordedAuthor,{signal:combined}):null;
  const workflow=await readCurrentRecoveryWorkflow(c,orders,{signal:combined}),secondActor=await identity.current({purpose,signal:combined});
  const secondAuthor=recordedAuthor?await revalidateRecoveryPlanAuthor(c,recordedAuthor,{signal:combined}):null;
  const secondWorkflow=await readCurrentRecoveryWorkflow(c,orders,{signal:combined});
  need(actor.sha256===secondActor.sha256&&author?.sha256===secondAuthor?.sha256&&workflow.sha256===secondWorkflow.sha256,'FIELD_RECOVERY_EXTERNAL_CHANGED_DURING_READ');need(performance.now()-started<=30000&&!combined.aborted,'FIELD_RECOVERY_EXTERNAL_EXPIRED');
  const body={format:'idms-field-recovery-external-observation-v1',tenantId:c.tenantId,purpose,actor,authorCurrentSha256:author?.sha256??null,workflowSha256:workflow.sha256,workflowAuthorityId:c.workflow.authorityId,workflowCases:workflow.snapshot.cases.length,workflowCommandCount:workflow.snapshot.commandCount,capturedFrom:at,capturedAt:new Date().toISOString(),expiresAt:new Date(Math.min(Date.parse(actor.tokenExpiresAt)-10000,Date.now()+30000)).toISOString(),approvalGranted:false,activationGranted:false};return {...body,sha256:sourceFreezeSha(body)};
 }finally{controller.abort();await identity.close();}
}
