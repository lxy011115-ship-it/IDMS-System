import test from "node:test";
import assert from "node:assert/strict";
import { verifyAuditChain } from "./audit.ts";
import { approvePredictiveAlert, predictiveOverview } from "./predictive.ts";
import { DomainError } from "./service.ts";
import { seedStore } from "./store.ts";

const base = { tenantId: "acme", actorId: "demo.approver", actorType: "USER", correlationId: "predictive-test" };

test("predictive overview is tenant scoped and preserves model evidence", () => {
  const store = seedStore();
  const result = predictiveOverview(store, "acme");
  assert.equal(result.metrics.monitoredDevices, 3);
  assert.equal(result.alerts[0].modelVersion, "cnc-spindle-health-0.3.0");
  assert.equal(predictiveOverview(store, "sandbox").alerts.length, 0);
});

test("only the final approver can create a predictive work order", () => {
  const store = seedStore();
  assert.throws(() => approvePredictiveAlert(store, "palert-001", "APPROVED", "x", { ...base, actorId: "demo.uploader" }), (error: unknown) => error instanceof DomainError && error.status === 403);
  const alert = approvePredictiveAlert(store, "palert-001", "APPROVED", "已核对趋势并同意生成工单", base);
  assert.equal(alert.state, "WORK_ORDER_CREATED");
  assert.equal(store.maintenanceRecommendations[0].status, "APPROVED");
  assert.equal(verifyAuditChain(store.audits, "acme"), true);
});

test("predictive approval rejects a second decision", () => {
  const store = seedStore();
  approvePredictiveAlert(store, "palert-001", "RETURNED", "证据不足，退回现场复核", base);
  assert.throws(() => approvePredictiveAlert(store, "palert-001", "APPROVED", "再次批准", base), (error: unknown) => error instanceof DomainError && error.status === 409);
});
