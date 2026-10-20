import type {StoreView} from './read-model.ts';
import { createHash } from "node:crypto";
import { appendAudit } from "./audit.ts";
import { canonical, digest } from "./imports.ts";
import { DomainError } from "./service.ts";
import type { Store } from "./store.ts";
import type { PredictiveContext } from "./predictive.ts";
import { requireAccess,scopeAllows } from './access.ts';
import {dataScope} from './data-scope.ts';
import type {ImportData,ImportView} from './imports.ts';
import {validateCustomFields} from './template-schema.ts';

export function orderFor(store: StoreView, id: string, ctx: PredictiveContext,data?:ImportView) {
  const order = store.workOrders.find(o => o.id === id && o.tenantId === ctx.tenantId);
  if (!order) throw new DomainError(404, "当前租户内工单不存在");
  if(!dataScope(data,ctx,store).order(order)) throw new DomainError(403,'工单不在当前账号授权范围内');
  return order;
}
function text(input: Record<string, unknown>, key: string) {
  if (typeof input[key] !== "string" || (input[key] as string).trim().length < 2 || (input[key] as string).length > 2000) throw new DomainError(400, `${key} 需要2–2000字`);
  return (input[key] as string).trim();
}
export function changeWorkOrder(store: Store, id: string, action: string, input: Record<string, unknown>, ctx: PredictiveContext,data?:ImportData) {
  if (ctx.actorType !== "USER") throw new DomainError(403, "维修和最终审核必须由用户执行");
  const order = orderFor(store, id, ctx,data);
  requireAccess(ctx, action === 'approval' ? 'maintenance:approve' : 'maintenance:execute');
  if (action !== 'approval' && action !== 'claim' && ctx.actorId !== order.assignee) throw new DomainError(403, "只有本工单负责人可执行维修");
  if (input.expectedVersion !== order.version) throw new DomainError(409, "工单版本已变化，请刷新");
  const before = structuredClone(order), now = new Date().toISOString();
  if (action === 'claim') {
    if (order.state !== 'UNASSIGNED' && !(ctx.authMode === 'oidc' && order.state === 'ASSIGNED' && order.assignee.startsWith('demo.'))) throw new DomainError(409, '该工单不可领取');
    order.assignee = ctx.actorId; order.state = 'ASSIGNED';
  } else if (action === "start") {
    if (order.state !== "ASSIGNED") throw new DomainError(409, "只有已派工工单可开始维修");
    order.state = "IN_PROGRESS";
  } else if (action === "submit") {
    if (order.state !== "IN_PROGRESS") throw new DomainError(409, "请先开始维修");
    const resolution = { failureCode: text(input, "failureCode"), cause: text(input, "cause"), action: text(input, "action"), verification: text(input, "verification"), minutes: input.minutes as number, partsUsed: input.partsUsed as string[], submittedBy: ctx.actorId, submittedAt: now };
    if (typeof resolution.minutes !== "number" || !Number.isFinite(resolution.minutes) || resolution.minutes <= 0 || resolution.minutes > 525600) throw new DomainError(400, "维修分钟数无效");
    if (!Array.isArray(resolution.partsUsed) || resolution.partsUsed.length > 50 || resolution.partsUsed.some(p => typeof p !== "string" || p.length > 200)) throw new DomainError(400, "备件清单无效");
    const customFields=validateCustomFields(order.templateBinding,input.customFields);
    const snapshot=customFields===undefined?resolution:{...resolution,customFields,templateDigest:order.templateBinding!.bindingDigest};
    order.resolution = { ...snapshot, digest: digest(canonical(snapshot)) };
    delete order.approval;
    order.state = "AWAITING_APPROVAL";
  } else if (action === "approval") {
    if (order.state !== "AWAITING_APPROVAL" || !order.resolution) throw new DomainError(409, "工单尚未提交验证证据");
    if (order.resolution.submittedBy === ctx.actorId || order.assignee === ctx.actorId) throw new DomainError(403, "维修执行者不得终审本人工单");
    if (!["APPROVED", "RETURNED"].includes(String(input.decision))) throw new DomainError(400, "审批决定无效");
    const { digest: snapshotDigest, ...resolution } = order.resolution;
    if (input.snapshotDigest !== snapshotDigest || snapshotDigest !== digest(canonical(resolution))) throw new DomainError(409, "维修证据摘要不一致");
    validateCustomFields(order.templateBinding,resolution.customFields);
    if(order.templateBinding&&resolution.templateDigest!==order.templateBinding.bindingDigest)throw new DomainError(409,'维修证据与模板绑定不一致');
    const comment = text(input, "comment"), decision = String(input.decision);
    const record = { objectId: order.id, version: order.version, snapshotDigest, approver: ctx.actorId, decision, comment, at: now };
    // Content digest binds the decision; identity assurance comes from the authentication provider, not this hash.
    order.approval = { decision, approver: ctx.actorId, comment, at: now, signature: createHash("sha256").update(canonical(record)).digest("hex") };
    order.state = decision === "APPROVED" ? "CLOSED" : "IN_PROGRESS";
    if (decision === "APPROVED") {
      const alert = store.predictiveAlerts.find(a => a.id === order.alertId && a.tenantId === ctx.tenantId);
      if (alert) { alert.state = "RESOLVED"; alert.version++; }
      const recommendation = store.maintenanceRecommendations.find(r => r.alertId === order.alertId && r.tenantId === ctx.tenantId);
      if (recommendation) recommendation.status = "EXECUTED";
    }
  } else throw new DomainError(404, "未知工单操作");
  order.version++; order.updatedAt = now;
  appendAudit(store, { tenantId: ctx.tenantId, objectType: "WORK_ORDER", objectId: order.id, action: `WORK_ORDER_${action.toUpperCase()}`, actorType: "USER", actorId: ctx.actorId, correlationId: ctx.correlationId, before, after: structuredClone(order), metadata: { modelVersion: order.modelVersion, resolutionDigest: order.resolution?.digest, decision: input.decision, comment: input.comment } });
  return order;
}
