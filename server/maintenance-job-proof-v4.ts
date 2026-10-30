import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {MaintenanceQueueJobV4} from './maintenance-job-store-v4.ts';
import {DomainReadSnapshotV4} from './domain-read-snapshot-v4.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {maintenanceFormatV4} from './maintenance-map-common-v4.ts';
import {canonicalEqual} from './canonical-state.ts';
import {auditPositionKey,verifyLocalDomainAudit} from './telemetry-map-v4.ts';
/** A terminal queue flag alone is not proof of a business completion. */
export async function verifyMaintenanceCompletionV4(account:ClientConfig,binding:StateMapBinding,job:MaintenanceQueueJobV4){
 if(job.status!=='COMMITTED')return null;const s=await DomainReadSnapshotV4.open(account,binding);try{
  const r=await s.get<any>('receipt','maintenance:'+job.businessKey);need(r.format===maintenanceFormatV4&&r.requestHash===job.requestHash&&r.result?.id===r.orderId&&canonicalEqual(r.result,job.result),'MAINTENANCE_COMPLETION_RECEIPT');
  const a=verifyLocalDomainAudit(await s.get<any>('audit',r.auditEventId),job.tenantId),p=await s.get<any>('audit_order',auditPositionKey(r.auditPosition));need(a.objectType==='WORK_ORDER'&&a.objectId===r.orderId&&a.actorId===job.actorId&&a.hash===r.auditHash&&p.tenantId===job.tenantId&&p.position===r.auditPosition&&p.eventId===a.eventId,'MAINTENANCE_COMPLETION_AUDIT');return {result:r.result,auditEventId:a.eventId,auditHash:a.hash};
 }finally{await s.close();}
}
