import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {maintenanceFormatV4} from './maintenance-map-common-v4.ts';
import {DomainError} from './service.ts';
export function compileMaintenanceLinksV4(payload:TenantPayload,tenantId:string){
 validateTenantPayload(payload,tenantId);
 return payload.business.workOrders.map(o=>{
  if(o.workflow&&o.workflow.status!=='SYNCED')throw new DomainError(409,'MAINTENANCE_LEGACY_OUTBOX_UNRESOLVED');
  const recommendation=payload.business.maintenanceRecommendations.find(r=>r.tenantId===tenantId&&r.alertId===o.alertId);
  return {format:maintenanceFormatV4,tenantId,orderId:o.id,alertId:o.alertId,deviceId:o.deviceId,deviceCode:o.deviceCode,recommendationId:recommendation?.id||null};
 });
}
export type MaintenanceLinkV4=ReturnType<typeof compileMaintenanceLinksV4>[number];
