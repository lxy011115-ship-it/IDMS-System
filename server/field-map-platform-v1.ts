import type {ClientConfig} from 'pg';
import {loadFieldPlatformConfig,clearFieldPlatformConfig,type FieldPlatformConfig} from './field-config.ts';
import {verifyFieldRecoveryHandle,assertFieldRecoveryDatabase,assertFieldRecoveryRegistry} from './field-recovery-read.ts';
import {FieldMapTransactionsV2} from './field-map-transaction-v2.ts';
import {FieldMapOwnedTransactionsV1} from './field-map-owned-transaction-v1.ts';
import {FieldMapIntakeOwnerV1} from './field-map-intake-owner-v1.ts';
import {FieldMapIssuerV1} from './field-map-issuer-v1.ts';
import {FieldMapReceiverV1} from './field-map-receiver-v1.ts';
import {assertFieldMapIntakePreparedV1} from './field-map-intake-bootstrap-v1.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {checkFieldMapSignalV1,type FieldMapGuardV1} from './field-map-transaction-v1.ts';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {bindRequestTenant} from './request-capacity.ts';
import {randomUUID} from 'node:crypto';
export interface FieldMapPlatformTenantV1 {account:ClientConfig;binding:StateMapBinding;guard:FieldMapGuardV1}
type Resource={base:FieldMapTransactionsV2;owner:FieldMapIntakeOwnerV1;issuer:FieldMapIssuerV1;receiver:FieldMapReceiverV1};
export class FieldMapPlatformV1 {
 readonly instanceId='field-map-'+randomUUID();#config:FieldPlatformConfig|null=null;readonly #resources=new Map<string,Resource>();readonly #stop=new AbortController();readonly #active=new Set<Promise<unknown>>();#started=false;#ready=false;#closing=false;#closed=false;#startJob:Promise<void>|null=null;#closeJob:Promise<void>|null=null;
 get configured(){return this.#ready&&!this.#closing;}
 tenantIds(){return [...this.#resources.keys()];}
 publicSnapshot(tenant:string){return this.configured&&this.#config?.tenants.has(tenant)?structuredClone(this.#config.tenants.get(tenant)!.snapshot):null;}
 state(){return {configured:this.configured,closing:this.#closing,closed:this.#closed,active:this.#active.size,tenants:[...this.#resources].map(([tenant,r])=>({tenant,owner:r.owner.state(),issuer:r.issuer.state(),receiver:r.receiver.state()}))};}
 async start(file:string,tenants:ReadonlyMap<string,FieldMapPlatformTenantV1>){
  need(!this.#started&&!this.#closing,'FIELD_MAP_PLATFORM_START_ONCE');this.#started=true;
  const work=(async()=>{const config=await loadFieldPlatformConfig(file);this.#config=config;need(config.tenants.size===tenants.size,'FIELD_MAP_PLATFORM_TENANTS');
   for(const [tenant,t]of config.tenants){
    const spec=tenants.get(tenant);need(spec&&spec.binding.tenantId===tenant&&typeof spec.guard==='function'&&t.snapshot.format==='idms-field-registry-v2'&&t.recovery&&t.channels.size>0&&[...t.channels.values()].every(c=>!!c.profile.transport&&!!c.eventKey),'FIELD_MAP_PLATFORM_CURRENT_CONFIG');
    const recovery=t.recovery,externalGuard=spec.guard;assertFieldRecoveryDatabase(recovery,{host:String(spec.account.host),port:Number(spec.account.port),database:String(spec.account.database),user:String(spec.account.user)});assertFieldRecoveryRegistry(recovery,t.snapshot);
    const guard:FieldMapGuardV1=async(phase,signal)=>{checkFieldMapSignalV1(this.#stop.signal);checkFieldMapSignalV1(signal);await externalGuard(phase,signal);await verifyFieldRecoveryHandle(recovery);checkFieldMapSignalV1(this.#stop.signal);checkFieldMapSignalV1(signal);};
    const base=new FieldMapTransactionsV2(spec.account,spec.binding,guard),owner=new FieldMapIntakeOwnerV1(spec.account,spec.binding,guard),owned=new FieldMapOwnedTransactionsV1(spec.account,spec.binding,guard,owner),issuer=new FieldMapIssuerV1(base,t.snapshot,config.signingKey,new Map([...t.channels].map(([id,c])=>[id,c.requestKey]))),receiver=new FieldMapReceiverV1(owned,t.snapshot,config.signingKey,new Map([...t.channels].map(([id,c])=>[id,c.eventKey!])));
    this.#resources.set(tenant,{base,owner,issuer,receiver});const s=await base.snapshot(this.#stop.signal);try{await assertFieldMapIntakePreparedV1(s);}finally{await s.close();}await issuer.observe(this.instanceId,this.#stop.signal);await owner.acquire();
   }checkFieldMapSignalV1(this.#stop.signal);this.#ready=true;
  })();this.#startJob=work;try{await work;}catch(e){this.#closing=true;this.#stop.abort();await this.#dispose();throw e;}finally{if(this.#startJob===work)this.#startJob=null;}
 }
 #run<T>(tenant:string,task:(r:Resource,signal:AbortSignal)=>Promise<T>,signal?:AbortSignal){
  need(this.configured&&this.#resources.has(tenant),'FIELD_MAP_PLATFORM_NOT_READY');const r=this.#resources.get(tenant)!,combined=signal?AbortSignal.any([signal,this.#stop.signal]):this.#stop.signal;need(this.#active.size<64,'FIELD_MAP_PLATFORM_CAPACITY');
  const work=Promise.resolve().then(()=>{checkFieldMapSignalV1(combined);return task(r,combined);});this.#active.add(work);void work.finally(()=>this.#active.delete(work)).catch(()=>{});return work;
 }
 issue(raw:unknown,signal?:AbortSignal){const tenant=typeof(raw as any)?.tenantId==='string'?(raw as any).tenantId:'';bindRequestTenant(tenant);return this.#run(tenant,(r,s)=>r.issuer.issue(raw,s),signal);}
 checkCurrent(raw:unknown,signal?:AbortSignal){const tenant=typeof(raw as any)?.lease?.body?.tenantId==='string'?(raw as any).lease.body.tenantId:'';bindRequestTenant(tenant);return this.#run(tenant,(r,s)=>r.issuer.checkCurrent(raw,s),signal);}
 ownsReceiving(tenant:string){return this.configured&&this.#resources.get(tenant)?.owner.held===true;}
 async acquireReceivingOwnership(tenant:string){if(!this.configured||!this.#resources.has(tenant))return false;return this.#run(tenant,async r=>{await r.base.assertCurrent('READ');return r.owner.acquire();});}
 verifyRecoveryCurrent(tenant:string){return this.#run(tenant,async r=>{await r.base.assertCurrent('READ');});}
 receiveMqtt(topic:string,bytes:Uint8Array,signal?:AbortSignal){let tenant='';for(const [id,t]of this.#config?.tenants??[])if([...t.channels.values()].some(c=>c.profile.transport?.topics.telemetry===topic))tenant=id;return this.#run(tenant,(r,s)=>{r.owner.requireHeld();return r.receiver.receiveMqtt(topic,bytes,s);},signal);}
 async #dispose(){
  const results=await Promise.allSettled([...this.#resources.values()].flatMap(r=>[r.receiver.close(),r.issuer.close()]));await Promise.allSettled([...this.#active]);const owners=await Promise.allSettled([...this.#resources.values()].map(r=>r.owner.close()));
  if(this.#config){clearFieldPlatformConfig(this.#config);this.#config=null;}this.#ready=false;need([...results,...owners].every(r=>r.status==='fulfilled'),'FIELD_MAP_PLATFORM_DRAIN_FAILED');this.#closed=true;
 }
 close(){if(this.#closeJob)return this.#closeJob;this.#closing=true;this.#stop.abort();this.#closeJob=(async()=>{await this.#startJob?.catch(()=>{});await this.#dispose();})();return this.#closeJob;}
}
