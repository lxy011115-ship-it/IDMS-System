import {randomUUID} from 'node:crypto';
import type {ClientConfig} from 'pg';
import {appendAudit} from './audit.ts';
import type {AuditEvent} from './domain.ts';
import type {Store} from './store.ts';
import {canonicalDigest,canonicalEqual,jsonWireClone} from './canonical-state.ts';
import {DomainMapV4,DomainMapSnapshot} from './domain-map-v4.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {auditPositionKey,verifyLocalDomainAudit,telemetryDomainFormat,type DomainAuditHead,type TelemetryDomainControl} from './telemetry-map-v4.ts';
import type {StateMapBinding,StateHead} from './state-map-sql-v1.ts';
import type {StateOperation,StateReceipt} from './state-map-v1.ts';
import {authAuditFormatV4,verifyAuthAuditEventV4,authAuditNeedV4 as need,type AuthAuditBindingV4,type AuthAuditEventV4,type AuthAuditHeaderV4} from './auth-audit-event-v4.ts';
interface Source extends AuthAuditBindingV4 {scope:string}
interface Cursor {format:typeof authAuditFormatV4;tenantId:string;source:string;position:string;chainHash:string;eventId:string}
interface Completion {format:typeof authAuditFormatV4;tenantId:string;source:string;requestHash:string;sourceEventId:string;sourcePosition:string;sourceChainHash:string;auditEventId:string;auditPosition:string;auditHash:string}
export interface AuthAuditDeliveryValueV4 {completion:Completion;businessDatabaseOid:string;businessCatalogHash:string}
const brand=Symbol('AUTH_AUDIT_VERIFIED_DELIVERY');
/** Source acknowledgement accepts only a freshly verified delivery, never a caller's JSON receipt. */
export class VerifiedAuthAuditDeliveryV4 {
 #source:Source;#header:AuthAuditHeaderV4;#value:AuthAuditDeliveryValueV4;
 constructor(token:symbol,source:Source,header:AuthAuditHeaderV4,value:AuthAuditDeliveryValueV4){need(token===brand,'AUTH_AUDIT_PROOF_CONSTRUCTOR');this.#source=jsonWireClone(source);this.#header=jsonWireClone(header);this.#value=jsonWireClone(value);}
 forSource(source:Source,header:AuthAuditHeaderV4,target:{databaseOid:string;catalogHash:string;tenantId:string}){need(canonicalEqual(source,this.#source)&&canonicalEqual(header,this.#header)&&target.tenantId===this.#value.completion.tenantId&&target.databaseOid===this.#value.businessDatabaseOid&&target.catalogHash===this.#value.businessCatalogHash,'AUTH_AUDIT_DELIVERY_BINDING');return jsonWireClone(this.#value);}
 get value(){return jsonWireClone(this.#value);}
}
/** Ordinary writer: fixed-key dependencies; it never reconstructs a tenant or a complete audit chain. */
export class AuthAuditMapV4Writer {
 #store:DomainMapV4;#account:ClientConfig;#binding:StateMapBinding;#source:Source;#sourceKey:string;
 #commit?:(head:StateHead,id:string,ops:StateOperation[])=>Promise<StateReceipt>;
 lastReadStats:DomainMapSnapshot['stats']|null=null;
 constructor(account:ClientConfig,binding:StateMapBinding,source:Source,options:{commit?:(head:StateHead,id:string,ops:StateOperation[])=>Promise<StateReceipt>}={}){
  need(/^[a-f0-9]{64}$/.test(source.deployment)&&/^[a-f0-9]{64}$/.test(source.scope)&&/^[1-9][0-9]*$/.test(source.databaseOid),'AUTH_AUDIT_SOURCE_BINDING');this.#account={...account};this.#binding=Object.freeze({...binding});this.#source=Object.freeze({deployment:source.deployment,databaseOid:source.databaseOid,scope:source.scope});this.#sourceKey=canonicalDigest(this.#source);this.#store=new DomainMapV4(account,binding);this.#commit=options.commit;
 }
 async #prior(s:DomainMapSnapshot,event:AuthAuditEventV4,key:string,requestHash:string){
  const prior=await s.state('receipt',key);if(!prior.present)return null;const c=prior.value as Completion;
  need(c.format===authAuditFormatV4&&c.tenantId===this.#binding.tenantId&&c.source===this.#sourceKey&&c.requestHash===requestHash&&c.sourceEventId===event.header.eventId&&c.sourcePosition===event.header.position&&c.sourceChainHash===event.header.chainHash,'AUTH_AUDIT_RECEIPT_CONFLICT');
  const a=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',c.auditEventId),this.#binding.tenantId),order=await s.get<any>('audit_order',auditPositionKey(c.auditPosition));need(a.hash===c.auditHash&&a.eventId===order.eventId&&order.tenantId===this.#binding.tenantId&&order.position===c.auditPosition&&a.objectType==='AUTHENTICATION'&&a.objectId===event.payload.actorId&&a.actorId===event.payload.actorId&&a.actorType==='USER'&&a.action===event.header.action&&canonicalEqual(a.metadata,this.#metadata(event)),'AUTH_AUDIT_RECEIPT_AUDIT');
  return new VerifiedAuthAuditDeliveryV4(brand,this.#source,event.header,{completion:c,businessDatabaseOid:this.#binding.databaseOid,businessCatalogHash:this.#binding.catalogHash});
 }
 #metadata(event:AuthAuditEventV4){return {authMode:'oidc',roles:event.payload.roles,reason:event.payload.reason,occurredAt:new Date(Number(event.header.occurredAtMs)).toISOString(),authenticationEvent:{format:authAuditFormatV4,source:this.#sourceKey,eventId:event.header.eventId,position:event.header.position,previousHash:event.header.previousHash,chainHash:event.header.chainHash,digest:event.header.digest,sessionRef:event.header.sessionRef}};}
 async deliver(raw:AuthAuditEventV4):Promise<VerifiedAuthAuditDeliveryV4>{
  const event=verifyAuthAuditEventV4(jsonWireClone(raw));need(event.header.tenantId===this.#binding.tenantId&&event.header.scope===this.#source.scope,'AUTH_AUDIT_TENANT_BINDING');const key='auth_audit:'+canonicalDigest([this.#sourceKey,event.header.eventId]),cursorKey='auth_audit:'+this.#sourceKey,requestHash=canonicalDigest({source:this.#source,event});
  for(let attempt=0;;attempt++){
   const s=await this.#store.snapshot();let operations:StateOperation[];
   try{
    const control=await s.get<TelemetryDomainControl>('domain_head','control');need(control.format===telemetryDomainFormat&&control.tenantId===this.#binding.tenantId&&['ACTIVE','PAUSED','UPDATING'].includes(control.status),'AUTH_AUDIT_CONTROL');
    const tenant=JSON.parse(await decodeLegacyText('v4_entity',domainEntityKey('business/tenants',{id:this.#binding.tenantId}),(ns,k)=>s.get(ns,k)));need(tenant.id===this.#binding.tenantId,'AUTH_AUDIT_TENANT');
    const prior=await this.#prior(s,event,key,requestHash);if(prior)return prior;
    need(control.status!=='UPDATING','AUTH_AUDIT_MAINTENANCE_WAIT');
    const previous=await s.state('domain_head',cursorKey),cursor=previous.present?previous.value as Cursor:null;
    need(!cursor||(cursor.format===authAuditFormatV4&&cursor.tenantId===this.#binding.tenantId&&cursor.source===this.#sourceKey&&/^[1-9][0-9]*$/.test(cursor.position)&&/^[a-f0-9]{64}$/.test(cursor.chainHash)),'AUTH_AUDIT_SOURCE_CURSOR');
    need(BigInt(event.header.position)===BigInt(cursor?.position||'0')+1n&&event.header.previousHash===(cursor?.chainHash||'0'.repeat(64)),'AUTH_AUDIT_SOURCE_SEQUENCE');
    const head=await s.get<DomainAuditHead>('domain_head','audit');need(head.tenantId===this.#binding.tenantId&&/^(0|[1-9][0-9]{0,18})$/.test(head.count)&&BigInt(head.count)<9223372036854775807n,'AUTH_AUDIT_HEAD');let previousAudit:AuditEvent|undefined;
    if(head.count==='0')need(head.hash==='GENESIS'&&head.eventId===null,'AUTH_AUDIT_HEAD');else{need(typeof head.eventId==='string');previousAudit=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',head.eventId),this.#binding.tenantId);const order=await s.get<any>('audit_order',auditPositionKey(head.count));need(previousAudit.hash===head.hash&&order.tenantId===this.#binding.tenantId&&order.position===head.count&&order.eventId===head.eventId,'AUTH_AUDIT_TIP');}
    const window={audits:previousAudit?[previousAudit]:[]} as Store,audit=appendAudit(window,{tenantId:this.#binding.tenantId,objectType:'AUTHENTICATION',objectId:event.payload.actorId,action:event.header.action,actorType:'USER',actorId:event.payload.actorId,correlationId:event.header.eventId,metadata:this.#metadata(event)}),position=String(BigInt(head.count)+1n);verifyLocalDomainAudit(audit,this.#binding.tenantId);
    need(!(await s.state('audit',audit.eventId)).present&&!(await s.state('audit_order',auditPositionKey(position))).present,'AUTH_AUDIT_POSITION_EXISTS');
    const completion:Completion={format:authAuditFormatV4,tenantId:this.#binding.tenantId,source:this.#sourceKey,requestHash,sourceEventId:event.header.eventId,sourcePosition:event.header.position,sourceChainHash:event.header.chainHash,auditEventId:audit.eventId,auditPosition:position,auditHash:audit.hash};
    operations=[await s.operation('audit',audit.eventId,audit),await s.operation('audit_order',auditPositionKey(position),{tenantId:this.#binding.tenantId,position,eventId:audit.eventId}),await s.operation('domain_head','audit',{tenantId:this.#binding.tenantId,count:position,eventId:audit.eventId,hash:audit.hash}),await s.operation('domain_head',cursorKey,{format:authAuditFormatV4,tenantId:this.#binding.tenantId,source:this.#sourceKey,position:event.header.position,chainHash:event.header.chainHash,eventId:event.header.eventId}),await s.operation('receipt',key,completion)];
   }finally{this.lastReadStats={...s.stats};await s.close();}
   const command=randomUUID();try{if(this.#commit)await this.#commit(s.head,command,operations!);else await this.#store.commit(s.head,command,operations!);}catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test((e as Error).message))continue;throw e;}
   // Read the committed receipt with a fresh snapshot rather than constructing an acknowledgement from intent.
   const verified=await this.#store.snapshot();try{const result=await this.#prior(verified,event,key,requestHash);need(result,'AUTH_AUDIT_COMMIT_PROOF');return result;}finally{await verified.close();}
  }
 }
}
