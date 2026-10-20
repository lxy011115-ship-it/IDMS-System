import {scopeAllows,scopeFilter,requiredScope,type AccessContext} from './access.ts';
import {effectiveRecords} from './import-revisions.ts';
import type {BatchBody,ImportView,Row,StoredRow} from './imports.ts';
import type {StoreView} from './read-model.ts';
import type {AuditEvent,WorkOrder} from './domain.ts';

export function hasRestrictedScope(ctx:AccessContext){return Object.values(scopeFilter(ctx)).some(v=>v!==null);}
export function ownTaskScope(ctx:AccessContext){return ctx.authMode==='oidc'&&requiredScope(ctx.roles||[])==='OWN_TASKS';}
export function dataScope(data:ImportView|undefined,ctx:AccessContext,store?:StoreView){
 const records=data?effectiveRecords(data).filter(r=>r.tenantId===ctx.tenantId):[];
 const assets=new Map(records.filter(r=>r.dataType==='DEVICE').map(r=>[String(r.value.device_code),r.value]));
 const unrestricted=!hasRestrictedScope(ctx);
 const device=(code:string)=>{
  const asset=assets.get(code),legacy=store?.devices.find(d=>d.tenantId===ctx.tenantId&&d.code===code);
  return scopeAllows(ctx,asset||{device_code:code,line_code:legacy?.line});
 };
 const row=(r:StoredRow)=>r.tenantId===ctx.tenantId&&(r.dataType==='DEVICE'?scopeAllows(ctx,r.value):device(String(r.value.device_code)));
 const batch=(b:BatchBody)=>{
  if(b.tenantId!==ctx.tenantId)return false;if(unrestricted)return true;
  if(!b.rows.length)return false;
  // An original file is indivisible: never reveal a mixed-scope file or its derived summary.
  return b.rows.every(value=>b.dataType==='DEVICE'?scopeAllows(ctx,value):device(String(value.device_code||'')))&&(!b.correction||b.correction.baseRows.every(r=>b.dataType==='DEVICE'?scopeAllows(ctx,r.before):device(String(r.before.device_code||''))));
 };
 const order=(o:WorkOrder)=>o.tenantId===ctx.tenantId&&device(o.deviceCode)&&(!ownTaskScope(ctx)||o.assignee===ctx.actorId);
 const alarm=(id:string)=>{const a=store?.alarms.find(a=>a.tenantId===ctx.tenantId&&a.id===id),d=store?.devices.find(d=>d.tenantId===ctx.tenantId&&d.id===a?.deviceId);return !!d&&device(d.code)&&(!ownTaskScope(ctx)||a?.assignee===ctx.actorId);};
 const audit=(event:AuditEvent)=>{
  if(event.tenantId!==ctx.tenantId)return false;if(unrestricted&&!ownTaskScope(ctx))return true;
  if(event.objectType==='DATA_IMPORT'){const b=data?.batches.find(b=>b.batchId===event.objectId&&b.tenantId===ctx.tenantId);return !!b&&batch(b);}
  if(event.objectType==='WORK_ORDER'){const o=store?.workOrders.find(o=>o.id===event.objectId&&o.tenantId===ctx.tenantId);return !!o&&order(o);}
  if(event.objectType==='ALARM')return alarm(event.objectId);
  if(event.objectType==='PREDICTIVE_ALERT'){const a=store?.predictiveAlerts.find(a=>a.id===event.objectId&&a.tenantId===ctx.tenantId);return !!a&&device(a.deviceCode);}
  if(event.objectType==='HEALTH_SNAPSHOT'){const h=store?.healthSnapshots.find(h=>h.id===event.objectId&&h.tenantId===ctx.tenantId);return !!h&&device(h.deviceCode);}
  if(event.objectType==='PREDICTIVE_REVIEW')return device(event.objectId);
  if(event.objectType==='TELEMETRY_EVENT')return typeof event.metadata.deviceCode==='string'&&device(event.metadata.deviceCode);
  return event.objectType==='AUTHENTICATION'&&event.actorId===ctx.actorId;
 };
 return {device,row,batch,order,alarm,audit,records,assets,unrestricted};
}
