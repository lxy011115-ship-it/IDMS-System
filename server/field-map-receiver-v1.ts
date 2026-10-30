import {createPublicKey,randomUUID,type KeyObject} from 'node:crypto';
import {FieldMapTransactionsV2} from './field-map-transaction-v2.ts';
import {checkFieldMapSignalV1} from './field-map-transaction-v1.ts';
import {fieldRegistrySnapshot} from './field-registry.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {canonicalEqual} from './canonical-state.ts';
import {fieldMapStorageV1,planFieldReceiveMapV1} from './field-map-receive-v1.ts';
import {fieldIntakeDecisionMapV1,fieldIntakeFingerprintMapV1} from './field-map-intake-decision-v1.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {decodeFieldMessage,verifyFieldEvent,fieldEventProfile,fieldEventMaxBytes,fieldAckForEvent,signFieldAck,verifyFieldAck,type SignedFieldAck} from '../integrations/field-event.ts';

export class FieldMapReceiverV1 {
 readonly #tx:FieldMapTransactionsV2;readonly #snapshot:ReturnType<typeof fieldRegistrySnapshot>;#signingKey:KeyObject|null;readonly #publicKey:KeyObject;readonly #keys=new Map<string,Buffer>();readonly #stop=new AbortController();readonly #active=new Set<Promise<unknown>>();#closing=false;#closed=false;#closeJob:Promise<void>|null=null;
 constructor(tx:FieldMapTransactionsV2,raw:unknown,signingKey:KeyObject,eventKeys:ReadonlyMap<string,Uint8Array>){
  const snapshot=fieldRegistrySnapshot(raw),channels=snapshot.channels.filter(c=>c.profile.transport);need(snapshot.tenantId===tx.tenantId&&channels.length>0&&signingKey.type==='private'&&fieldLeaseKeyId(signingKey)===snapshot.leaseKeyId&&eventKeys.size===channels.length,'FIELD_MAP_RECEIVER_CONFIG');
  for(const c of channels){const p=fieldEventProfile(c.profile),key=eventKeys.get(p.source.edgeId);need(key instanceof Uint8Array&&key.byteLength===32&&!key.every(b=>b===0)&&fieldSha256(key)===p.transport.eventKeySha256,'FIELD_MAP_EVENT_KEY');}
  this.#tx=tx;this.#snapshot=snapshot;this.#signingKey=signingKey;this.#publicKey=createPublicKey(signingKey);for(const [edge,key]of eventKeys)this.#keys.set(edge,Buffer.from(key));
 }
 state(){return {closing:this.#closing,closed:this.#closed,active:this.#active.size,keyCount:this.#keys.size};}
 receiveMqtt(topic:string,bytes:Uint8Array,signal?:AbortSignal):Promise<SignedFieldAck|null>{
  need(!this.#closing,'FIELD_MAP_RECEIVER_CLOSED');need(this.#active.size<32,'FIELD_MAP_INTAKE_CAPACITY');if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>fieldEventMaxBytes)return Promise.resolve(null);
  const channel=this.#snapshot.channels.find(c=>c.profile.transport?.topics.telemetry===topic);if(!channel)return Promise.resolve(null);const key=this.#keys.get(channel.profile.source.edgeId)!;let event;
  try{event=verifyFieldEvent(decodeFieldMessage(bytes),key,channel.profile,this.#publicKey);}catch{return Promise.resolve(null);}
  const immutable=event,combined=signal?AbortSignal.any([signal,this.#stop.signal]):this.#stop.signal;
  const job=Promise.resolve().then(async()=>{
   checkFieldMapSignalV1(combined);
   for(let attempt=0;;attempt++){
    const s=await this.#tx.snapshot(combined);let plan;
    try{plan=await planFieldReceiveMapV1(s,immutable,channel.profile,this.#snapshot,this.#publicKey,fieldMapStorageV1(this.#tx.binding));}finally{await s.close();}
    const recheck=async()=>{const final=await this.#tx.snapshot(combined);try{need(canonicalEqual(final.head,s.head),'FIELD_MAP_RECHECK_ROOT_CHANGED');const current=await fieldIntakeDecisionMapV1(final,channel.profile,this.#snapshot,immutable,this.#publicKey,Date.now());need(fieldIntakeFingerprintMapV1(current)===plan.fingerprint,'FIELD_MAP_INTAKE_TIME_BOUNDARY');}finally{await final.close();}};
    try{
     if(plan.operations.length)await this.#tx.commit(s.head,randomUUID(),plan.operations,combined,recheck);else await recheck();
     await this.#tx.assertCurrent('READ',combined);need(this.#signingKey,'FIELD_MAP_RECEIVER_CLOSED');const c=plan.candidate,ack=signFieldAck(fieldAckForEvent(immutable,c.status,c.reason,c.pointId,c.receiptAuditId,c.receiptAt,Date.now()),this.#signingKey);verifyFieldAck(ack,this.#publicKey,immutable,Date.now());return ack;
    }catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT|FIELD_MAP_RECHECK_ROOT_CHANGED/.test((e as Error).message))continue;throw e;}
   }
  });
  this.#active.add(job);void job.finally(()=>this.#active.delete(job)).catch(()=>{});return job;
 }
 close(){if(this.#closeJob)return this.#closeJob;this.#closing=true;this.#stop.abort();this.#closeJob=(async()=>{await Promise.allSettled([...this.#active]);for(const key of this.#keys.values())key.fill(0);this.#keys.clear();this.#signingKey=null;this.#closed=true;})();return this.#closeJob;}
}
