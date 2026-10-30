import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { createServer } from 'node:net';
import { fork } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import mqtt from 'mqtt';
import pg from 'pg';
import { createMqttConfig, launchBroker } from './mqtt-local.mjs';
import { writePrivate } from './keycloak-local.mjs';
import { migrateQaDatabases, cleanupQaRoles, qaAdminAccount } from './qa-database.mjs';
import { seedStore } from '../server/store.ts';
import { emptyImports } from '../server/imports.ts';
import { appendAudit, verifyAuditChain } from '../server/audit.ts';
import { EdgeSpool } from '../services/edge/spool.ts';
import { authenticAck, topicFor } from '../integrations/telemetry.ts';

const suffix = randomUUID().replaceAll('-', '').slice(0, 10), localRoot = resolve('.local'), directory = join(localRoot, 'legacy-flow-pg-qa-' + suffix);
const main = JSON.parse(await readFile('.local/postgres-runtime.json', 'utf8'));
const config = { host: main.host, port: main.port, tenants: {} }, accounts = [], children = [], closed = new Map(), ready = new WeakSet();
const admin = new pg.Client({ host: main.host, port: main.port, database: 'postgres', user: 'idms_bootstrap', password: main.bootstrapPassword });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const usedPorts = [];
async function port() { const s = createServer(); await new Promise((ok, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', ok); }); const p = s.address().port; await new Promise(ok => s.close(ok)); if (usedPorts.includes(p)) return port(); usedPorts.push(p); return p; }
async function until(fn, label, timeout = 45000) { const end = performance.now() + timeout; while (performance.now() < end) { const value = await fn(); if (value) return value; await pause(100); } throw Error('PG flow QA timeout: ' + label); }
function track(child) { children.push(child); closed.set(child, new Promise(ok => child.once('close', (code, signal) => ok({ code, signal })))); child.stdout?.resume(); child.stderr?.resume(); child.on('error', () => {}); child.on('message', value => { if (value.type === 'READY') ready.add(child); }); return child; }
function launch(file, env, args = []) { return track(fork(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })); }
async function stop(child, type) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    if (type && child.connected) child.send({ type }); else child.kill();
    const result = await Promise.race([closed.get(child), pause(12000).then(() => null)]);
    if (!result) { child.kill(); await closed.get(child); throw Error('Owned PG flow process shutdown timeout'); }
    if (type) assert.equal(result.code, 0);
  }
  await closed.get(child);
}
async function call(child) {
  return new Promise((ok, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned intake IPC timeout')); }, 4000);
    function listener(value) { if (value.id === id) { clearTimeout(timer); child.off('message', listener); ok(value); } }
    child.on('message', listener); child.send({ type: 'STATUS', id });
  });
}
let connection, observer, edge, intake, telemetry, source, proof;
const envelopes = new Map(), committedAcks = new Set(), rejectedAcks = new Set(), observations = [];
let ackChecks = Promise.resolve(), ackCheckError;
async function status() {
  try { const r = await fetch(source.statusUrl, { headers: { Authorization: 'Bearer ' + source.statusKey }, signal: AbortSignal.timeout(2000) }); if (r.ok) return r.json(); } catch {} return null;
}
try {
  await mkdir(directory, { recursive: false }); await admin.connect();
  for (const tenant of ['acme', 'sandbox']) {
    const name = 'idms_flowqa_' + tenant + '_' + suffix, account = { database: name, user: name, password: randomBytes(32).toString('base64url') };
    accounts.push(account); config.tenants[tenant] = account;
    await admin.query('CREATE ROLE "' + name + '" LOGIN PASSWORD $password$' + account.password + '$password$ NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT');
    await admin.query('CREATE DATABASE "' + name + '" OWNER "' + name + '"');
    await admin.query('REVOKE CONNECT ON DATABASE "' + name + '" FROM PUBLIC');
  }
  const store = seedStore();
  for (let i = 0; i < 1000; i++) appendAudit(store, { tenantId: 'sandbox', objectType: 'TELEMETRY_EVENT', objectId: 'qa-historical-' + i,
    action: 'FLOW_QA_HISTORY', actorType: 'SYSTEM', actorId: 'flow-qa', correlationId: randomUUID(), metadata: { synthetic: true, ordinal: i } });
  const { audits, idempotency, ...business } = store, snapshot = { version: 2, business, audits, idempotency: [...idempotency], imports: emptyImports() };
  const runtime = await migrateQaDatabases(config, main, { telemetryTenants: ['sandbox'], snapshot });
  const pgFile = join(directory, 'business.json'); await writePrivate(pgFile, JSON.stringify(runtime));
  const prepared = await createMqttConfig(directory, { port: await port(), statusPort: await port(), opcPort: await port(), simulatorPort: await port(), edgeId: 'pg-flow-' + suffix });
  telemetry = prepared.config; source = telemetry.sources[0]; telemetry.edge.pollMs = 60000; telemetry.edge.capacity = 30;
  await writePrivate(prepared.file, JSON.stringify(telemetry));
  const flowFile = join(directory, 'flow.json'); await writePrivate(flowFile, JSON.stringify({ version: 1, window: 1, ackTimeoutMs: 5000, maxRetryMs: 20000 }));
  const spool = new EdgeSpool(telemetry.edge.spool, source, telemetry.edge.capacity);
  try { for (let i = 0; i < 12; i++) { const p = source.points[i % 3], event = spool.append({ ...p, unit: i === 11 ? 'wrong-unit' : p.unit,
    eventTime: new Date(Date.now() - 60000 + i * 1000).toISOString(), value: 2, quality: 'GOOD' }); envelopes.set(event.eventId, event); } } finally { spool.close(); }
  connection = new pg.Client(qaAdminAccount(main, config.tenants.sandbox)); await connection.connect();
  const baseline = (await connection.query('SELECT event FROM audit_ledger ORDER BY sequence_no')).rows.map(row => row.event);
  const migrations = (await connection.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
  track(launchBroker(prepared.brokerFile));
  const env = { NODE_ENV: 'test', IDMS_STORAGE: 'postgres', IDMS_POSTGRES_CONFIG: pgFile, IDMS_DEMO_NAMESPACE: 'flow-pg-' + suffix,
    IDMS_TELEMETRY_CONFIG: prepared.file, IDMS_CAPACITY_CONFIG: '', IDMS_LEGACY_EDGE_FLOW_CONFIG: flowFile };
  const ackTopic = topicFor(source, 'ack');
  // Separate read-only observer credentials: do not grant the receiver extra ACK-read authority.
  const edgeObserverId = 'qa-flow-observer-' + suffix;
  observer = mqtt.connect(telemetry.mqtt.url, { username: telemetry.edge.username, password: telemetry.edge.password, clientId: edgeObserverId,
    protocolVersion: 5, reconnectPeriod: 500, connectTimeout: 2000 }); observer.on('error', () => {});
  await new Promise((ok, reject) => { const timer = setTimeout(() => reject(Error('ACK observer timeout')), 5000); observer.once('connect', () => observer.subscribe(ackTopic, { qos: 1 }, (error, grants) => { clearTimeout(timer); error || !grants?.length || grants[0].qos >= 128 ? reject(Error('ACK observer denied')) : ok(); })); });
  observer.on('message', (_topic, bytes) => {
    const ack = JSON.parse(bytes.toString());
    ackChecks = ackChecks.then(async () => {
      assert.ok(authenticAck(ack, source.acknowledgementKey));
      const receipt = (await connection.query('SELECT status,point_id,digest FROM telemetry_receipts WHERE event_id=$1 AND digest=$2', [ack.eventId, ack.digest])).rows;
      assert.equal(receipt.length, 1); assert.equal(receipt[0].status, ack.status);
      const audit = await connection.query("SELECT count(*)::int AS n FROM audit_ledger WHERE event->>'objectId'=$1 AND event->>'action'=$2", [ack.eventId, 'TELEMETRY_' + ack.status]);
      assert.equal(audit.rows[0].n, 1);
      if (ack.status === 'STORED') { assert.equal((await connection.query('SELECT count(*)::int AS n FROM telemetry_points WHERE id=$1', [receipt[0].point_id])).rows[0].n, 1); committedAcks.add(ack.eventId); }
      else rejectedAcks.add(ack.eventId);
    }).catch(error => { ackCheckError ||= error; });
  });
  launch('services/edge/simulator.ts', env);
  await until(async () => { try { const r = await fetch('http://127.0.0.1:' + telemetry.simulator.statusPort + '/status', { headers: { Authorization: 'Bearer ' + telemetry.simulator.statusKey }, signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; } }, 'OPC ready');
  intake = launch('scripts/fixtures/legacy-edge-flow-intake.mjs', env);
  await until(() => { if (intake.exitCode !== null) throw Error('Owned intake exited'); return ready.has(intake); }, 'receiver ready');
  await until(async () => { if (intake.exitCode !== null) throw Error('Owned intake exited'); return (await call(intake)).subscribed; }, 'actual transaction receiver subscribed');
  edge = launch('services/edge/flow-index.ts', env);
  await until(async () => {
    const s = await status(); if (!s) return false; observations.push({ pending: s.pending, rejected: s.rejected, acknowledged: s.acknowledged, sequence: s.sequence, occupied: s.flowControl.occupied, published: s.flowControl.published, retries: s.flowControl.retries });
    assert.ok(s.flowControl.occupied <= 1); assert.ok(s.flowControl.awaitingPuback <= 1);
    return s.pending === 0 && s.rejected === 1 && s.acknowledged === 14;
  }, '15 envelopes: 14 committed, one rejected, one lost ACK retried');
  await stop(edge, 'STOP_LEGACY_EDGE_FLOW_V1');
  const intakeStats = await call(intake); assert.equal(intakeStats.dropped, 1); assert.equal(intakeStats.handled, 16);
  assert.equal(intakeStats.duplicateWireEvents, 1); assert.equal(intakeStats.changedRetryBytes, false); assert.equal(intakeStats.lastError, null);
  await stop(intake, 'STOP'); await ackChecks; if (ackCheckError) throw ackCheckError;
  const finalAudits = (await connection.query('SELECT event FROM audit_ledger ORDER BY sequence_no')).rows.map(row => row.event);
  assert.deepEqual(finalAudits.slice(0, baseline.length), baseline); assert.ok(verifyAuditChain(finalAudits, 'sandbox'));
  assert.equal(finalAudits.length, baseline.length + 15);
  assert.deepEqual((await connection.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows, migrations);
  assert.equal((await connection.query('SELECT count(*)::int AS n FROM telemetry_points')).rows[0].n, 14);
  assert.equal((await connection.query('SELECT count(*)::int AS n FROM telemetry_receipts')).rows[0].n, 15);
  assert.equal(committedAcks.size, 14); assert.equal(rejectedAcks.size, 1);
  const finalSpool = new EdgeSpool(telemetry.edge.spool, source, telemetry.edge.capacity);
  try {
    assert.deepEqual(finalSpool.stats(), { pending: 0, rejected: 1, acknowledged: 14, sequence: 15 });
    const rejected = finalSpool.db.prepare("SELECT event_id,payload FROM pending WHERE state='REJECTED'").get();
    assert.deepEqual(JSON.parse(rejected.payload), envelopes.get(rejected.event_id));
  } finally { finalSpool.close(); }
  const simulatorResponse = await fetch('http://127.0.0.1:' + telemetry.simulator.statusPort + '/status', { headers: { Authorization: 'Bearer ' + telemetry.simulator.statusKey } }), simulator = await simulatorResponse.json();
  assert.ok(simulator.readRequests > 0); assert.equal(simulator.writeRequests, 0);
  const last = observations.at(-1); assert.equal(last.retries, 1); assert.equal(last.published, 16);
  proof = { verifiedAt: new Date().toISOString(), actualUnchangedTelemetryServiceAndPostgresTransactions: true, receiverWrapperDelayMs: 600,
    actualCommitThenFirstStoredAckDroppedByQaTransportWrapper: true, syntheticHistoricalAuditEvents: 1000, sourceEnvelopes: 15,
    storedPoints: 14, receipts: 15, newTelemetryAuditEvents: 15, storedBusinessAcknowledgements: 14, durableRejectedEnvelopes: 1,
    publishAttempts: last.published, identicalEventRetryAfterLostBusinessAck: last.retries, actualDuplicateWireEventsWithIdenticalBytes: intakeStats.duplicateWireEvents,
    everyObservedAckSawCommittedReceiptPointAndAudit: true,
    retryDidNotDuplicatePointReceiptOrAudit: true, historicalAuditPrefixAndFullChainPreserved: true, migrationHistoryUnchanged: true,
    observedBusinessWindowNeverExceededOne: true, actualReadOnlyOpcUa: true, opcWriteRequests: simulator.writeRequests,
    originalRuntimeOrQueueModified: false, fieldHardwareUsed: false, productionCapacityOrSlaAcceptance: false, productionAcceptance: false };
} finally {
  observer?.end(true);
  for (const child of children.toReversed()) await stop(child, child === edge ? 'STOP_LEGACY_EDGE_FLOW_V1' : child === intake ? 'STOP' : undefined);
  await ackChecks; await connection?.end();
  for (const account of accounts) { assert.match(account.database, new RegExp('^idms_flowqa_(acme|sandbox)_' + suffix + '$')); await admin.query('DROP DATABASE IF EXISTS "' + account.database + '" WITH (FORCE)'); await admin.query('DROP ROLE IF EXISTS "' + account.user + '"'); }
  await cleanupQaRoles(admin, config); await admin.end();
  assert.equal(dirname(directory), localRoot); assert.equal(directory, localRoot + sep + 'legacy-flow-pg-qa-' + suffix); await rm(directory, { recursive: true, force: true });
}
assert.ok(proof); proof.ownedProcessesDatabasesRolesAndPrivateFilesRemoved = true;
await mkdir('outputs', { recursive: true }); await writePrivate('outputs/legacy-edge-flow-postgres-verification.json', JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
