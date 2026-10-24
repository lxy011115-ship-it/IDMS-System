import {createHash,randomUUID} from 'node:crypto';
import {stable} from '../integrations/telemetry.ts';
import {auditPositionKey,verifyLocalDomainAudit,type DomainAuditHead} from './telemetry-map-v4.ts';
import {domainMapAssert as need,type DomainMapSnapshot} from './domain-map-v4.ts';
import type {AuditEvent} from './domain.ts';
export type FieldMapSnapshotV1=Pick<DomainMapSnapshot,'tenantId'|'head'|'state'|'get'|'operation'>;
type Input=Omit<AuditEvent,'eventId'|'businessTime'|'previousHash'|'hash'>;
export async function fieldMapAuditPlanV1(s:FieldMapSnapshotV1,build:(businessTime:string)=>Input|Promise<Input>){
 const head=await s.get<DomainAuditHead>('domain_head','audit');need(head.tenantId===s.tenantId&&/^(0|[1-9][0-9]{0,18})$/.test(head.count),'FIELD_MAP_AUDIT_HEAD');const n=BigInt(head.count);need(n<9223372036854775807n,'FIELD_MAP_AUDIT_LIMIT');let previous:AuditEvent|undefined;
 if(n===0n)need(head.eventId===null&&head.hash==='GENESIS','FIELD_MAP_AUDIT_HEAD');else{
  need(typeof head.eventId==='string');previous=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',head.eventId),s.tenantId);const order=await s.get<{tenantId:string;position:string;eventId:string}>('audit_order',auditPositionKey(head.count));need(previous.hash===head.hash&&order.tenantId===s.tenantId&&order.position===head.count&&order.eventId===head.eventId,'FIELD_MAP_AUDIT_HEAD');
 }
 // Same captured clock and hash format as appendClockBoundAudit; the same-root
 // decision builder may perform bounded SQL reads before the event is frozen.
 const businessTime=new Date().toISOString(),input=await build(businessTime);need(input.tenantId===s.tenantId,'FIELD_MAP_AUDIT_TENANT');const base={...structuredClone(input),eventId:randomUUID(),businessTime,previousHash:previous?.hash??'GENESIS'},event=JSON.parse(JSON.stringify({...base,hash:createHash('sha256').update(base.previousHash+stable(base)).digest('hex')})) as AuditEvent,position=String(n+1n);verifyLocalDomainAudit(event,s.tenantId);need(!(await s.state('audit',event.eventId)).present&&!(await s.state('audit_order',auditPositionKey(position))).present,'FIELD_MAP_AUDIT_EXISTS');
 const operations=[await s.operation('audit',event.eventId,event),await s.operation('audit_order',auditPositionKey(position),{tenantId:s.tenantId,position,eventId:event.eventId}),await s.operation('domain_head','audit',{tenantId:s.tenantId,count:position,eventId:event.eventId,hash:event.hash})];return {event,operations};
}
