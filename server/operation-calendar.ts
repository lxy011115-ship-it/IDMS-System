import {fieldPolicySchema} from './field-policy-schema.ts';
import {operationalPolicySchema} from './operational-policy-schema.ts';
import {sourcePolicySchema} from './source-policy-schema.ts';
import type {TemplateVersion,AuditEvent} from './domain.ts';
import type {Store} from './store.ts';
import type {ImportView} from './imports.ts';
import {canonical,digest} from './imports.ts';
import type {AccessContext} from './access.ts';
import {dataScope} from './data-scope.ts';
import {DomainError} from './service.ts';
import {operationCalendarSchema,calendarIdentity} from './calendar-schema.ts';
import {validateManifest} from './template-schema.ts';
import {calendarScheduleSchema} from './calendar-schedule-schema.ts';
import {dataQualityPolicySchema} from './quality-policy-schema.ts';

export const isOperationCalendar=(t:Pick<TemplateVersion,'manifest'>)=>t.manifest?.purpose==='operation-calendar';
export function calendarDeviceAccess(store:Pick<Store,'devices'>,data:ImportView|undefined,deviceCode:string,ctx:AccessContext){
 const view=dataScope(data,ctx,store as Store),asset=view.assets.get(deviceCode);
 if(!asset||!view.device(deviceCode))throw new DomainError(403,'日历设备不存在、未批准或不在当前授权范围');
}
export function calendarTemplateVisible(t:TemplateVersion,store:Pick<Store,'devices'>,data:ImportView|undefined,ctx:AccessContext){
 if(t.tenantId!==ctx.tenantId)return false;if(t.manifest.purpose==='field-channel-policy'){try{calendarDeviceAccess(store,data,fieldPolicySchema(t.manifest.fieldChannelPolicy).deviceCode,ctx);return true;}catch{return false;}}if(t.manifest.purpose==='telemetry-source-policy'){try{calendarDeviceAccess(store,data,sourcePolicySchema(t.manifest.telemetrySourcePolicy).deviceCode,ctx);return true;}catch{return false;}}if(!isOperationCalendar(t)&&t.manifest.purpose!=='calendar-schedule'&&t.manifest.purpose!=='data-quality-policy'&&t.manifest.purpose!=='operational-metric-policy')return true;
 try{const device=t.manifest.purpose==='operational-metric-policy'?operationalPolicySchema(t.manifest.operationalMetricPolicy).deviceCode:t.manifest.purpose==='data-quality-policy'?dataQualityPolicySchema(t.manifest.dataQualityPolicy).deviceCode:t.manifest.purpose==='calendar-schedule'?calendarScheduleSchema(t.manifest.calendarSchedule).deviceCode:operationCalendarSchema(t.manifest.operationCalendar).deviceCode;calendarDeviceAccess(store,data,device,ctx);return true;}catch{return false;}
}
export function calendarTemplateAccess(store:Pick<Store,'devices'|'templates'>,data:ImportView|undefined,manifest:Record<string,unknown>,ctx:AccessContext,templateKey?:string){
 if(manifest.purpose==='field-channel-policy'){const policy=fieldPolicySchema(manifest.fieldChannelPolicy);calendarDeviceAccess(store,data,policy.deviceCode,ctx);if(policy.entries.some(e=>e.admission&&e.admission.profile.source.tenantId!==ctx.tenantId))throw new DomainError(409,'现场公开配置不能跨企业');for(const t of store.templates.filter(t=>t.tenantId===ctx.tenantId&&t.manifest.purpose==='field-channel-policy')){const existing=fieldPolicySchema(t.manifest.fieldChannelPolicy);if(t.templateKey===templateKey&&(existing.edgeId!==policy.edgeId||existing.deviceCode!==policy.deviceCode)||t.templateKey!==templateKey&&existing.edgeId===policy.edgeId)throw new DomainError(409,'同一采集源仅限一个现场通道编码族，同族版本不能改绑采集源或设备');}return;}
 if(manifest.purpose==='telemetry-source-policy'){const policy=sourcePolicySchema(manifest.telemetrySourcePolicy);calendarDeviceAccess(store,data,policy.deviceCode,ctx);for(const t of store.templates.filter(t=>t.tenantId===ctx.tenantId&&t.manifest.purpose==='telemetry-source-policy')){const existing=sourcePolicySchema(t.manifest.telemetrySourcePolicy);if(t.templateKey===templateKey&&(existing.edgeId!==policy.edgeId||existing.deviceCode!==policy.deviceCode)||t.templateKey!==templateKey&&existing.edgeId===policy.edgeId)throw new DomainError(409,'同一采集源仅限一个治理编码族，同族版本不能改绑采集源或设备');}return;}
 if(manifest.purpose!=='operation-calendar'&&manifest.purpose!=='calendar-schedule'&&manifest.purpose!=='data-quality-policy'&&manifest.purpose!=='operational-metric-policy')return;
 const raw=(m:Record<string,unknown>)=>m.purpose==='operational-metric-policy'?m.operationalMetricPolicy:m.purpose==='data-quality-policy'?m.dataQualityPolicy:m.purpose==='calendar-schedule'?m.calendarSchedule:m.operationCalendar,deviceCode=calendarIdentity(raw(manifest));calendarDeviceAccess(store,data,deviceCode,ctx);
 if(store.templates.some(t=>t.tenantId===ctx.tenantId&&t.manifest.purpose===manifest.purpose&&((t.templateKey===templateKey&&calendarIdentity(raw(t.manifest))!==deviceCode)||(t.templateKey!==templateKey&&calendarIdentity(raw(t.manifest))===deviceCode))))throw new DomainError(409,manifest.purpose==='data-quality-policy'?'同设备同用途仅限一个编码族，同族版本不能改绑设备':'每台设备仅限一个日历编码族及一个生效安排编码族，同族版本不能改绑设备');
}
export function verifiedCalendar(item:TemplateVersion,anchor:AuditEvent|undefined){
 let calendar;try{const manifest=validateManifest(item.manifest);if(manifest.purpose!=='operation-calendar'||canonical(manifest)!==canonical(item.manifest)||item.parent||typeof item.publishedAt!=='string'||!Number.isFinite(Date.parse(item.publishedAt)))throw Error();calendar=manifest.operationCalendar;}catch{throw new DomainError(503,'日历发布内容不可验证');}
 const computed=digest(canonical({kind:'template',templateKey:item.templateKey,version:item.version,industry:item.industry,parent:item.parent||null,manifest:item.manifest}));
 if(!isOperationCalendar(item)||item.status!=='PUBLISHED'||!item.contentDigest||item.contentDigest!==computed||!anchor||anchor.tenantId!==item.tenantId||anchor.objectType!=='TEMPLATE'||anchor.objectId!==item.id||anchor.action!=='TEMPLATE_APPROVED'||canonical(anchor.after)!==canonical(item)||anchor.actorType!=='USER'||anchor.actorId!==item.publishedBy||!item.publishedBy||[item.createdBy,item.editedBy,item.submittedBy,...(item.contributors||[])].includes(item.publishedBy))throw new DomainError(503,'日历发布版与治理依据不可验证');
 return {calendar,source:{templateId:item.id,templateKey:item.templateKey,version:item.version,contentDigest:item.contentDigest,publishedAt:item.publishedAt!,governanceEventId:anchor.eventId,...(calendar.recurrence?{recurrence:{...calendar.expansion!,weeklyRules:calendar.recurrence.weekly.length,dateExceptions:calendar.recurrence.exceptions.length}}:{})}};
}
export function calendarFor(templates:readonly TemplateVersion[],tenant:string,device:string,anchor:(id:string)=>AuditEvent|undefined){
 const selected=templates.filter(t=>t.tenantId===tenant&&isOperationCalendar(t)&&t.status==='PUBLISHED'&&(t.manifest.operationCalendar as {deviceCode?:unknown})?.deviceCode===device);
 if(selected.length>1)throw new DomainError(503,'设备存在多个日历发布版，不能推断有效日历');
 return selected.length?verifiedCalendar(selected[0],anchor(selected[0].id)):null;
}



