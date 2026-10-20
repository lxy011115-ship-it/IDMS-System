import {canonical} from '../server/imports.ts';
import {readEntities} from '../server/entity-repository.ts';
import {recoveryReviewInputs} from './field-recovery-review-context.mjs';
import {captureRecoveryExternalState} from './field-recovery-external-state.mjs';
import {recoveryExternalConfig} from './field-recovery-external-config.mjs';
import {sourceFreezeSha as sha} from './field-source-freeze-policy.mjs';
import {activationFail as fail} from './field-activation-record.mjs';

// Current authorization is deliberately separate from historical receipt
// integrity. Current business may have advanced since the approved plan.
export async function authorizeFieldActivation(c,plan,reviewerId,{externalConfig,accessToken,assertConfiguration}){
 if(typeof assertConfiguration!=='function'||plan?.format!=='idms-field-recovery-plan-v2')fail('FIELD_ACTIVATION_V2_CONFIGURATION_REQUIRED');
 const config=recoveryExternalConfig(externalConfig);
 if(config.tenantId!==c.tenantId||sha(config)!==plan.externalConfigSha256||plan.operationId!==c.intent.operationId)fail('FIELD_ACTIVATION_EXTERNAL_BINDING_CHANGED');
 await assertConfiguration();await c.guard.assertHeld();
 const loaded=await readEntities(c.root,c.tenantId),{orders}=recoveryReviewInputs(loaded);
 const observation=await captureRecoveryExternalState(config,accessToken,orders,{purpose:'REVIEWER',otherActorId:plan.author.actorId,recordedAuthor:plan.author});
 if(observation.actor.actorId!==reviewerId||plan.contributors.includes(observation.actor.actorId)||Date.now()>=Date.parse(observation.expiresAt))fail('FIELD_ACTIVATION_CURRENT_REVIEWER_CHANGED');
 const after=await readEntities(c.root,c.tenantId);
 if(after.revision!==loaded.revision||canonical(recoveryReviewInputs(after).orders)!==canonical(orders))fail('FIELD_ACTIVATION_CURRENT_BUSINESS_CHANGED');
 await assertConfiguration();await c.guard.assertHeld();return observation;
}
