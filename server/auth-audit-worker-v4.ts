import type {ClientConfig} from 'pg';
import {AuthAuditSourceV4,type AuthAuditClaimV4} from './auth-audit-source-v4.ts';
import {AuthAuditMapV4Writer} from './auth-audit-map-v4.ts';
import {startAuthAuditHeartbeatV4} from './auth-audit-heartbeat-v4.ts';
import {authAuditNeedV4 as need} from './auth-audit-event-v4.ts';
export interface AuthAuditWorkerOptionsV4 {source:AuthAuditSourceV4;sourceAccount:ClientConfig;writers:ReadonlyMap<string,AuthAuditMapV4Writer>;onPhase?:(phase:'CLAIMED'|'BUSINESS_COMMITTED'|'ACKNOWLEDGED',claim:AuthAuditClaimV4)=>Promise<void>;onError?:(error:unknown)=>Promise<void>}
export class AuthAuditWorkerV4 {
 #o:AuthAuditWorkerOptionsV4;#running=false;
 constructor(options:AuthAuditWorkerOptionsV4){this.#o=options;}
 async runOne(tenant:string){need(!this.#running,'AUTH_AUDIT_WORKER_BUSY');const writer=this.#o.writers.get(tenant);need(writer,'AUTH_AUDIT_WORKER_TENANT');this.#running=true;let claim:AuthAuditClaimV4|null=null,heartbeat:ReturnType<typeof startAuthAuditHeartbeatV4>|undefined;
  try{claim=await this.#o.source.claim(tenant);if(!claim)return null;heartbeat=startAuthAuditHeartbeatV4(this.#o.sourceAccount,this.#o.source.binding,claim);await this.#o.onPhase?.('CLAIMED',claim);heartbeat.assertLive();const event=this.#o.source.open(claim),proof=await writer.deliver(event);await this.#o.onPhase?.('BUSINESS_COMMITTED',claim);heartbeat.assertLive();await this.#o.source.acknowledge(claim,proof);await this.#o.onPhase?.('ACKNOWLEDGED',claim);return {eventId:claim.header.eventId,tenantId:tenant,status:'DELIVERED',receipt:proof.value};}
  catch(error){await this.#o.onError?.(error);if(!claim)throw error;const status=await this.#o.source.delivery(claim.header.eventId);if(status?.status==='DELIVERED'){const verified=await writer.deliver(this.#o.source.open(claim));return {eventId:claim.header.eventId,tenantId:tenant,status:'DELIVERED',receipt:verified.value};}await this.#o.source.defer(claim,(error as Error).message==='AUTH_AUDIT_MAINTENANCE_WAIT'?'BUSINESS_MAINTENANCE':'DELIVERY_UNCONFIRMED').catch(()=>{});return {eventId:claim.header.eventId,tenantId:tenant,status:'RETRY'};
  }finally{await heartbeat?.stop();this.#running=false;}
 }
}
