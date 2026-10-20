import test from "node:test";
import assert from "node:assert/strict";
import { verifyAuditChain } from "./audit.ts";
import { approveAlarm, DomainError, reviewAlarm } from "./service.ts";
import { seedStore } from "./store.ts";

const ctx = { tenantId: "acme", actorId: "qa.manager", correlationId: "test-1" };
test("AI review records a verifiable audit event", () => {
  const store = seedStore(); const alarm = reviewAlarm(store, "alm-2411", ctx);
  assert.equal(alarm.aiReview?.status, "HUMAN_REQUIRED");
  assert.equal(alarm.state, "REPAIRING");
  assert.equal(verifyAuditChain(store.audits, "acme"), true);
});
test("critical human-required review cannot close an alarm", () => {
  const store = seedStore(); reviewAlarm(store, "alm-2411", ctx);
  assert.throws(() => approveAlarm(store, "alm-2411", "APPROVED", "approve", ctx), (e: unknown) => e instanceof DomainError && e.status === 409);
});
test("human approval closes only an awaiting-approval alarm", () => {
  const store = seedStore(); const alarm = approveAlarm(store, "alm-2408", "APPROVED", "复测通过，同意关单", ctx);
  assert.equal(alarm.state, "CLOSED"); assert.equal(store.approvals.length, 1); assert.equal(store.audits[0].actorType, "USER");
});
test("tenant isolation prevents cross-tenant access", () => {
  const store = seedStore(); assert.throws(() => approveAlarm(store, "alm-2408", "APPROVED", "x", { ...ctx, tenantId: "sandbox" }), (e: unknown) => e instanceof DomainError && e.status === 404);
});
