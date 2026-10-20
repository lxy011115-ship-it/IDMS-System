import {appendAudit} from './audit.ts';
import {domainEntityKey} from './domain-entities-v4.ts';
import {decodeLegacyText,encodeLegacyText,legacyJsonText} from './legacy-map-v4.ts';
import {DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import {telemetryDomainFormat,auditPositionKey,verifyLocalDomainAudit,type DomainAuditHead,type TelemetryDomainControl} from './telemetry-map-v4.ts';
import {readAssetKey,readCatalogFormat,type DomainReadCatalogV4,type DomainReadAssetV4} from './domain-read-catalog-v4.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {scopeAllows,requiredScope,type AccessContext} from './access.ts';
import type {Store} from './store.ts';
import type {WorkOrder,AuditEvent} from './domain.ts';
import {DomainError} from './service.ts';
import type {StateOperation} from './state-map-v1.ts';
export const maintenanceFormatV4='IDMS_MAINTENANCE_MAP_V4_1';
export const maintenanceFailV4=(status:number,code:string):never=>{throw new DomainError(status,code);};
export const maintenanceWireV4=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
export async function maintenanceEntityV4<T=any>(s:DomainMapSnapshot,collection:string,id:string,optional=false):Promise<T|null>{
 const key=domainEntityKey(collection,{id}),p=await s.state('v4_entity',key);if(!p.present){if(optional)return null;maintenanceFailV4(404,'MAINTENANCE_NOT_FOUND');}
 const value=JSON.parse(await decodeLegacyText('v4_entity',key,(ns,k)=>s.get(ns,k)));need(value.id===id&&(collection==='business/tenants'?value.id===s.tenantId:value.tenantId===s.tenantId),'MAINTENANCE_ENTITY_BINDING');return value;
}
export async function maintenanceWriteEntityV4(s:DomainMapSnapshot,collection:string,row:{id:string;tenantId?:string}){
 need(collection==='business/tenants'?row.id===s.tenantId:row.tenantId===s.tenantId);const key=domainEntityKey(collection,row),ops:StateOperation[]=[];
 for(const e of encodeLegacyText('v4_entity',key,legacyJsonText(maintenanceWireV4(row)))){const old=await s.state(e.namespace,e.key);ops.push({...e,expected:old.valueHash});}return ops;
}
export async function maintenanceMetadataV4(s:DomainMapSnapshot,ctx?:AccessContext){
 if(ctx){domainReadAccessV4(ctx);if(ctx.tenantId!==s.tenantId)maintenanceFailV4(404,'MAINTENANCE_NOT_FOUND');}
 const c=await s.get<TelemetryDomainControl>('domain_head','control');need(c.format===telemetryDomainFormat&&c.tenantId===s.tenantId,'MAINTENANCE_CONTROL');if(c.status!=='ACTIVE')maintenanceFailV4(409,'MAINTENANCE_FENCED');
 const tenant=await maintenanceEntityV4(s,'business/tenants',s.tenantId);if(tenant.status!=='ACTIVE')maintenanceFailV4(403,'MAINTENANCE_TENANT_INACTIVE');
 const marker=await s.get<any>('domain_head','maintenance');need(marker.format===maintenanceFormatV4&&marker.tenantId===s.tenantId,'MAINTENANCE_NOT_ACTIVATED');
 const catalog=await s.get<DomainReadCatalogV4>('domain_head','read_catalog');need(catalog.format===readCatalogFormat&&catalog.tenantId===s.tenantId&&catalog.governanceAnchorDigest===c.governanceAnchorDigest,'MAINTENANCE_READ_ANCHOR');return catalog;
}
export async function maintenanceOrderScopeV4(s:DomainMapSnapshot,ctx:AccessContext,order:WorkOrder,catalog:DomainReadCatalogV4){
 need(order.tenantId===ctx.tenantId&&Number.isSafeInteger(order.version)&&order.version>0,'MAINTENANCE_ORDER_BINDING');
 const key=readAssetKey(catalog.generation,order.deviceCode),value=await s.state('blob',key);let scope:Record<string,unknown>={device_code:order.deviceCode};
 if(value.present){const asset=JSON.parse(await decodeLegacyText('blob',key,(ns,k)=>s.get(ns,k))) as DomainReadAssetV4;need(asset.tenantId===ctx.tenantId&&asset.deviceCode===order.deviceCode&&asset.scope.device_code===order.deviceCode,'MAINTENANCE_ASSET_BINDING');scope=asset.scope;}
 if(!scopeAllows(ctx,scope)||requiredScope(ctx.roles||[])==='OWN_TASKS'&&order.assignee!==ctx.actorId)maintenanceFailV4(403,'MAINTENANCE_SCOPE_DENIED');
}
export async function maintenanceAuditTipV4(s:DomainMapSnapshot){
 const head=await s.get<DomainAuditHead>('domain_head','audit');need(head.tenantId===s.tenantId&&/^(0|[1-9][0-9]{0,18})$/.test(head.count)&&BigInt(head.count)<9223372036854775807n,'MAINTENANCE_AUDIT_HEAD');let event:AuditEvent|undefined;
 if(head.count==='0')need(head.eventId===null&&head.hash==='GENESIS');else{need(typeof head.eventId==='string');event=verifyLocalDomainAudit(await s.get<AuditEvent>('audit',head.eventId),s.tenantId);const order=await s.get<any>('audit_order',auditPositionKey(head.count));need(order.tenantId===s.tenantId&&order.position===head.count&&order.eventId===event.eventId&&event.hash===head.hash,'MAINTENANCE_AUDIT_TIP');}return {head,event};
}
export async function maintenanceAuditOpsV4(s:DomainMapSnapshot,event:AuditEvent,head:DomainAuditHead){
 event=maintenanceWireV4(event);verifyLocalDomainAudit(event,s.tenantId);need(event.previousHash===head.hash);const position=String(BigInt(head.count)+1n);need(!(await s.state('audit',event.eventId)).present&&!(await s.state('audit_order',auditPositionKey(position))).present,'MAINTENANCE_AUDIT_POSITION');
 return {position,event,ops:[await s.operation('audit',event.eventId,event),await s.operation('audit_order',auditPositionKey(position),{tenantId:s.tenantId,position,eventId:event.eventId}),await s.operation('domain_head','audit',{tenantId:s.tenantId,count:position,eventId:event.eventId,hash:event.hash})]};
}
export function maintenanceAppendV4(previous:AuditEvent|undefined,input:Parameters<typeof appendAudit>[1]){return maintenanceWireV4(appendAudit({audits:previous?[previous]:[]} as Store,input));}
