import {createHash,randomUUID} from 'node:crypto';
import {appendAudit} from './audit.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {DomainMapV4,DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import {readGovernanceMap} from './source-governance-map-v4.ts';
import {publicGovernedSource,type SourceGovernanceDecision,type SourceBinding} from './source-governance.ts';
import {publicRegistry} from './registry-history.ts';
import {verifySourceReceipt,verifySourcePoint,type SourceReceipt,type SourcePoint} from './source-receipt-integrity.ts';
import {measurementSchema} from './measurement-schema.ts';
import {stable,sha,authenticEvent,validateEvent,signAck,topicFor,type EdgeSource,type TelemetryEvent,type TelemetryAck} from '../integrations/telemetry.ts';
import type {Store} from './store.ts';
import type {AuditEvent} from './domain.ts';
import type {StateOperation} from './state-map-v1.ts';
export const telemetryDomainFormat='IDMS_TELEMETRY_DOMAIN_V4_1';
export interface TelemetryDomainControl {format:typeof telemetryDomainFormat;tenantId:string;status:'ACTIVE'|'UPDATING'|'PAUSED';epoch:string;legacySealKey:string;governanceAnchorDigest:string}
export interface DomainAuditHead {tenantId:string;count:string;eventId:string|null;hash:string}
export interface DomainRegistryHead {tenantId:string;revision:string;hash:string;configurationHash:string}
export interface DomainTelemetryReceipt {format:typeof telemetryDomainFormat;tenantId:string;receipt:SourceReceipt;auditEventId:string}
export const telemetryReceiptKey=(edge:string,eventId:string,digest:string)=>'telemetry:'+canonicalDigest([edge,eventId,digest]);
export const telemetryEventKey=(edge:string,eventId:string)=>canonicalDigest([edge,eventId]);
export const telemetrySequenceKey=(edge:string,sequence:string)=>canonicalDigest([edge,sequence]);
export const telemetryTimeKey=(edge:string,device:string,tag:string,time:string)=>canonicalDigest([edge,device,tag,time]);
export const telemetryPointKey=(id:string)=>'telemetry_point:'+id;
export const auditPositionKey=(position:string)=>{need(/^[1-9][0-9]{0,18}$/.test(position)&&BigInt(position)<=9223372036854775807n);return position.padStart(20,'0');};
const clean=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
export function verifyLocalDomainAudit(a:AuditEvent,tenant:string){const {hash,...base}=a;need(a.tenantId===tenant&&typeof a.previousHash==='string'&&hash===createHash('sha256').update(a.previousHash+stable(base)).digest('hex'),'DOMAIN_AUDIT_INTEGRITY');return a;}
async function auditPlan(snapshot:DomainMapSnapshot,input:Parameters<typeof appendAudit>[1]){
 const head=await snapshot.get<DomainAuditHead>('domain_head','audit');need(head.tenantId===snapshot.tenantId&&/^(0|[1-9][0-9]{0,18})$/.test(head.count));const n=BigInt(head.count);need(n<9223372036854775807n);let previous:AuditEvent|undefined;
 if(n===0n)need(head.eventId===null&&head.hash==='GENESIS');else{need(typeof head.eventId==='string');previous=verifyLocalDomainAudit(await snapshot.get<AuditEvent>('audit',head.eventId),snapshot.tenantId);const order=await snapshot.get<{tenantId:string;position:string;eventId:string}>('audit_order',auditPositionKey(head.count));need(previous.hash===head.hash&&order.tenantId===snapshot.tenantId&&order.position===head.count&&order.eventId===head.eventId);}
 const window={audits:previous?[previous]:[]} as Store,event=clean(appendAudit(window,input)),position=String(n+1n);verifyLocalDomainAudit(event,snapshot.tenantId);
 need(!(await snapshot.state('audit_order',auditPositionKey(position))).present,'DOMAIN_AUDIT_POSITION_EXISTS');const ops=[await snapshot.operation('audit',event.eventId,event),await snapshot.operation('audit_order',auditPositionKey(position),{tenantId:snapshot.tenantId,position,eventId:event.eventId}),await snapshot.operation('domain_head','audit',{tenantId:snapshot.tenantId,count:position,eventId:event.eventId,hash:event.hash})];return {event,ops};
}
function protocolReason(event:TelemetryEvent,source:EdgeSource,decision:SourceGovernanceDecision){if(decision.enforced&&!decision.allowed)return decision.reason||'SOURCE_APPROVAL_DENIED';try{validateEvent(event,source,decision.enforced?decision.definitions:measurementSchema);return null;}catch(e){return e instanceof Error?e.message:'INVALID_EVENT';}}
async function priorVerified(snapshot:DomainMapSnapshot,source:EdgeSource,value:DomainTelemetryReceipt){
 const r=value.receipt,a=verifyLocalDomainAudit(await snapshot.get<AuditEvent>('audit',value.auditEventId),source.tenantId);need(value.format===telemetryDomainFormat&&value.tenantId===source.tenantId);
 const frozen=a.metadata.sourceGovernance as SourceBinding|undefined;let historical:SourceBinding|null=null;
 if(frozen){const q=await readGovernanceMap(frozen.configuredSource,Date.parse(a.businessTime),typeof r.envelope.tagCode==='string'?r.envelope.tagCode:null,(ns,k)=>snapshot.get(ns,k));historical=q.decision.binding;}
 verifySourceReceipt(r,a,source.tenantId,source.edgeId,(s,at,tag)=>{need(frozen&&canonicalEqual(publicGovernedSource(s),publicGovernedSource(frozen.configuredSource))&&at===Date.parse(a.businessTime)&&tag===(typeof r.envelope.tagCode==='string'?r.envelope.tagCode:null));return historical;});
 if(r.status==='STORED'){
  const p=await snapshot.get<SourcePoint>('blob',telemetryPointKey(r.point_id!));verifySourcePoint(r,a,p,source.tenantId,source.edgeId);
  if(p.input_digest!==r.digest){const origin=await snapshot.get<{receiptKey:string}>('point_origin',p.id),original=await snapshot.get<DomainTelemetryReceipt>('receipt',origin.receiptKey);need(original.receipt.digest===p.input_digest&&original.receipt.point_id===p.id,'DOMAIN_POINT_ORIGIN_INTEGRITY');const originalAudit=await priorVerified(snapshot,source,original);need(originalAudit.action==='TELEMETRY_STORED');verifySourcePoint(original.receipt,originalAudit,p,source.tenantId,source.edgeId);}
 }return a;
}
export class TelemetryMapV4Receiver {
 readonly store:DomainMapV4;readonly registryHash:string;readonly sources:readonly EdgeSource[];lastReadStats:DomainMapSnapshot['stats']|null=null;
 #publish:(topic:string,ack:TelemetryAck)=>Promise<void>|void;
 constructor(store:DomainMapV4,sources:readonly EdgeSource[],publish:(topic:string,ack:TelemetryAck)=>Promise<void>|void){
  need(sources.length>0&&sources.length<=100&&sources.every(s=>s.tenantId===store.tenantId&&s.origin==='SIMULATOR'&&[s.signingKey,s.acknowledgementKey].every(k=>typeof k==='string'&&k.length>=32)),'DOMAIN_SOURCE_CONFIG');for(const s of sources)publicGovernedSource(s);
  need(new Set(sources.map(s=>s.edgeId)).size===sources.length,'DOMAIN_SOURCE_CONFIG');this.store=store;this.sources=structuredClone(sources);this.registryHash=canonicalDigest(publicRegistry(this.sources,store.tenantId));this.#publish=publish;
 }
 async #plan(s:DomainMapSnapshot,source:EdgeSource,event:TelemetryEvent,digest:string){
  const control=await s.get<TelemetryDomainControl>('domain_head','control');need(control.format===telemetryDomainFormat&&control.tenantId===source.tenantId&&control.status==='ACTIVE','DOMAIN_INTAKE_CLOSED');
  const registry=await s.get<DomainRegistryHead>('domain_head','registry');need(registry.tenantId===source.tenantId&&registry.configurationHash===this.registryHash,'DOMAIN_REGISTRY_STALE');const registryObservation={revision:registry.revision,configurationHash:registry.configurationHash},tag=typeof event.tagCode==='string'?event.tagCode:null,q=await readGovernanceMap(source,Date.now(),tag,(ns,k)=>s.get(ns,k));need(q.head.compiledPayloadDigest===control.governanceAnchorDigest,'DOMAIN_GOVERNANCE_STALE');const decision=q.decision,reasonNow=protocolReason(event,source,decision),receiptKey=telemetryReceiptKey(source.edgeId,event.eventId,digest),prior=await s.state('receipt',receiptKey);
  const input=(status:string,pointId:string|null,reason:string|null)=>({tenantId:source.tenantId,objectType:'TELEMETRY_EVENT',objectId:event.eventId,action:'TELEMETRY_'+status,actorType:'INTERFACE' as const,actorId:source.edgeId,correlationId:event.eventId,metadata:{inputDigest:digest,origin:source.origin,deviceCode:decision.binding?.approvedIdentity?.deviceCode||source.deviceCode,mapVersion:source.mapVersion,pointId,reason:reason||undefined,...(decision.enforced?{registryObservation,sourceGovernance:decision.binding}:{})}});
  const audit=async(status:string,pointId:string|null,reason:string|null)=>{
   const p=await auditPlan(s,input(status,pointId,reason));const exact=await readGovernanceMap(source,Date.parse(p.event.businessTime),tag,(ns,k)=>s.get(ns,k));need(canonicalEqual(exact.decision,decision),'DOMAIN_GOVERNANCE_TIME_BOUNDARY');return p;
  };
  if(prior.present){const value=prior.value as DomainTelemetryReceipt;need(value.receipt.digest===digest&&canonicalEqual(value.receipt.envelope,event),'DOMAIN_RECEIPT_INTEGRITY');if(decision.enforced&&reasonNow&&value.receipt.status==='STORED'){const p=await audit('REPLAY_DENIED',value.receipt.point_id,reasonNow);return {status:'REJECTED' as const,reason:reasonNow,ops:p.ops};}await priorVerified(s,source,value);return {status:value.receipt.status as 'STORED'|'REJECTED',reason:value.receipt.reason||undefined,ops:[] as StateOperation[]};}
  const eventKey=telemetryEventKey(source.edgeId,event.eventId),previous=await s.state('telemetry_event',eventKey);let rejection=previous.present?'EVENT_ID_CONFLICT':reasonNow,pointId:string|null=null,point:SourcePoint|undefined,createPoint=false;
  if(!rejection){const sequence=await s.state('telemetry_sequence',telemetrySequenceKey(source.edgeId,String(event.sequenceNo)));if(sequence.present)rejection='SEQUENCE_CONFLICT';}
  const timeKey=!rejection?telemetryTimeKey(source.edgeId,source.deviceCode,event.tagCode,event.eventTime):null;
  if(timeKey){const existing=await s.state('telemetry_time',timeKey);if(existing.present){const reference=existing.value as {pointId:string};point=await s.get<SourcePoint>('blob',telemetryPointKey(reference.pointId));need(point.tenant_id===source.tenantId&&point.edge_id===source.edgeId&&point.device_code===source.deviceCode&&point.tag_code===event.tagCode&&point.event_time===event.eventTime);if(point.value!==event.value||point.quality!==event.quality||point.unit!==event.unit||point.node_id!==event.nodeId||point.map_version!==event.mapVersion)rejection='POINT_TIME_CONFLICT';else pointId=point.id;}else{pointId=event.eventId.toLowerCase();need(!(await s.state('blob',telemetryPointKey(pointId))).present,'DOMAIN_POINT_ID_CONFLICT');createPoint=true;}}
  const status=rejection?'REJECTED':'STORED',p=await audit(status,pointId,rejection),receivedAt=p.event.businessTime,ops=[...p.ops];
  if(createPoint){point={tenant_id:source.tenantId,id:pointId!,edge_id:source.edgeId,device_code:source.deviceCode,tag_code:event.tagCode,node_id:event.nodeId,map_version:source.mapVersion,origin:source.origin,sequence_no:String(event.sequenceNo),event_time:event.eventTime,received_at:receivedAt,value:event.value,unit:event.unit,quality:event.quality,input_digest:digest};ops.push(await s.operation('blob',telemetryPointKey(pointId!),point),await s.operation('telemetry_time',timeKey!,{pointId}),await s.operation('point_origin',pointId!,{receiptKey}));}
  // Match the existing pg JSON parameter boundary, including signed 1e400 -> null.
  // The protocol rejection/digest above still use the authenticated parsed envelope.
  const value:DomainTelemetryReceipt={format:telemetryDomainFormat,tenantId:source.tenantId,receipt:{edge_id:source.edgeId,event_id:event.eventId,digest,sequence_no:Number.isSafeInteger(event.sequenceNo)?String(event.sequenceNo):null,status,reason:rejection||null,point_id:pointId,envelope:clean(event),received_at:receivedAt},auditEventId:p.event.eventId};
  ops.push(await s.operation('receipt',receiptKey,value));if(!previous.present)ops.push(await s.operation('telemetry_event',eventKey,{edgeId:source.edgeId,eventId:event.eventId,firstReceiptKey:receiptKey}));if(status==='STORED')ops.push(await s.operation('telemetry_sequence',telemetrySequenceKey(source.edgeId,String(event.sequenceNo)),{receiptKey}));
  return {status:status as 'STORED'|'REJECTED',reason:rejection||undefined,ops};
 }
 async receive(topic:string,bytes:Buffer):Promise<TelemetryAck|null>{
  if(bytes.length>8192)return null;const source=this.sources.find(s=>topicFor(s,'telemetry')===topic);if(!source)return null;let event:unknown;try{event=JSON.parse(bytes.toString('utf8'));}catch{return null;}if(!authenticEvent(event,source.signingKey)||typeof event.eventId!=='string'||event.eventId.length>100)return null;const digest=sha(event);
  for(let attempt=0;;attempt++){
   const snapshot=await this.store.snapshot();let plan:{status:'STORED'|'REJECTED';reason?:string;ops:StateOperation[]};
   try{plan=await this.#plan(snapshot,source,event,digest);}finally{this.lastReadStats={...snapshot.stats};await snapshot.close();}
   try{if(plan.ops.length)await this.store.commit(snapshot.head,randomUUID(),plan.ops);}catch(e){if(attempt<3&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test((e as Error).message))continue;throw e;}
   const ack=signAck({version:1,eventId:event.eventId,tenantId:source.tenantId,edgeId:source.edgeId,digest,status:plan.status,...(plan.reason?{reason:plan.reason}:{})},source.acknowledgementKey);await this.#publish(topicFor(source,'ack'),ack);return ack;
  }
 }
}
