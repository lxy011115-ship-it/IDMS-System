import {TenantQueue,tenantWorkspace,workspacePayload} from './tenant-workspace.ts';
import {savePostgres} from './postgres-repository.ts';
import {fieldIntakeDecision,fieldIntakeFingerprint} from './field-intake-decision.ts';
import {receiveFieldEvent,type FieldReceiveContext} from './field-receive.ts';
import {decodeFieldMessage,verifyFieldEvent} from '../integrations/field-event.ts';
import {CapacityError,requestSignal,accountValue} from './capacity.ts';
import {verifyFieldRecoveryHandle,fieldRecoveryUnavailable,assertFieldRecoveryRegistry} from './field-recovery-read.ts';
import {DomainError} from './service.ts';
const check=(signal?:AbortSignal)=>{if(signal?.aborted||requestSignal()?.aborted)throw new CapacityError(499,'现场接收已取消','REQUEST_CANCELLED');};
// Same database root lock/write/post-image primitive as ordinary commands, with
// an additional last admission check after root persistence and before COMMIT.
export class FieldReceiveTransactions {
 readonly #queue=new TenantQueue();#closing=false;
 async receive(bytes:Uint8Array,context:FieldReceiveContext,signal?:AbortSignal){
  if(this.#closing)throw new DomainError(503,'现场接收正在排空');const tenant=context.snapshot.tenantId;return this.#queue.run(tenant,async()=>{check(signal);if(this.#closing)throw new DomainError(503,'现场接收正在排空');const event=verifyFieldEvent(decodeFieldMessage(bytes),context.eventKey,context.profile,context.publicKey);accountValue(event);if(context.snapshot.format!=='idms-field-registry-v2'||!context.recovery)throw fieldRecoveryUnavailable();assertFieldRecoveryRegistry(context.recovery,context.snapshot);await verifyFieldRecoveryHandle(context.recovery);
   const candidate=await context.owner.transaction(tenant,async tx=>{check(signal);await verifyFieldRecoveryHandle(context.recovery);const w=tenantWorkspace(tx.payload),received=await receiveFieldEvent(tx.client,w,event,context,signal);check(signal);await savePostgres(workspacePayload(w,tenant),tx);check(signal);await tx.client.query('/* IDMS_FIELD_PRECOMMIT */ SELECT 1');check(signal);await verifyFieldRecoveryHandle(context.recovery);check(signal);const final=fieldIntakeDecision(w.store,w.imports,context.profile,context.snapshot,event,context.publicKey,Date.now());if(fieldIntakeFingerprint(final)!==received.fingerprint)throw new DomainError(409,'现场准入在提交前变化，整次接收回滚');return structuredClone(received.candidate);});return {event,candidate};
  });
 }
 async close(){this.#closing=true;await this.#queue.drain();}
}
