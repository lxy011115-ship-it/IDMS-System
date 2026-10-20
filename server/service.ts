import {dataScope,ownTaskScope} from './data-scope.ts';
import type {ImportData} from './imports.ts';
import type {AccessContext} from './access.ts';
import { randomUUID, createHash } from "node:crypto";
import { appendAudit } from "./audit.ts";
import type { AiReview, Alarm } from "./domain.ts";
import type { Store } from "./store.ts";

export class DomainError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export interface CommandContext extends Omit<AccessContext,'actorType'> {actorType?:string}

export function reviewAlarm(store: Store, alarmId: string, ctx: CommandContext,data?:ImportData): Alarm {
  const alarm = store.alarms.find(a => a.id === alarmId && a.tenantId === ctx.tenantId);
  if (!alarm||!dataScope(data,{...ctx,actorType:ctx.actorType||'USER'},store).alarm(alarmId)) throw new DomainError(404, '报警不存在或不在授权范围');
  const before = structuredClone(alarm);
  const review: AiReview = {
    conclusion: alarm.severity === "CRITICAL" ? "高风险事件，必须转人工复核" : "历史模式与处置建议匹配",
    confidence: alarm.severity === "CRITICAL" ? 0.62 : 0.88,
    evidence: ["设备状态时间线", "同型号历史维修记录", "企业知识库"], anomalies: alarm.severity === "CRITICAL" ? ["风险等级过高"] : [],
    recommendedAction: "检查机械负载与润滑状态，完成维修后提交终审", risk: alarm.severity, modelVersion: "idms-review-1.0",
    status: alarm.severity === "CRITICAL" ? "HUMAN_REQUIRED" : "AUTO_REVIEWED"
  };
  alarm.aiReview = review;
  if (review.status === "AUTO_REVIEWED" && alarm.state === "REPAIRING") alarm.state = "AWAITING_APPROVAL";
  alarm.version++; alarm.updatedAt = new Date().toISOString();
  appendAudit(store, { tenantId: ctx.tenantId, objectType: "ALARM", objectId: alarm.id, action: "AI_REVIEWED", actorType: "AI", actorId: "ai.router", correlationId: ctx.correlationId, before, after: alarm, metadata: { modelVersion: review.modelVersion, confidence: review.confidence, evidence: review.evidence } });
  return alarm;
}

export function approveAlarm(store: Store, alarmId: string, decision: "APPROVED" | "REJECTED" | "RETURNED", comment: string, ctx: CommandContext,data?:ImportData): Alarm {
  const alarm = store.alarms.find(a => a.id === alarmId && a.tenantId === ctx.tenantId);
  if (!alarm||!dataScope(data,{...ctx,actorType:ctx.actorType||'USER'},store).alarm(alarmId)) throw new DomainError(404, '报警不存在或不在授权范围');
  if (alarm.state !== "AWAITING_APPROVAL") throw new DomainError(409, "仅待人工终审的报警可审批");
  if (!["APPROVED", "REJECTED", "RETURNED"].includes(decision)) throw new DomainError(400, '审批决定无效');
  if (alarm.assignee === ctx.actorId) throw new DomainError(403, '处置人员不得终审本人的报警');
  if (!comment.trim()) throw new DomainError(400, "审批意见不能为空");
  const before = structuredClone(alarm);
  const approval = { id: randomUUID(), tenantId: ctx.tenantId, objectType: "ALARM", objectId: alarm.id, decision, approver: ctx.actorId, comment, signature: createHash("sha256").update(`${ctx.actorId}:${alarm.id}:${decision}:${comment}`).digest("hex"), decidedAt: new Date().toISOString() };
  store.approvals.push(approval);
  alarm.state = decision === "APPROVED" ? "CLOSED" : decision === "RETURNED" ? "REPAIRING" : "ASSIGNED";
  alarm.version++; alarm.updatedAt = new Date().toISOString();
  appendAudit(store, { tenantId: ctx.tenantId, objectType: "ALARM", objectId: alarm.id, action: `HUMAN_${decision}`, actorType: "USER", actorId: ctx.actorId, correlationId: ctx.correlationId, before, after: alarm, metadata: { approvalId: approval.id, signature: approval.signature, comment } });
  return alarm;
}
