import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeSpool } from '../services/edge/spool.ts';
import { BusinessAckFlow, businessAckFlowOptions } from '../services/edge/business-ack-flow.ts';
import { signAck, sha, type EdgeSource, type TelemetryEvent } from '../integrations/telemetry.ts';

const source: EdgeSource = { tenantId: 'sandbox', edgeId: 'qa-flow', deviceCode: 'SIM-01', origin: 'SIMULATOR', mapVersion: '1',
  signingKey: 's'.repeat(64), acknowledgementKey: 'a'.repeat(64), statusKey: 'h'.repeat(64), statusUrl: 'http://127.0.0.1:4014/status',
  points: [{ tagCode: 'vibration_rms', nodeId: 'ns=1;s=vibration_rms', unit: 'mm/s' }] };
const options = { version: 1 as const, window: 1, ackTimeoutMs: 5000, maxRetryMs: 20000 };
const sample = { tagCode: 'vibration_rms', nodeId: 'ns=1;s=vibration_rms', unit: 'mm/s', value: 2, quality: 'GOOD' as const, eventTime: '2026-10-18T00:00:00.000Z' };
const ack = (event: TelemetryEvent, patch = {}, key = source.acknowledgementKey) => signAck({ version: 1, eventId: event.eventId,
  edgeId: source.edgeId, tenantId: source.tenantId, digest: sha(event), status: 'STORED', ...patch }, key);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'idms-legacy-flow-')), file = join(directory, 'spool.sqlite');
  let spool = new EdgeSpool(file, source, 20), now = 1000, wall = Date.now();
  const payloads: string[] = [], callbacks: ((error?: Error | null) => void)[] = [];
  const publish = (payload: string, done: (error?: Error | null) => void) => { payloads.push(payload); callbacks.push(done); };
  const make = (overrides = {}) => new BusinessAckFlow(spool, publish, { ...options, ...overrides }, () => now, () => wall);
  return { file, payloads, callbacks, make, get spool() { return spool; },
    advance(ms: number) { now += ms; wall += ms; }, wallBack(ms: number) { wall -= ms; },
    restart() { spool.close(); spool = new EdgeSpool(file, source, 20); },
    close() { spool.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('legacy business flow rejects ambiguous/unbounded options', () => {
  for (const bad of [null, [], {}, { ...options, version: 2 }, { ...options, extra: true }, { ...options, window: 0 },
    { ...options, window: 9 }, { ...options, window: 1.1 }, { ...options, ackTimeoutMs: 4999 },
    { ...options, ackTimeoutMs: '5000' }, { ...options, maxRetryMs: 4999 }, { ...options, maxRetryMs: 900001 }]) assert.throws(() => businessAckFlowOptions(bad), /CONFIG/);
  assert.deepEqual(businessAckFlowOptions(options), options);
});
test('PUBACK and invalid business ACKs never release the window or pending data', () => {
  const f = fixture(); try {
    const event = f.spool.append(sample); f.spool.append(sample); const flow = f.make();
    flow.tick(true); f.callbacks[0]();
    for (let i = 0; i < 4; i++) { f.advance(1000); flow.tick(true); }
    assert.equal(f.payloads.length, 1); assert.equal(f.spool.stats().pending, 2);
    for (const bad of [ack(event, {}, 'wrong'), ack(event, { digest: '0'.repeat(64) }), ack(event, { tenantId: 'acme' }), ack(event, { edgeId: 'another' }), ack(event, { status: 'UNKNOWN' })]) assert.equal(flow.acknowledge(bad), false);
    flow.tick(true); assert.equal(f.payloads.length, 1);
    assert.equal(flow.acknowledge(ack(event)), true); flow.tick(true);
    assert.equal(f.payloads.length, 2); assert.equal(f.spool.stats().acknowledged, 1);
  } finally { f.close(); }
});
test('lost business ACK retries identical signed bytes with bounded exponential deadlines', () => {
  const f = fixture(); try {
    f.spool.append(sample); const flow = f.make(); flow.tick(true); f.callbacks[0]();
    f.advance(4999); flow.tick(true); assert.equal(f.payloads.length, 1);
    f.advance(1); flow.tick(true); f.callbacks[1]();
    f.advance(9999); flow.tick(true); assert.equal(f.payloads.length, 2);
    f.advance(1); flow.tick(true); f.callbacks[2]();
    f.advance(20000); flow.tick(true); f.callbacks[3]();
    f.advance(19999); flow.tick(true); assert.equal(f.payloads.length, 4);
    f.advance(1); flow.tick(true); assert.equal(f.payloads.length, 5);
    assert.equal(new Set(f.payloads).size, 1); assert.equal(flow.snapshot().retries, 4);
    assert.equal(f.spool.stats().pending, 1); assert.equal(f.spool.stats().sequence, 1);
  } finally { f.close(); }
});
test('uncompleted MQTT publication is bounded even after timeout and business ACK before PUBACK', () => {
  const f = fixture(); try {
    const event = f.spool.append(sample); f.spool.append(sample); const flow = f.make(); flow.tick(true);
    f.advance(100000); for (let i = 0; i < 100; i++) flow.tick(true);
    assert.equal(f.payloads.length, 1); flow.acknowledge(ack(event)); flow.tick(true);
    assert.equal(f.payloads.length, 1); assert.equal(flow.snapshot().awaitingPuback, 1);
    f.callbacks[0](); f.callbacks[0](); flow.tick(true); assert.equal(f.payloads.length, 2);
    assert.equal(flow.snapshot().occupied, 1);
  } finally { f.close(); }
});
test('disconnect, transport errors and synchronous throws retain data and bounded retry', () => {
  const f = fixture(); try {
    f.spool.append(sample); const flow = f.make(); flow.tick(false); assert.equal(f.payloads.length, 0);
    flow.tick(true); f.callbacks[0](Error('network')); flow.tick(true); assert.equal(f.payloads.length, 1);
    f.advance(5000); flow.tick(false); assert.equal(f.payloads.length, 1); flow.tick(true); assert.equal(f.payloads.length, 2);
    assert.equal(flow.snapshot().publishErrors, 1); assert.equal(f.spool.stats().pending, 1);
    flow.stop(); const throwing = new BusinessAckFlow(f.spool, () => { throw Error('transport'); }, options);
    // New instance honors the durable last_attempt; make that one event old without rewriting it.
    const later = new BusinessAckFlow(f.spool, () => { throw Error('transport'); }, options, () => 1, () => Date.now() + 6000);
    later.tick(true); later.tick(true); assert.equal(later.snapshot().published, 1); assert.equal(later.snapshot().publishErrors, 1);
    assert.equal(throwing.snapshot().occupied, 0); assert.equal(f.spool.stats().pending, 1);
  } finally { f.close(); }
});
test('REJECTED stays in the spool and a valid old delayed ACK can clear an unstarted event', () => {
  const f = fixture(); try {
    const first = f.spool.append(sample), second = f.spool.append(sample), third = f.spool.append(sample), flow = f.make();
    flow.tick(true); f.callbacks[0]();
    assert.ok(flow.acknowledge(ack(first, { status: 'REJECTED', reason: 'POLICY' })));
    assert.ok(flow.acknowledge(ack(second))); flow.tick(true);
    assert.equal(JSON.parse(f.payloads[1]).eventId, third.eventId);
    assert.equal(f.spool.stats().rejected, 1); assert.equal(f.spool.stats().pending, 1);
    assert.equal(f.spool.stats().acknowledged, 1); assert.equal(f.spool.stats().sequence, 3);
  } finally { f.close(); }
});
test('restart reuses the exact SQLite identity/bytes and respects durable last attempt', () => {
  const f = fixture(); try {
    const event = f.spool.append(sample), flow = f.make(); flow.tick(true); f.callbacks[0](); flow.stop();
    const before = f.spool.db.prepare('SELECT payload,digest,attempts FROM pending').get(); f.restart(); const restarted = f.make();
    restarted.tick(true); assert.equal(f.payloads.length, 1); f.advance(5001); restarted.tick(true);
    assert.equal(f.payloads.length, 2); assert.equal(f.payloads[0], f.payloads[1]);
    const after = f.spool.db.prepare('SELECT payload,digest,attempts FROM pending').get();
    assert.equal(after!.payload, before!.payload); assert.equal(after!.digest, before!.digest); assert.equal(after!.attempts, 2);
    f.callbacks[1](); assert.ok(restarted.acknowledge(ack(event))); assert.equal(f.spool.stats().sequence, 1);
    assert.equal(f.spool.stats().pending, 0); assert.equal(f.spool.stats().acknowledged, 1);
  } finally { f.close(); }
});
test('bounded multi-slot window cannot be bypassed by a large pending queue', () => {
  const f = fixture(); try {
    const events = Array.from({ length: 12 }, () => f.spool.append(sample)), flow = f.make({ window: 8 });
    flow.tick(true); assert.equal(f.payloads.length, 8); f.callbacks.forEach(done => done());
    for (let i = 0; i < 10; i++) flow.tick(true); assert.equal(f.payloads.length, 8);
    assert.equal(flow.snapshot().occupied, 8); flow.acknowledge(ack(events[4])); flow.tick(true);
    assert.equal(f.payloads.length, 9); assert.equal(flow.snapshot().occupied, 8);
    assert.equal(f.spool.stats().pending, 11); assert.equal(f.spool.stats().sequence, 12);
  } finally { f.close(); }
});
test('active deadlines use monotonic time, and stop prevents publishing or ACK mutations', () => {
  const f = fixture(); try {
    const event = f.spool.append(sample), flow = f.make(); flow.tick(true); f.callbacks[0]();
    f.wallBack(3600000); f.advance(5000); flow.tick(true); assert.equal(f.payloads.length, 2);
    flow.stop(); f.advance(60000); flow.tick(true); assert.equal(f.payloads.length, 2);
    assert.equal(flow.acknowledge(ack(event)), false); assert.equal(f.spool.stats().pending, 1);
    assert.equal(flow.snapshot().stopped, true);
  } finally { f.close(); }
});
