import type {StoreView} from './read-model.ts';
import {dataScope} from './data-scope.ts';
import type {ImportData,ImportView} from './imports.ts';
import { appendAudit } from "./audit.ts";
import { randomUUID } from "node:crypto";
import { DomainError } from "./service.ts";
import type { PredictiveAlert } from "./domain.ts";
import type { Store } from "./store.ts";
import { requireAccess,scopeAllows, type AccessContext } from './access.ts';
import {bindMaintenanceTemplate} from './catalog.ts';

export interface PredictiveContext extends AccessContext {}

function scoped<T extends { tenantId: string }>(items: T[], tenantId: string) { return items.filter(item => item.tenantId === tenantId); }

export function predictiveOverview(store: StoreView, tenantId: string, ctx?: AccessContext,data?:ImportView) {
  const view=ctx?dataScope(data,ctx,store):null,visible=(deviceCode:string)=>!view||view.device(deviceCode);
  const history = scoped(store.healthSnapshots, tenantId);
  const health = [...new Map(history.filter(h=>visible(h.deviceCode)).map(h => [h.deviceCode, h])).values()];
  const alerts = scoped(store.predictiveAlerts, tenantId).filter(a=>visible(a.deviceCode));
  const recommendations = scoped(store.maintenanceRecommendations, tenantId).filter(r=>visible(store.predictiveAlerts.find(a=>a.id===r.alertId)?.deviceCode||''));
  const models = scoped(store.predictiveModels, tenantId);
  return {
    generatedAt: new Date().toISOString(),
    mode: "engineering-rules-development",
    disclaimer: "预置样例、上传和模拟采集分析均非生产预测承诺。工程阈值未经现场验证；不输出RUL或未经标定的故障概率。",
    metrics: {
      monitoredDevices: health.length,
      healthy: health.filter(item => item.band === "HEALTHY").length,
      watch: health.filter(item => item.band === "WATCH").length,
      risk: health.filter(item => item.band === "RISK" || item.band === "CRITICAL").length,
      pendingApproval: alerts.filter(item => item.state === "AWAITING_APPROVAL").length,
      activeModels: models.filter(item => item.status === "ACTIVE").length
    },
    health,
    alerts,
    recommendations,
    workOrders: scoped(store.workOrders, tenantId).filter(w=>visible(w.deviceCode)&&(!view||view.order(w))),
    models
  };
}

export function approvePredictiveAlert(store: Store, alertId: string, decision: "APPROVED" | "RETURNED", comment: string, ctx: PredictiveContext,data?:ImportData): PredictiveAlert {
  requireAccess(ctx, 'predictive:approve');
  if (comment.trim().length < 2) throw new DomainError(400, "请填写人工复核意见");
  if (!["APPROVED", "RETURNED"].includes(decision)) throw new DomainError(400, "审批决定无效");
  if (comment.length > 2000) throw new DomainError(400, "审批意见过长");
  const alert = store.predictiveAlerts.find(item => item.id === alertId && item.tenantId === ctx.tenantId);
  if (!alert) throw new DomainError(404, "预测告警不存在");
  if(!dataScope(data,ctx,store).device(alert.deviceCode)) throw new DomainError(403,'预测告警不在当前账号授权范围内');
  if (alert.state !== "AWAITING_APPROVAL") throw new DomainError(409, "预测告警不在待终审状态");
  const before = structuredClone(alert);
  if (decision === "APPROVED") {
    const rec = store.maintenanceRecommendations.find(item => item.alertId === alert.id && item.tenantId === ctx.tenantId);
    if (!rec) throw new DomainError(409, "缺少维护建议，不能创建工单");
    const timestamp = new Date().toISOString();
    const order = { id: randomUUID(), tenantId: ctx.tenantId, alertId: alert.id, deviceId: alert.deviceId, deviceCode: alert.deviceCode, title: alert.title, state: ctx.authMode === 'oidc' ? 'UNASSIGNED' as const : 'ASSIGNED' as const, assignee: ctx.authMode === 'oidc' ? '' : 'demo.technician', createdBy: ctx.actorId, createdAt: timestamp, updatedAt: timestamp, version: 1, modelVersion: alert.modelVersion, recommendation: rec.action, parts: [...rec.parts] };
    const binding=bindMaintenanceTemplate(store,ctx.tenantId);
    if(binding)Object.assign(order,{templateBinding:binding});
    store.workOrders.push(order);
    alert.workOrderId = order.id;
    alert.state = "WORK_ORDER_CREATED";
    alert.approvedBy = ctx.actorId;
    alert.approvalComment = comment.trim();
    alert.approvedAt = new Date().toISOString();
    rec.status = "APPROVED";
    appendAudit(store, { tenantId: ctx.tenantId, objectType: "WORK_ORDER", objectId: order.id, action: "WORK_ORDER_CREATED", actorType: "USER", actorId: ctx.actorId, correlationId: ctx.correlationId, after: structuredClone(order), metadata: { alertId: alert.id, modelVersion: alert.modelVersion } });
  } else {
    alert.state = "DISMISSED";
    alert.approvedBy = ctx.actorId;
    alert.approvalComment = comment.trim();
    alert.approvedAt = new Date().toISOString();
  }
  alert.version++;
  appendAudit(store, { tenantId: ctx.tenantId, objectType: "PREDICTIVE_ALERT", objectId: alert.id, action: decision === "APPROVED" ? "PREDICTIVE_ALERT_APPROVED" : "PREDICTIVE_ALERT_RETURNED", actorType: "USER", actorId: ctx.actorId, correlationId: ctx.correlationId, before, after: structuredClone(alert), metadata: { decision, comment: comment.trim(), modelVersion: alert.modelVersion } });
  return alert;
}
