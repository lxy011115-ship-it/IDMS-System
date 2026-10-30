import assert from 'node:assert/strict';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import mqtt from 'mqtt';
import { OPCUAServer, OPCUACertificateManager, DataType, Variant, DataValue, StatusCodes, MessageSecurityMode, SecurityPolicy } from 'node-opcua';
import { createMqttConfig, launchBroker } from './mqtt-local.mjs';
import { writePrivate } from './keycloak-local.mjs';
import { authenticEvent, signAck, sha, topicFor } from '../integrations/telemetry.ts';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12), root = resolve('.local'), directory = join(root, 'legacy-flow-qa-' + suffix);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [], closed = new Map();
let broker, edge, receiver, opc, config, source, file, brokerFile, flowFile, mode = 'HOLD';
let reads = 0, writes = 0, calls = 0, received = 0;
const bodies = new Map(), countById = new Map(), approved = new Set();
const freePorts = [];
async function port() {
  const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port; await new Promise(resolve => server.close(resolve));
  if (freePorts.includes(value)) return port(); freePorts.push(value); return value;
}
async function until(task, label, timeout = 25000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { const value = await task(); if (value) return value; await pause(100); }
  const diagnostic = source ? await status() : null;
  throw Error('Timed out: ' + label + '; safe status=' + JSON.stringify(diagnostic && { pending: diagnostic.pending, acknowledged: diagnostic.acknowledged,
    mqttConnected: diagnostic.mqttConnected, ackSubscribed: diagnostic.ackSubscribed, lastError: diagnostic.lastError, flow: diagnostic.flowControl,
    received, unique: bodies.size, receiverConnected: receiver?.connected }));
}
function track(child) {
  children.push(child); closed.set(child, new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))));
  child.on('error', () => {}); child.stdout?.resume(); child.stderr?.resume(); return child;
}
async function stop(child, graceful = false) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    if (graceful && child.connected) child.send({ type: 'STOP_LEGACY_EDGE_FLOW_V1' }); else child.kill();
    const result = await Promise.race([closed.get(child), pause(10000).then(() => null)]);
    if (!result) { child.kill(); await Promise.race([closed.get(child), pause(5000)]); throw Error('Owned process did not close gracefully'); }
    if (graceful) assert.equal(result.code, 0);
  }
  await closed.get(child);
}
function startEdge() {
  return track(fork('services/edge/flow-index.ts', [], { env: { ...process.env, IDMS_TELEMETRY_CONFIG: file, IDMS_LEGACY_EDGE_FLOW_CONFIG: flowFile },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }));
}
async function status() {
  try { const r = await fetch(source.statusUrl, { headers: { Authorization: 'Bearer ' + source.statusKey }, signal: AbortSignal.timeout(2000) }); if (r.status === 200) return r.json(); }
  catch {} return null;
}
function rows() {
  const db = new DatabaseSync(config.edge.spool, { readOnly: true });
  try { return { pending: db.prepare('SELECT event_id,payload,digest,state FROM pending ORDER BY rowid').all(),
    sequence: db.prepare("SELECT value FROM metadata WHERE name='sequence'").get().value,
    binding: db.prepare("SELECT value FROM metadata WHERE name='source'").get().value,
    acknowledged: db.prepare('SELECT count(*) AS n FROM acknowledged').get().n }; } finally { db.close(); }
}
function sendAck(event, patch = {}, key = source.acknowledgementKey) {
  const value = signAck({ version: 1, eventId: event.eventId, edgeId: source.edgeId, tenantId: source.tenantId, digest: sha(event), status: 'STORED', ...patch }, key);
  receiver.publish(topicFor(source, 'ack'), JSON.stringify(value), { qos: 1, retain: false }, () => {});
  if (key === source.acknowledgementKey && value.digest === sha(event) && value.status === 'STORED') approved.add(event.eventId);
}
let proof, cleanupComplete = false;
try {
  await mkdir(directory, { recursive: false });
  const prepared = await createMqttConfig(directory, { port: await port(), statusPort: await port(), opcPort: await port(), simulatorPort: await port(), edgeId: 'qa-flow-' + suffix });
  ({ config, file, brokerFile } = prepared); source = config.sources[0]; config.edge.pollMs = 500; config.edge.capacity = 11;
  flowFile = join(directory, 'flow.json');
  await writePrivate(file, JSON.stringify(config)); await writePrivate(flowFile, JSON.stringify({ version: 1, window: 1, ackTimeoutMs: 5000, maxRetryMs: 20000 }));
  opc = new OPCUAServer({ port: config.simulator.port, host: '127.0.0.1', hostname: '127.0.0.1', alternateHostname: ['127.0.0.1'],
    resourcePath: '', securityModes: [MessageSecurityMode.None], securityPolicies: [SecurityPolicy.None],
    serverCertificateManager: new OPCUACertificateManager({ rootFolder: join(directory, 'pki') }) });
  opc.on('request', request => { if (request.schema.name === 'ReadRequest') reads++; if (request.schema.name === 'WriteRequest') writes++; if (request.schema.name === 'CallRequest') calls++; });
  await opc.initialize(); const ns = opc.engine.addressSpace.getOwnNamespace();
  for (const point of source.points) ns.addVariable({ organizedBy: opc.engine.addressSpace.rootFolder.objects, browseName: point.tagCode, nodeId: point.nodeId,
    dataType: 'Double', accessLevel: 'CurrentRead', userAccessLevel: 'CurrentRead', minimumSamplingInterval: 100,
    value: { timestamped_get: () => new DataValue({ value: new Variant({ dataType: DataType.Double, value: 2 }), sourceTimestamp: new Date(), statusCode: StatusCodes.Good }) } });
  await opc.start(); broker = track(launchBroker(brokerFile));
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(Error('QA receiver connection timeout')), 6000);
    receiver = mqtt.connect(config.mqtt.url, { username: config.mqtt.username, password: config.mqtt.password, clientId: 'qa-receiver-' + suffix,
      protocolVersion: 5, reconnectPeriod: 500, connectTimeout: 2000 });
    receiver.on('error', () => {});
    receiver.on('connect', () => receiver.subscribe(topicFor(source, 'telemetry'), { qos: 1 }, error => { if (!error) { clearTimeout(timer); resolveReady(); } }));
  });
  receiver.on('message', (topic, bytes) => {
    assert.equal(topic, topicFor(source, 'telemetry')); const event = JSON.parse(bytes.toString()); assert.ok(authenticEvent(event, source.signingKey));
    received++; const previous = bodies.get(event.eventId); if (previous) assert.equal(previous, bytes.toString());
    bodies.set(event.eventId, bytes.toString()); countById.set(event.eventId, (countById.get(event.eventId) || 0) + 1);
    if (mode === 'ACK') sendAck(event);
  });
  edge = startEdge();
  const full = await until(async () => { const s = await status(); return s?.pending === 9 && s.capacityBlocked && s.flowControl.published === 1 ? s : null; }, 'full bounded queue');
  assert.equal(full.sequence, 9); assert.ok(full.pending < config.edge.capacity);
  assert.equal(full.flowControl.occupied, 1); assert.equal(full.flowControl.awaitingPuback, 0); assert.equal(received, 1);
  const first = JSON.parse([...bodies.values()][0]);
  sendAck(first, {}, 'invalid'); sendAck(first, { digest: '0'.repeat(64) });
  await until(async () => (await status())?.flowControl.invalidAcks >= 2, 'invalid ACK rejection');
  const noAuth = await fetch(source.statusUrl); assert.equal(noAuth.status, 403);
  const unicodeAuth = await fetch(source.statusUrl, { headers: { Authorization: 'Bearer é' } }); assert.equal(unicodeAuth.status, 403);
  await until(() => countById.get(first.eventId) >= 2, 'lost ACK identical retry');
  assert.equal(bodies.size, 1); assert.equal((await status()).pending, 9);
  mode = 'ACK'; sendAck(first);
  const recovered = await until(async () => { const s = await status(); return s && !s.capacityBlocked && s.acknowledged >= 12 && s.sequence > full.sequence && s.gaps > 0 ? s : null; }, 'capacity recovery');
  assert.notEqual(recovered.lastError, 'SPOOL_CAPACITY_REACHED');
  mode = 'HOLD'; await until(async () => (await status())?.pending >= 6, 'restart pending'); await stop(edge, true);
  const beforeRestart = rows(); assert.ok(beforeRestart.pending.length >= 6);
  edge = startEdge(); await until(async () => (await status())?.mqttConnected, 'restart status');
  const afterRestart = rows(); assert.equal(afterRestart.binding, beforeRestart.binding); assert.ok(Number(afterRestart.sequence) >= Number(beforeRestart.sequence));
  for (const row of beforeRestart.pending) assert.deepEqual(afterRestart.pending.find(value => value.event_id === row.event_id), row);
  const oldId = beforeRestart.pending[0].event_id;
  await until(() => countById.get(oldId) >= 2, 'restart replay'); mode = 'ACK'; sendAck(JSON.parse(bodies.get(oldId)));
  await until(async () => (await status())?.pending === 0, 'restart drain');
  await stop(broker); await until(async () => (await status())?.mqttConnected === false, 'broker disconnected');
  const offlinePublished = (await status()).flowControl.published; await pause(1700);
  assert.equal((await status()).flowControl.published, offlinePublished); assert.ok((await status()).pending >= 6);
  broker = track(launchBroker(brokerFile)); await until(async () => (await status())?.mqttConnected && receiver.connected, 'broker reconnect');
  await until(async () => (await status())?.pending === 0, 'broker recovery drain');
  // A second explicit entry must fail at the listener before touching the shared protocols or spool.
  const competitor = startEdge(), result = await Promise.race([closed.get(competitor), pause(8000).then(() => null)]);
  assert.equal(result?.code, 1); assert.ok((await status()).mqttConnected);
  const final = await status(); assert.ok(final.flowControl.occupied <= 1); assert.ok(final.flowControl.awaitingPuback <= 1);
  assert.ok(reads > 0); assert.equal(writes, 0); assert.equal(calls, 0);
  await stop(edge, true); const durable = rows();
  assert.equal(Number(durable.sequence), durable.pending.length + durable.acknowledged);
  const db = new DatabaseSync(config.edge.spool, { readOnly: true });
  try { for (const row of db.prepare('SELECT event_id FROM acknowledged').all()) assert.ok(approved.has(row.event_id)); } finally { db.close(); }
  proof = { verifiedAt: new Date().toISOString(), realLoopbackMosquittoAndOpcUa: true, signedBusinessAckReceiverIsModel: true,
    actualPostgresIntakeTested: false, originalRuntimeOrQueueModified: false, window: 1, lostAckRetrySameSignedBytes: true,
    pubackDoesNotRemovePending: true, invalidSignedAndDigestAcksDoNotAdvance: true, rejectedStatusCoveredByUnitTest: true,
    fullBatchCapacityPreflight: true, capacityRecoveredWithoutErasingHistoricalGaps: true, sameSqliteRestartAndSourceBinding: true,
    brokerOutageNoNewPublishAndReconnectDrain: true, competingEntryDeniedBeforeConnections: true,
    everyAcknowledgedIdWasModelSigned: true, pendingPlusAcknowledgedEqualsSequence: true,
    opcReadRequests: reads, opcWriteRequests: writes, opcCallRequests: calls, telemetryDeliveries: received,
    uniqueTelemetryEvents: bodies.size, finalSequence: Number(durable.sequence), finalAcknowledged: durable.acknowledged,
    finalPending: durable.pending.length, productionAcceptance: false };
} finally {
  receiver?.end(true);
  for (const child of children.toReversed()) await stop(child, child.connected);
  await opc?.shutdown(0);
  assert.equal(dirname(directory), root); assert.equal(resolve(directory), root + sep + 'legacy-flow-qa-' + suffix);
  await rm(directory, { recursive: true, force: true }); cleanupComplete = true;
}
assert.ok(proof && cleanupComplete); proof.ownedProcessesClosedAndPrivateDirectoryRemoved = true;
await mkdir('outputs', { recursive: true }); await writePrivate('outputs/legacy-edge-flow-verification.json', JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
