import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seedStore } from "./store.ts";
import { approvePredictiveAlert } from "./predictive.ts";
import { changeWorkOrder } from "./maintenance.ts";
import { verifyAuditChain } from "./audit.ts";
import { DomainError } from "./service.ts";

const manager = { tenantId: "acme", actorId: "demo.approver", actorType: "USER", correlationId: randomUUID() };
const tech = { ...manager, actorId: "demo.technician" };
const evidence = { failureCode: "BEARING-WEAR", cause: "轴承滚道磨损", action: "更换轴承并调整润滑", verification: "同一负载复测振动3.1mm/s，设备负责人确认", minutes: 90, partsUsed: ["轴承6205"] };
const fails = (status: number) => (error: unknown) => error instanceof DomainError && error.status === status;
function setup() { const store = seedStore(); const alert = approvePredictiveAlert(store, "palert-001", "APPROVED", "核对现场数据", manager); return { store, alert, order: store.workOrders.find(o => o.id === alert.workOrderId)! }; }

test("real work order is created once and carries a model and alert reference", () => {
  const { store, order, alert } = setup();
  assert.equal(store.workOrders.length, 1); assert.equal(order.alertId, alert.id); assert.equal(order.modelVersion, alert.modelVersion);
  assert.throws(() => approvePredictiveAlert(store, alert.id, "APPROVED", "重复批准", manager), fails(409));
  assert.throws(() => approvePredictiveAlert(seedStore(), alert.id, "INVALID" as never, "无效决定", manager), fails(400));
});

test("repair evidence and independent final approval close the order and feedback the alert", () => {
  const { store, order, alert } = setup();
  changeWorkOrder(store, order.id, "start", { expectedVersion: 1 }, tech);
  changeWorkOrder(store, order.id, "submit", { ...evidence, expectedVersion: 2 }, tech);
  const frozen = structuredClone(order.resolution);
  assert.equal(order.state, "AWAITING_APPROVAL");
  assert.throws(() => changeWorkOrder(store, order.id, "approval", { expectedVersion: 3 }, tech), fails(403));
  assert.throws(() => changeWorkOrder(store, order.id, "approval", { expectedVersion: 3 }, { ...manager, actorType: "AI" }), fails(403));
  assert.throws(() => changeWorkOrder(store, order.id, "approval", { expectedVersion: 2 }, manager), fails(409));
  assert.throws(() => changeWorkOrder(store, order.id, "approval", { expectedVersion: 3, decision: "APPROVED", comment: "复测符合", snapshotDigest: "wrong" }, manager), fails(409));
  changeWorkOrder(store, order.id, "approval", { expectedVersion: 3, decision: "APPROVED", comment: "复测符合要求", snapshotDigest: order.resolution!.digest }, manager);
  assert.equal(order.state, "CLOSED"); assert.equal(alert.state, "RESOLVED"); assert.deepEqual(order.resolution, frozen);
  assert.equal(store.maintenanceRecommendations[0].status, "EXECUTED"); assert.equal(verifyAuditChain(store.audits, "acme"), true);
});

test("cross tenant, missing evidence and invalid repair minutes fail without mutation", () => {
  const { store, order } = setup();
  assert.throws(() => changeWorkOrder(store, order.id, "start", { expectedVersion: 1 }, { ...tech, tenantId: "sandbox" }), fails(404));
  assert.throws(() => changeWorkOrder(store, order.id, "approval", { expectedVersion: 1 }, manager), fails(409));
  changeWorkOrder(store, order.id, "start", { expectedVersion: 1 }, tech);
  const before = structuredClone(store);
  assert.throws(() => changeWorkOrder(store, order.id, "submit", { ...evidence, minutes: NaN, expectedVersion: 2 }, tech), fails(400));
  assert.deepEqual(store, before);
});

test("returned order requires new evidence and a new final decision", () => {
  const { store, order } = setup();
  changeWorkOrder(store, order.id, "start", { expectedVersion: 1 }, tech);
  changeWorkOrder(store, order.id, "submit", { ...evidence, expectedVersion: 2 }, tech);
  const oldDigest = order.resolution!.digest;
  changeWorkOrder(store, order.id, "approval", { expectedVersion: 3, decision: "RETURNED", comment: "补充全负载复测", snapshotDigest: oldDigest }, manager);
  assert.equal(order.state, "IN_PROGRESS");
  changeWorkOrder(store, order.id, "submit", { ...evidence, verification: "全负载连续运行一小时振动3.0mm/s", expectedVersion: 4 }, tech);
  assert.notEqual(order.resolution!.digest, oldDigest); assert.equal(order.approval, undefined);
  assert.equal(verifyAuditChain(store.audits, "acme"), true);
});
