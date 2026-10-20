import {calendarTemplateAccess,calendarTemplateVisible} from './operation-calendar.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {dataScope} from './data-scope.ts';
import type {ImportData} from './imports.ts';
import type {Store} from './store.ts';
import {DomainError} from './service.ts';

// Authorization must run before reading an idempotent receipt as well as before a new mutation.
export function commandAccess(path:string,method:string,input:Record<string,unknown>,ctx:AccessContext,data:ImportData,store:Store,telemetrySources:{edgeId:string;tenantId:string;deviceCode:string}[]=[]){
 if(method!=='POST')throw new DomainError(404,'写接口不存在');const view=dataScope(data,ctx,store);
 const permission=(p:string)=>requireAccess(ctx,p),device=(code:unknown)=>{if(typeof code!=='string'||!view.device(code)||(!view.assets.has(code)&&!store.devices.some(d=>d.tenantId===ctx.tenantId&&d.code===code)))throw new DomainError(403,'设备不在当前授权范围');};
 if(path==='/api/v1/equipment-profiles/points'){permission('upload');device(input.deviceCode);return;}
 if(path==='/api/v1/predictive/analyze'){permission('analyze');device(input.deviceCode);return;}
 if(path==='/api/v1/telemetry/analyze'){permission('analyze');const s=telemetrySources.find(s=>s.tenantId===ctx.tenantId&&s.edgeId===input.edgeId);if(!s)throw new DomainError(404,'采集源不存在');if(!view.device(s.deviceCode))throw new DomainError(403,'设备不在当前授权范围');return;}
 const alarm=/^\/api\/v1\/alarms\/([^/]+)\/(ai-review|approval)$/.exec(path);
 if(alarm){permission(alarm[2]==='approval'?'alarm:approve':'alarm:review');if(!view.alarm(alarm[1]))throw new DomainError(404,'报警不存在或不在授权范围');return;}
 const prediction=/^\/api\/v1\/predictive\/alerts\/([^/]+)\/approval$/.exec(path);
 if(prediction){permission('predictive:approve');const a=store.predictiveAlerts.find(a=>a.id===prediction[1]&&a.tenantId===ctx.tenantId);if(!a||!view.device(a.deviceCode))throw new DomainError(404,'预测告警不存在');return;}
 const order=/^\/api\/v1\/work-orders\/([^/]+)\/(claim|start|submit|approval|workflow\/retry)$/.exec(path);
 if(order){permission(['approval','workflow/retry'].includes(order[2])?'maintenance:approve':'maintenance:execute');const o=store.workOrders.find(o=>o.id===order[1]&&o.tenantId===ctx.tenantId);if(!o)throw new DomainError(404,'工单不存在');if(!view.order(o))throw new DomainError(403,'工单不在当前授权范围');return;}
 if(path==='/api/v1/templates'||path==='/api/v1/templates/import'){permission('template:edit');const raw=path.endsWith('/import')?input.content:input;if(raw&&typeof raw==='object'){const v=raw as Record<string,unknown>;if(v.manifest&&typeof v.manifest==='object')calendarTemplateAccess(store,data,v.manifest as Record<string,unknown>,ctx,typeof v.templateKey==='string'?v.templateKey:undefined);}return;}
 const template=/^\/api\/v1\/templates\/([^/]+)\/(edit|submit|approval)$/.exec(path);
 if(template){permission(template[2]==='edit'?'template:edit':template[2]==='submit'?'template:submit':'template:publish');const t=store.templates.find(t=>t.tenantId===ctx.tenantId&&t.id===template[1]);if(!t||!calendarTemplateVisible(t,store,data,ctx))throw new DomainError(404,'模板不存在');calendarTemplateAccess(store,data,t.manifest,ctx,t.templateKey);if(input.manifest&&typeof input.manifest==='object')calendarTemplateAccess(store,data,input.manifest as Record<string,unknown>,ctx,t.templateKey);return;}
 if(path==='/api/v1/plugins'){permission('plugin:submit');return;}
 const plugin=/^\/api\/v1\/plugins\/([^/]+)\/(certify|activate)$/.exec(path);
 if(plugin){permission(plugin[2]==='certify'?'plugin:certify':'plugin:activate');if(!store.plugins.some(p=>p.tenantId===ctx.tenantId&&p.id===plugin[1]))throw new DomainError(404,'插件不存在');return;}
 if(path==='/api/v1/demo/reset'){permission('approve');return;}
 throw new DomainError(404,'写接口不存在');
}
