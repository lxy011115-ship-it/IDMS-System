import type {ClientConfig} from 'pg';
import type {StateHead,StateMapBinding} from './state-map-sql-v1.ts';
import {DomainReadSnapshotV4} from './domain-read-snapshot-v4.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {decodeLegacyText} from './legacy-map-v4.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {readCatalogFormat,readAssetKey,readAssetOrderKey,type DomainReadCatalogV4,type DomainReadAssetV4} from './domain-read-catalog-v4.ts';
import {telemetryDomainFormat,telemetryReceiptKey,telemetryPointKey,auditPositionKey,verifyLocalDomainAudit,type TelemetryDomainControl,type DomainAuditHead,type DomainTelemetryReceipt} from './telemetry-map-v4.ts';
import {readGovernanceMap} from './source-governance-map-v4.ts';
import {verifySourceReceipt,verifySourcePoint,type SourcePoint} from './source-receipt-integrity.ts';
import type {SourceBinding} from './source-governance.ts';
import type {AuditEvent} from './domain.ts';
import {requireAccess,requiredScope,scopeAllows,scopeFilter,permissionsFor,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import type {AuditCursorCodec} from './audit-cursor.ts';
export const readCursorLifetimeV4=30*60*1000;
type Route='ASSETS'|'AUDIT';
type Cursor={v:1;purpose:'IDMS_DOMAIN_READ_PAGE_V4';identity:string;scope:string;catalog:string;deployment:string;route:Route;pageSize:number;root:StateHead;position:string;capturedAt:number;expiresAt:number};
export class DomainReadErrorV4 extends DomainError {readonly code:string;constructor(status:number,code:string){super(status,code);this.code=code;}}
const fail=(status:number,code:string):never=>{throw new DomainReadErrorV4(status,code);};
function check(ok:unknown,code='READ_MAP_INTEGRITY'):asserts ok{if(!ok)fail(503,code);}
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ordinal=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=9223372036854775807n;
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function bindings(ctx:AccessContext){const order=(v:string[]|undefined)=>[...new Set(v||[])].sort(),filter=scopeFilter(ctx),scope=Object.fromEntries(Object.entries(filter).map(([key,v])=>[key,v===null?null:order(v)]));return {identity:canonicalDigest({tenantId:ctx.tenantId,actorId:ctx.actorId,actorType:ctx.actorType,authMode:ctx.authMode}),scope:canonicalDigest({roles:order(ctx.roles),permissions:order(permissionsFor(ctx.roles||[])),scope,provided:!!ctx.scope?.provided,own:requiredScope(ctx.roles||[])==='OWN_TASKS'})};}
export function domainReadAccessV4(ctx:AccessContext){requireAccess(ctx,'read');if(ctx.authMode!=='oidc'||ctx.actorType!=='USER')fail(403,'READ_OIDC_USER_REQUIRED');const r=requiredScope(ctx.roles||[]);if(['SITE','LINE','OWN_TASKS'].includes(r)&&(!ctx.scope?.provided||![ctx.scope.sites,ctx.scope.lines,ctx.scope.devices].some(v=>v.length>0)))fail(403,'READ_SCOPE_REQUIRED');}
export function parseDomainReadPageV4(params:URLSearchParams,route:Route,ctx:AccessContext,codec:AuditCursorCodec,now=Date.now()){
 domainReadAccessV4(ctx);const seen=new Set<string>();for(const [key]of params){if(!['pageSize','cursor'].includes(key)||seen.has(key))fail(400,'READ_QUERY_INVALID');seen.add(key);}
 const identity=bindings(ctx);let prior:Cursor|undefined;
 if(params.has('cursor')){
  let v:any;try{v=codec.open(params.get('cursor')!);}catch{fail(400,'READ_CURSOR_INVALID');}
  if(!exact(v,['v','purpose','identity','scope','catalog','deployment','route','pageSize','root','position','capturedAt','expiresAt'])||v.v!==1||v.purpose!=='IDMS_DOMAIN_READ_PAGE_V4'||!hash(v.identity)||!hash(v.scope)||!hash(v.catalog)||!hash(v.deployment)||v.route!==route||!Number.isInteger(v.pageSize)||v.pageSize<1||v.pageSize>20||!ordinal(v.position)||!exact(v.root,['revision','rootId','rootHash','count','receiptHash'])||!ordinal(v.root.revision)||!ordinal(v.root.count)||!(v.root.rootId===null||hash(v.root.rootId))||!hash(v.root.rootHash)||!hash(v.root.receiptHash)||!Number.isSafeInteger(v.capturedAt)||v.capturedAt<0||v.capturedAt>now+30000||!Number.isSafeInteger(v.expiresAt)||v.expiresAt-v.capturedAt!==readCursorLifetimeV4)fail(400,'READ_CURSOR_INVALID');
  if(v.identity!==identity.identity)fail(400,'READ_CURSOR_IDENTITY');if(v.scope!==identity.scope)fail(409,'READ_SCOPE_CHANGED');if(v.expiresAt<=now)fail(410,'READ_CURSOR_EXPIRED');prior=v;
 }
 const raw=params.get('pageSize');let pageSize=prior?.pageSize||20;if(raw!==null){if(!/^[1-9][0-9]?$/.test(raw)||Number(raw)>20)fail(400,'READ_QUERY_INVALID');pageSize=Number(raw);}if(prior&&pageSize!==prior.pageSize)fail(400,'READ_QUERY_CHANGED');return {...identity,prior,pageSize,route,now};
}
export class DomainReadApiV4 {
 #account:ClientConfig;#binding:StateMapBinding;#codec:AuditCursorCodec;
 constructor(account:ClientConfig,binding:StateMapBinding,codec:AuditCursorCodec){this.#account={...account};this.#binding=Object.freeze({...binding});this.#codec=codec;}
 async #open(ctx:AccessContext){domainReadAccessV4(ctx);if(ctx.tenantId!==this.#binding.tenantId)fail(404,'READ_NOT_FOUND');const s=await DomainReadSnapshotV4.open(this.#account,this.#binding);try{
  const control=await s.get<TelemetryDomainControl>('domain_head','control');check(control.format===telemetryDomainFormat&&control.tenantId===ctx.tenantId&&['ACTIVE','PAUSED'].includes(control.status),'READ_INTAKE_UPDATING');
  const tenant=JSON.parse(await decodeLegacyText('v4_entity',domainEntityKey('business/tenants',{id:ctx.tenantId}),(ns,k)=>s.get(ns,k)));if(tenant.id!==ctx.tenantId||tenant.status!=='ACTIVE')fail(403,'READ_TENANT_INACTIVE');
  const catalog=await s.get<DomainReadCatalogV4>('domain_head','read_catalog');check(catalog.format===readCatalogFormat&&catalog.tenantId===ctx.tenantId&&catalog.governanceAnchorDigest===control.governanceAnchorDigest&&hash(catalog.generation)&&Number.isSafeInteger(catalog.assetsCount)&&catalog.assetsCount>=0&&catalog.assetsCount<=1000000,'READ_CATALOG_STALE');return {s,catalog};
 }catch(e){await s.close();throw e;}}
 async #asset(s:DomainReadSnapshotV4,catalog:DomainReadCatalogV4,code:string,root?:StateHead){const key=readAssetKey(catalog.generation,code),present=await s.state('blob',key,root);if(!present.present)return null;const row=JSON.parse(await decodeLegacyText('blob',key,(ns,k)=>s.get(ns,k,root))) as DomainReadAssetV4;check(row.tenantId===s.tenantId&&row.deviceCode===code&&['APPROVED_IMPORT','LEGACY'].includes(row.kind)&&row.scope?.device_code===code);return row;}
 async #visible(s:DomainReadSnapshotV4,catalog:DomainReadCatalogV4,ctx:AccessContext,code:string,root:StateHead){const current=await this.#asset(s,catalog,code),then=await this.#asset(s,catalog,code,root);return !!current&&!!then&&scopeAllows(ctx,current.scope)&&scopeAllows(ctx,then.scope);}
 async #entity(s:DomainReadSnapshotV4,collection:string,identity:unknown,root?:StateHead){const key=domainEntityKey(collection,identity),state=await s.state('v4_entity',key,root);return state.present?JSON.parse(await decodeLegacyText('v4_entity',key,(ns,k)=>s.get(ns,k,root))):null;}
 async #auditVisible(s:DomainReadSnapshotV4,catalog:DomainReadCatalogV4,ctx:AccessContext,event:AuditEvent,root:StateHead){
  if(['TENANT','READONLY_TENANT'].includes(requiredScope(ctx.roles||[])))return true;
  const own=requiredScope(ctx.roles||[])==='OWN_TASKS',device=(code:string)=>this.#visible(s,catalog,ctx,code,root);
  if(event.objectType==='TELEMETRY_EVENT')return typeof event.metadata.deviceCode==='string'&&device(event.metadata.deviceCode);
  if(event.objectType==='PREDICTIVE_REVIEW')return device(event.objectId);
  if(event.objectType==='AUTHENTICATION')return event.actorId===ctx.actorId;
  const kinds:Record<string,string>={DATA_IMPORT:'imports/batches',WORK_ORDER:'business/workOrders',ALARM:'business/alarms',PREDICTIVE_ALERT:'business/predictiveAlerts',HEALTH_SNAPSHOT:'business/healthSnapshots'},collection=kinds[event.objectType];if(!collection)return false;
  const id=event.objectType==='DATA_IMPORT'?{batchId:event.objectId}:{id:event.objectId};
  for(const at of [undefined,root]){const row=await this.#entity(s,collection,id,at);if(!row||row.tenantId!==ctx.tenantId)return false;
   if(event.objectType==='DATA_IMPORT'){if(!Array.isArray(row.rows)||!row.rows.length)return false;for(const value of [...row.rows,...(row.correction?.baseRows||[]).map((r:any)=>r.before)])if(row.dataType==='DEVICE'?!scopeAllows(ctx,value):!await device(String(value.device_code||'')))return false;}
   else if(event.objectType==='ALARM'){const asset=await this.#entity(s,'business/devices',{id:row.deviceId},at);if(!asset||asset.tenantId!==ctx.tenantId||!await device(asset.code)||own&&row.assignee!==ctx.actorId)return false;}
   else if(!await device(row.deviceCode)||event.objectType==='WORK_ORDER'&&own&&row.assignee!==ctx.actorId)return false;
  }return true;
 }
 async #page(params:URLSearchParams,ctx:AccessContext,route:Route){
  const plan=parseDomainReadPageV4(params,route,ctx,this.#codec),{s,catalog}=await this.#open(ctx);try{
   const deployment=canonicalDigest(this.#binding);if(plan.prior&&plan.prior.deployment!==deployment)fail(400,'READ_CURSOR_DEPLOYMENT');if(plan.prior&&plan.prior.catalog!==catalog.generation)fail(409,'READ_CATALOG_CHANGED');const root=plan.prior?.root||s.currentHead;if(BigInt(root.revision)>BigInt(s.currentHead.revision))fail(409,'READ_WINDOW_CHANGED');
   const historical=await s.get<DomainReadCatalogV4>('domain_head','read_catalog',root);check(canonicalEqual(historical,catalog),'READ_HISTORICAL_CATALOG');const items:unknown[]=[];let position=plan.prior?.position;let scanned=0,more=false;
   if(route==='ASSETS'){
    let index=position===undefined?1:Number(position);check(Number.isSafeInteger(index)&&index>=1&&index<=catalog.assetsCount+1);while(index<=catalog.assetsCount&&scanned<48&&items.length<plan.pageSize){const order=await s.get<{tenantId:string;generation:string;position:number;deviceCode:string}>('blob',readAssetOrderKey(catalog.generation,index),root);check(order.tenantId===ctx.tenantId&&order.generation===catalog.generation&&order.position===index&&typeof order.deviceCode==='string');if(await this.#visible(s,catalog,ctx,order.deviceCode,root)){const row=await this.#asset(s,catalog,order.deviceCode,root);check(row?.kind==='APPROVED_IMPORT');items.push(row.record);}index++;scanned++;}position=String(index);more=index<=catalog.assetsCount;
   }else{
    const head=await s.get<DomainAuditHead>('domain_head','audit',root);check(head.tenantId===ctx.tenantId&&ordinal(head.count));let index=position===undefined?BigInt(head.count):BigInt(position);check(index<=BigInt(head.count));let newer:AuditEvent|undefined;
    if(index<BigInt(head.count)){const order=await s.get<{eventId:string}>('audit_order',auditPositionKey(String(index+1n)),root);newer=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',order.eventId,root),ctx.tenantId);}
    while(index>0n&&scanned<48&&items.length<plan.pageSize){const order=await s.get<{tenantId:string;position:string;eventId:string}>('audit_order',auditPositionKey(String(index)),root);check(order.tenantId===ctx.tenantId&&order.position===String(index));const event=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',order.eventId,root),ctx.tenantId);check(event.eventId===order.eventId&&(!newer||newer.previousHash===event.hash));if(index===BigInt(head.count))check(head.eventId===event.eventId&&head.hash===event.hash);if(index===1n)check(event.previousHash==='GENESIS');
     const visible=await this.#auditVisible(s,catalog,ctx,event,root);
     if(visible)items.push(event);newer=event;index--;scanned++;
    }
    if(index>0n&&newer){const previous=await s.get<{tenantId:string;position:string;eventId:string}>('audit_order',auditPositionKey(String(index)),root),e=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',previous.eventId,root),ctx.tenantId);check(previous.tenantId===ctx.tenantId&&previous.position===String(index)&&e.eventId===previous.eventId&&newer.previousHash===e.hash);}position=String(index);more=index>0n;
   }
   const capturedAt=plan.prior?.capturedAt||plan.now,expiresAt=plan.prior?.expiresAt||capturedAt+readCursorLifetimeV4,cursor=more?this.#codec.seal({v:1,purpose:'IDMS_DOMAIN_READ_PAGE_V4',identity:plan.identity,scope:plan.scope,catalog:catalog.generation,deployment,route,pageSize:plan.pageSize,root,position,capturedAt,expiresAt} satisfies Cursor):null;
   return {items,pageSize:plan.pageSize,nextCursor:cursor,capturedAt,verificationScope:route==='AUDIT'?'MAP_PROOF_AND_LOCAL_CHAIN':'MAP_MEMBERSHIP_PROOFS',partialView:!['TENANT','READONLY_TENANT'].includes(requiredScope(ctx.roles||[])),readStats:{...s.stats}};
  }finally{await s.close();}
 }
 assets(params:URLSearchParams,ctx:AccessContext){return this.#page(params,ctx,'ASSETS');}
 audit(params:URLSearchParams,ctx:AccessContext){return this.#page(params,ctx,'AUDIT');}
 async receipt(eventId:string,params:URLSearchParams,ctx:AccessContext){
  const keys=[...params.keys()];if(keys.length!==2||!keys.includes('edgeId')||!keys.includes('digest')||!/^[-\w]{1,100}$/.test(eventId)||!/^[-\w.]{1,128}$/.test(params.get('edgeId')||'')||!hash(params.get('digest')))fail(400,'READ_QUERY_INVALID');
  const {s,catalog}=await this.#open(ctx);try{const edge=params.get('edgeId')!,digest=params.get('digest')!,key=telemetryReceiptKey(edge,eventId,digest),value=await s.state('receipt',key);if(!value.present)fail(404,'READ_NOT_FOUND');
   const verify=async(v:DomainTelemetryReceipt,seen:Set<string>):Promise<{audit:AuditEvent;point:SourcePoint|null}>=>{check(v.format===telemetryDomainFormat&&v.tenantId===ctx.tenantId&&!seen.has(v.auditEventId)&&seen.size<3);seen.add(v.auditEventId);const a=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',v.auditEventId),ctx.tenantId),frozen=a.metadata.sourceGovernance as SourceBinding|undefined;let historical:SourceBinding|null=null;if(frozen){const q=await readGovernanceMap(frozen.configuredSource,Date.parse(a.businessTime),typeof v.receipt.envelope.tagCode==='string'?v.receipt.envelope.tagCode:null,(ns,k)=>s.get(ns,k));historical=q.decision.binding;}
    verifySourceReceipt(v.receipt,a,ctx.tenantId,edge,(source,at,tag)=>{check(frozen&&canonicalEqual(source,frozen.configuredSource)&&at===Date.parse(a.businessTime)&&tag===(typeof v.receipt.envelope.tagCode==='string'?v.receipt.envelope.tagCode:null));return historical;});let point:SourcePoint|null=null;if(v.receipt.status==='STORED'){point=await s.get<SourcePoint>('blob',telemetryPointKey(v.receipt.point_id!));verifySourcePoint(v.receipt,a,point,ctx.tenantId,edge);if(point.input_digest!==v.receipt.digest){const origin=await s.get<{receiptKey:string}>('point_origin',point.id),r=await s.get<DomainTelemetryReceipt>('receipt',origin.receiptKey);check(r.receipt.digest===point.input_digest&&r.receipt.point_id===point.id);const original=await verify(r,seen);check(original.audit.action==='TELEMETRY_STORED');verifySourcePoint(r.receipt,original.audit,point,ctx.tenantId,edge);}}return {audit:a,point};};
   const v=value.value as DomainTelemetryReceipt;check(v.receipt.event_id===eventId&&v.receipt.digest===digest&&v.receipt.edge_id===edge);const result=await verify(v,new Set());const code=result.audit.metadata.deviceCode;if(typeof code!=='string'||!await this.#visible(s,catalog,ctx,code,s.currentHead))fail(404,'READ_NOT_FOUND');
   // Rejected envelopes may contain foreign identity and arbitrary user fields. Never publish them.
   const r=v.receipt;return {receipt:{edgeId:edge,eventId:r.event_id,digest:r.digest,sequenceNo:r.sequence_no,status:r.status,reason:r.reason,pointId:r.point_id,receivedAt:r.received_at},audit:result.audit,point:result.point,verificationScope:'MAP_PROOFS_AND_LEGACY_RECEIPT_POINT_RULES',readStats:{...s.stats}};
  }finally{await s.close();}
 }
}
