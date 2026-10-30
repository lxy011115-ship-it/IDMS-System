import type {KeyObject} from 'node:crypto';
import {canonicalEqual,canonicalDigest} from './canonical-state.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {fieldMapAuditPlanV1,type FieldMapSnapshotV1} from './field-map-audit-v1.ts';
import {fieldIntakeDecisionMapV1,fieldIntakeFingerprintMapV1,inspectHistoricalIntakeDecisionMapV1} from './field-map-intake-decision-v1.ts';
import {fieldIntakeVersion} from './field-schema.ts';
import {verifyLocalDomainAudit,auditPositionKey} from './telemetry-map-v4.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {stable} from '../integrations/telemetry.ts';
import {fieldEventDigest,fieldEventBody,type SignedFieldEvent} from '../integrations/field-event.ts';
import type {FieldRegistrySnapshot} from './field-registry.ts';
import type {FieldIntakeDecision} from './field-intake-decision.ts';
import type {AuditEvent} from './domain.ts';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {StateOperation} from './state-map-v1.ts';
export const fieldMapReceiptFormatV1='IDMS_FIELD_MAP_RECEIPT_V1';
export const fieldMapReceiptKeyV1=(event:SignedFieldEvent)=>'field:'+canonicalDigest([event.source.edgeId,event.eventId,fieldEventDigest(event)]);
export const fieldMapSequenceKeyV1=(event:SignedFieldEvent)=>canonicalDigest([event.source.edgeId,event.streamId,String(event.sequenceNo)]);
export const fieldMapReadKeyV1=(event:SignedFieldEvent)=>canonicalDigest([event.source.edgeId,event.streamId,event.witness.readId,event.sample.tagCode]);
export const fieldMapPointKeyV1=(id:string)=>'field_point:'+id;
export const fieldMapDeviceKeyV1=(device:string)=>canonicalDigest(device);
export const fieldMapOrderKeyV1=(device:string,position:string)=>fieldMapDeviceKeyV1(device)+':'+auditPositionKey(position);
export interface FieldMapStorageV1 extends StateMapBinding {format:'IDMS_FIELD_MAP_STORAGE_V1'}
export interface FieldMapOutcomeV1 {status:'STORED'|'REJECTED';reason:string|null;pointId:string|null;receiptAuditId:string;receiptAt:string}
export function fieldMapStorageV1(binding:StateMapBinding):FieldMapStorageV1{need(/^[a-z][a-z0-9_-]{0,63}$/.test(binding.tenantId)&&/^[1-9][0-9]*$/.test(binding.databaseOid)&&/^[1-9][0-9]*$/.test(binding.roleOid)&&/^[a-f0-9]{64}$/.test(binding.catalogHash),'FIELD_MAP_STORAGE_BINDING');return {format:'IDMS_FIELD_MAP_STORAGE_V1',tenantId:binding.tenantId,databaseOid:binding.databaseOid,roleOid:binding.roleOid,catalogHash:binding.catalogHash};}
export function fieldMapPointBodyV1(event:SignedFieldEvent,audit:Pick<AuditEvent,'eventId'|'businessTime'>){return {format:'idms-field-point-v1',id:event.eventId,source:event.source,streamId:event.streamId,sequenceNo:event.sequenceNo,profileDigest:event.profileDigest,admissionDigest:event.lease.body.admissionDigest,registryRevision:event.lease.body.registryRevision,registryDigest:event.lease.body.registryDigest,leaseId:event.lease.body.leaseId,readId:event.witness.readId,witnessDigest:fieldSha256(stable(event.witness)),sample:event.sample,receivedAt:audit.businessTime,auditEventId:audit.eventId};}
function receiptBody(event:SignedFieldEvent,audit:Pick<AuditEvent,'eventId'|'businessTime'>,status:'STORED'|'REJECTED',reason:string|null){return {format:'idms-field-receipt-v1',tenantId:event.source.tenantId,edgeId:event.source.edgeId,eventId:event.eventId,eventDigest:fieldEventDigest(event),streamId:event.streamId,sequenceNo:event.sequenceNo,readId:event.witness.readId,status,reason,pointId:status==='STORED'?event.eventId:null,auditEventId:audit.eventId,receivedAt:audit.businessTime,envelope:event};}
type Receipt=ReturnType<typeof receiptBody>;
function metadata(event:SignedFieldEvent,decision:FieldIntakeDecision,storage:FieldMapStorageV1,status:'STORED'|'REJECTED',reason:string|null,auditPosition:string){return {format:fieldMapReceiptFormatV1,ruleVersion:fieldIntakeVersion,storage,auditPosition,eventDigest:fieldEventDigest(event),streamId:event.streamId,readId:event.witness.readId,envelope:event,decision,result:{status,reason,pointId:status==='STORED'?event.eventId:null}};}
const outcome=(event:SignedFieldEvent,audit:Pick<AuditEvent,'eventId'|'businessTime'>,status:'STORED'|'REJECTED',reason:string|null):FieldMapOutcomeV1=>({status,reason,pointId:status==='STORED'?event.eventId:null,receiptAuditId:audit.eventId,receiptAt:audit.businessTime});
export async function inspectFieldMapReceiptV1(s:FieldMapSnapshotV1,raw:unknown,key:KeyObject,storage:FieldMapStorageV1){
 const r=raw as Receipt;need(r&&['STORED','REJECTED'].includes(r.status)&&r.tenantId===s.tenantId&&typeof r.auditEventId==='string','FIELD_MAP_RECEIPT_INTEGRITY');
 const event=r.envelope;need(event&&typeof event.signature==='string'&&/^[a-f0-9]{64}$/.test(event.signature),'FIELD_MAP_RECEIPT_INTEGRITY');const audit=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',r.auditEventId),s.tenantId),m=audit.metadata as ReturnType<typeof metadata>;
 need(m?.format===fieldMapReceiptFormatV1&&typeof m.decision?.registry?.registryEventId==='string','FIELD_MAP_RECEIPT_INTEGRITY');
 const historical=await inspectHistoricalIntakeDecisionMapV1(s,event,key,Date.parse(audit.businessTime),m.decision.registry.registryEventId);
 need(typeof m.auditPosition==='string'&&/^[1-9][0-9]{0,18}$/.test(m.auditPosition),'FIELD_MAP_RECEIPT_INTEGRITY');const order=await s.get<any>('audit_order',auditPositionKey(m.auditPosition));need(order.tenantId===s.tenantId&&order.position===m.auditPosition&&order.eventId===audit.eventId,'FIELD_MAP_RECEIPT_INTEGRITY');
 need(historical.allowed&&canonicalEqual(m,metadata(event,historical,storage,r.status,r.reason,m.auditPosition))&&canonicalEqual(r,receiptBody(event,audit,r.status,r.reason)),'FIELD_MAP_RECEIPT_INTEGRITY');
 const profile=(await s.get<any>('audit',historical.originalLease.registry.eventId)).after.channels.find((c:any)=>c.profile.source.edgeId===event.source.edgeId)?.profile;const {signature,...body}=event;need(canonicalEqual(fieldEventBody(body,profile,key),body),'FIELD_MAP_RECEIPT_INTEGRITY');
 need(audit.objectType==='FIELD_EVENT'&&audit.objectId===event.eventId&&audit.action==='FIELD_EVENT_'+r.status&&audit.actorType==='INTERFACE'&&audit.actorId===event.source.edgeId&&audit.correlationId===event.eventId&&audit.before===undefined&&audit.after===undefined,'FIELD_MAP_RECEIPT_INTEGRITY');
 if(r.status==='STORED'){
  need(r.reason===null&&r.pointId===event.eventId&&Date.parse(r.receivedAt)>=Date.parse(event.witness.observedAt),'FIELD_MAP_RECEIPT_INTEGRITY');const point=await s.get('blob',fieldMapPointKeyV1(event.eventId));need(canonicalEqual(point,fieldMapPointBodyV1(event,audit)),'FIELD_MAP_POINT_INTEGRITY');
 }else need(r.pointId===null&&typeof r.reason==='string'&&/^FIELD_(EVENT_ID|SEQUENCE|READ_ID)_CONFLICT$/.test(r.reason),'FIELD_MAP_RECEIPT_INTEGRITY');
 return {event,audit,receipt:r,candidate:outcome(event,audit,r.status,r.reason),historical,auditPosition:m.auditPosition};
}
export async function planFieldReceiveMapV1(s:FieldMapSnapshotV1,event:SignedFieldEvent,profile:unknown,snapshot:FieldRegistrySnapshot,key:KeyObject,storage:FieldMapStorageV1){
 need(storage.tenantId===s.tenantId,'FIELD_MAP_STORAGE_BINDING');const initial=await fieldIntakeDecisionMapV1(s,profile,snapshot,event,key,Date.now()),fingerprint=fieldIntakeFingerprintMapV1(initial);
 const position=String(BigInt((await s.get<any>('domain_head','audit')).count)+1n);
 const append=async(status:'STORED'|'REJECTED',reason:string|null,action:string)=>fieldMapAuditPlanV1(s,async businessTime=>{const exact=await fieldIntakeDecisionMapV1(s,profile,snapshot,event,key,Date.parse(businessTime));need(fieldIntakeFingerprintMapV1(exact)===fingerprint,'FIELD_MAP_INTAKE_TIME_BOUNDARY');return {tenantId:s.tenantId,objectType:'FIELD_EVENT',objectId:event.eventId,action,actorType:'INTERFACE',actorId:event.source.edgeId,correlationId:event.eventId,metadata:metadata(event,exact,storage,status,reason,position)};});
 if(!initial.allowed){const p=await append('REJECTED',initial.reason,'FIELD_EVENT_REPLAY_DENIED');return {operations:p.operations,candidate:outcome(event,p.event,'REJECTED',initial.reason),fingerprint,replayed:false};}
 const receiptKey=fieldMapReceiptKeyV1(event),prior=await s.state('receipt',receiptKey);
 if(prior.present){const checked=await inspectFieldMapReceiptV1(s,prior.value,key,storage);need(canonicalEqual(checked.event,event),'FIELD_MAP_RECEIPT_INTEGRITY');return {operations:[] as StateOperation[],candidate:checked.candidate,fingerprint,replayed:true};}
 const oldEvent=await s.state('field_event',event.eventId),sequence=await s.state('field_sequence',fieldMapSequenceKeyV1(event)),read=await s.state('field_read',fieldMapReadKeyV1(event));
 for(const [kind,index]of [['EVENT',oldEvent],['SEQUENCE',sequence],['READ',read]] as const)if(index.present){
  const ref=index.value as {receiptKey:string;eventId:string};need(ref&&typeof ref.receiptKey==='string'&&typeof ref.eventId==='string'&&Object.keys(ref).sort().join(',')==='eventId,receiptKey','FIELD_MAP_CONFLICT_INDEX');const checked=await inspectFieldMapReceiptV1(s,await s.get('receipt',ref.receiptKey),key,storage),old=checked.event;
  need(ref.receiptKey===fieldMapReceiptKeyV1(old)&&ref.eventId===old.eventId&&BigInt(checked.auditPosition)<BigInt(position),'FIELD_MAP_CONFLICT_INDEX');
  if(kind==='EVENT')need(old.eventId===event.eventId,'FIELD_MAP_CONFLICT_INDEX');else{need(checked.receipt.status==='STORED'&&old.source.edgeId===event.source.edgeId&&old.streamId===event.streamId,'FIELD_MAP_CONFLICT_INDEX');if(kind==='SEQUENCE')need(old.sequenceNo===event.sequenceNo,'FIELD_MAP_CONFLICT_INDEX');else need(old.witness.readId===event.witness.readId&&old.sample.tagCode===event.sample.tagCode,'FIELD_MAP_CONFLICT_INDEX');}
 }
 const reason=oldEvent.present?'FIELD_EVENT_ID_CONFLICT':sequence.present?'FIELD_SEQUENCE_CONFLICT':read.present?'FIELD_READ_ID_CONFLICT':null,status=reason?'REJECTED' as const:'STORED' as const,p=await append(status,reason,'FIELD_EVENT_'+status),operations=[...p.operations],receipt=receiptBody(event,p.event,status,reason);
 operations.push(await s.operation('receipt',receiptKey,receipt));
 if(!oldEvent.present)operations.push(await s.operation('field_event',event.eventId,{eventId:event.eventId,receiptKey}));
 if(status==='STORED'){
  need(!(await s.state('blob',fieldMapPointKeyV1(event.eventId))).present,'FIELD_MAP_POINT_EXISTS');const deviceKey=fieldMapDeviceKeyV1(event.source.deviceCode),old=await s.state('field_point_head',deviceKey),h=old.value as {tenantId:string;deviceCode:string;count:string}|null;
  if(old.present)need(h?.tenantId===s.tenantId&&h.deviceCode===event.source.deviceCode&&/^[1-9][0-9]{0,18}$/.test(h.count),'FIELD_MAP_POINT_INDEX');const position=String(BigInt(h?.count??'0')+1n);need(BigInt(position)<=9223372036854775807n&&!(await s.state('field_point_order',fieldMapOrderKeyV1(event.source.deviceCode,position))).present,'FIELD_MAP_POINT_INDEX');
  operations.push(await s.operation('blob',fieldMapPointKeyV1(event.eventId),fieldMapPointBodyV1(event,p.event)),await s.operation('field_sequence',fieldMapSequenceKeyV1(event),{eventId:event.eventId,receiptKey}),await s.operation('field_read',fieldMapReadKeyV1(event),{eventId:event.eventId,receiptKey}),await s.operation('field_point_head',deviceKey,{tenantId:s.tenantId,deviceCode:event.source.deviceCode,count:position}),await s.operation('field_point_order',fieldMapOrderKeyV1(event.source.deviceCode,position),{tenantId:s.tenantId,deviceCode:event.source.deviceCode,position,eventId:event.eventId,receiptKey}));
 }
 return {operations,candidate:outcome(event,p.event,status,reason),fingerprint,replayed:false};
}
