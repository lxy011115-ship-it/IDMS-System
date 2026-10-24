import {createPublicKey,randomUUID,type KeyObject} from 'node:crypto';
import {fieldRegistrySnapshot,type FieldRegistrySnapshot} from './field-registry.ts';
import {planFieldRegistryObservationMapV1,planFieldLeaseIssuanceMapV1,fieldCurrentLeaseCheckMapV1} from './field-map-lease-v1.ts';
import {FieldMapTransactionsV1,checkFieldMapSignalV1} from './field-map-transaction-v1.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {verifyFieldLeaseRequest} from '../integrations/field-request.ts';
import {fieldLeaseKeyId,signFieldLease,verifyFieldLease} from '../integrations/field-lease.ts';
import {verifyFieldCheckRequest,signFieldCheck,verifyFieldCheck} from '../integrations/field-check.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';

export class FieldMapIssuerV1 {
 readonly #transactions:FieldMapTransactionsV1;readonly #snapshot:FieldRegistrySnapshot;readonly #keys=new Map<string,Buffer>();#signingKey:KeyObject|null;readonly #publicKey:KeyObject;readonly #stop=new AbortController();readonly #active=new Set<Promise<unknown>>();#closing=false;#closed=false;#closeJob:Promise<void>|null=null;
 constructor(transactions:FieldMapTransactionsV1,raw:unknown,signingKey:KeyObject,requestKeys:ReadonlyMap<string,Uint8Array>){
  const snapshot=fieldRegistrySnapshot(raw);need(snapshot.tenantId===transactions.tenantId&&signingKey.type==='private'&&fieldLeaseKeyId(signingKey)===snapshot.leaseKeyId&&requestKeys.size===snapshot.channels.length,'FIELD_MAP_ISSUER_CONFIG');
  for(const c of snapshot.channels){const key=requestKeys.get(c.profile.source.edgeId);need(key instanceof Uint8Array&&key.byteLength===32&&fieldSha256(key)===c.requestKeySha256,'FIELD_MAP_REQUEST_KEY');}
  this.#transactions=transactions;this.#snapshot=snapshot;this.#signingKey=signingKey;this.#publicKey=createPublicKey(signingKey);for(const [edge,key]of requestKeys)this.#keys.set(edge,Buffer.from(key));
 }
 state(){return {closing:this.#closing,closed:this.#closed,active:this.#active.size,keyCount:this.#keys.size};}
 #run<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal){
  need(!this.#closing,'FIELD_MAP_ISSUER_CLOSED');const combined=signal?AbortSignal.any([signal,this.#stop.signal]):this.#stop.signal;
  const job=Promise.resolve().then(()=>{checkFieldMapSignalV1(combined);return work(combined);});this.#active.add(job);void job.finally(()=>this.#active.delete(job)).catch(()=>{});return job;
 }
 observe(instanceId:string,signal?:AbortSignal){return this.#run(async currentSignal=>{
  for(let attempt=0;;attempt++){const s=await this.#transactions.snapshot(currentSignal);let plan;try{plan=await planFieldRegistryObservationMapV1(s,this.#snapshot,instanceId);}finally{await s.close();}
   try{if(plan.operations.length)await this.#transactions.commit(s.head,randomUUID(),plan.operations,currentSignal);await this.#transactions.assertCurrent('READ',currentSignal);return plan.value;}catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test((e as Error).message))continue;throw e;}
  }
 },signal);}
 issue(raw:unknown,signal?:AbortSignal){return this.#run(async currentSignal=>{
  const edge=(raw as any)?.edgeId,key=this.#keys.get(edge);need(key,'FIELD_MAP_REQUEST_AUTH');
  for(let attempt=0;;attempt++){const request=verifyFieldLeaseRequest(raw,key,Date.now()),s=await this.#transactions.snapshot(currentSignal);let plan;try{plan=await planFieldLeaseIssuanceMapV1(s,request,this.#snapshot);}finally{await s.close();}
   try{if(plan.operations.length)await this.#transactions.commit(s.head,randomUUID(),plan.operations,currentSignal,async()=>{verifyFieldLeaseRequest(raw,key,Date.now());need(Date.now()>=plan.value.issuedAtMs&&Date.now()<plan.value.expiresAtMs,'FIELD_LEASE_EXPIRED');});
    await this.#transactions.assertCurrent('READ',currentSignal);verifyFieldLeaseRequest(raw,key,Date.now());need(this.#signingKey,'FIELD_MAP_ISSUER_CLOSED');const lease=signFieldLease(plan.value,this.#signingKey);verifyFieldLease(lease,this.#publicKey,{...this.#snapshot.channels.find(c=>c.profile.source.edgeId===edge)!.profile.source,profileDigest:request.profileDigest,requestId:request.requestId},Date.now());return lease;
   }catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test((e as Error).message))continue;throw e;}
  }
 },signal);}
 checkCurrent(raw:unknown,signal?:AbortSignal){return this.#run(async currentSignal=>{
  const edge=(raw as any)?.lease?.body?.edgeId,key=this.#keys.get(edge);need(key,'FIELD_MAP_REQUEST_AUTH');const request=verifyFieldCheckRequest(raw,key,Date.now()),s=await this.#transactions.snapshot(currentSignal);let body;
  try{body=await fieldCurrentLeaseCheckMapV1(s,request,this.#snapshot,this.#publicKey,Date.now());}finally{await s.close();}
  await this.#transactions.assertCurrent('READ',currentSignal);verifyFieldCheckRequest(raw,key,Date.now());need(this.#signingKey,'FIELD_MAP_ISSUER_CLOSED');const result=signFieldCheck(body,this.#signingKey);verifyFieldCheck(result,this.#publicKey,{requestId:request.requestId,requestedAtMs:request.requestedAtMs,lease:request.lease},Date.now());return result;
 },signal);}
 close(){if(this.#closeJob)return this.#closeJob;this.#closing=true;this.#stop.abort();this.#closeJob=(async()=>{await Promise.allSettled([...this.#active]);for(const key of this.#keys.values())key.fill(0);this.#keys.clear();this.#signingKey=null;this.#closed=true;})();return this.#closeJob;}
}
