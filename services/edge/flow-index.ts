import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import mqtt from 'mqtt';
import { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy, type ClientSession } from 'node-opcua';
import { topicFor, type EdgeSource, type Quality } from '../../integrations/telemetry.ts';
import { EdgeSpool } from './spool.ts';
import { BusinessAckFlow, businessAckFlowOptions, defaultBusinessAckFlowOptions } from './business-ack-flow.ts';

// Explicit alternative for the existing local simulator. Default launchers still use index.ts.
async function main() {
  const config = JSON.parse(await readFile(process.env.IDMS_TELEMETRY_CONFIG || '.local/mqtt/telemetry-runtime.json', 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.sources)) throw Error('LEGACY_FLOW_CONFIG_INVALID');
  const source: EdgeSource | undefined = config.sources.find((s: EdgeSource) => s.edgeId === (process.env.IDMS_EDGE_ID || config.sources[0]?.edgeId));
  if (!source || source.origin !== 'SIMULATOR') throw Error('LEGACY_FLOW_SIMULATOR_ONLY');
  const edge = config.edge, endpoint = new URL(edge.endpoint), broker = new URL(config.mqtt.url), statusUrl = new URL(source.statusUrl);
  const local = (url: URL) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (endpoint.protocol !== 'opc.tcp:' || !local(endpoint) || edge.securityMode !== 'None' || edge.securityPolicy !== 'None'
    || !['mqtt:', 'mqtts:'].includes(broker.protocol) || !local(broker)
    || statusUrl.hostname !== '127.0.0.1' || statusUrl.protocol !== 'http:' || statusUrl.pathname !== '/status'
    || !statusUrl.port || statusUrl.username || statusUrl.password || statusUrl.search || statusUrl.hash) throw Error('LEGACY_FLOW_LOCAL_TRANSPORT_REQUIRED');
  if (!source.points.length || !Number.isSafeInteger(edge.capacity) || edge.capacity < source.points.length || edge.capacity > 1000000
    || !Number.isSafeInteger(edge.pollMs) || edge.pollMs < 100 || edge.pollMs > 3600000
    || [source.statusKey, source.signingKey, source.acknowledgementKey].some(k => typeof k !== 'string' || k.length < 32)) throw Error('LEGACY_FLOW_CONFIG_INVALID');
  const options = process.env.IDMS_LEGACY_EDGE_FLOW_CONFIG
    ? businessAckFlowOptions(JSON.parse(await readFile(process.env.IDMS_LEGACY_EDGE_FLOW_CONFIG, 'utf8')))
    : { ...defaultBusinessAckFlowOptions };
  let spool: EdgeSpool | undefined, flow: BusinessAckFlow | undefined, mqttClient: ReturnType<typeof mqtt.connect> | undefined;
  let mqttConnected = false, ackSubscribed = false, opcConnected = false, closing = false, connectionGeneration = 0;
  let lastSample: string | null = null, lastError: string | null = null, gaps = 0, skippedBatches = 0;
  let session: ClientSession | undefined, captureTask: Promise<void> | undefined, shutdownTask: Promise<void> | undefined;
  let captureTimer: ReturnType<typeof setInterval> | undefined, publishTimer: ReturnType<typeof setInterval> | undefined;
  const status = createServer((req, res) => {
    const supplied = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from('Bearer ' + source.statusKey);
    if (req.url !== '/status' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403); res.end(); return; }
    if (!spool || !flow || closing) { res.writeHead(503); res.end(); return; }
    const stats = spool.stats(), capacityBlocked = stats.pending + stats.rejected + source.points.length > edge.capacity;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ edgeId: source.edgeId, tenantId: source.tenantId, origin: source.origin, mode: 'READ_ONLY_POLL',
      mqttConnected, ackSubscribed, opcConnected, lastSample, lastError: capacityBlocked ? 'SPOOL_CAPACITY_REACHED' : lastError,
      gaps, skippedBatches, capacityBlocked, capacity: edge.capacity, ...stats, flowControl: flow.snapshot() }));
  });
  // Bind before opening/migrating the spool or connecting either protocol.
  await new Promise<void>((resolve, reject) => { status.once('error', reject); status.listen(Number(statusUrl.port), '127.0.0.1', resolve); });
  const opc = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.None, securityPolicy: SecurityPolicy.None,
    connectionStrategy: { initialDelay: 500, maxDelay: 2000, maxRetry: 0 }, keepSessionAlive: true, clientName: 'IDMS flow-controlled read-only simulator edge' });
  opc.on('connection_lost', () => { opcConnected = false; });

  async function capture() {
    if (closing || !spool) return;
    const stats = spool.stats();
    if (stats.pending + stats.rejected + source!.points.length > edge.capacity) { gaps++; skippedBatches++; return; }
    try {
      if (!session) { await opc.connect(edge.endpoint); if (closing) return; session = await opc.createSession(); opcConnected = true; }
      const values = await session.read(source!.points.map(p => ({ nodeId: p.nodeId, attributeId: AttributeIds.Value })), 0);
      if (closing) return;
      for (let i = 0; i < values.length; i++) {
        const value = values[i], point = source!.points[i];
        if (!value.sourceTimestamp) { gaps++; lastError = 'SOURCE_TIMESTAMP_MISSING'; continue; }
        const severity = value.statusCode.value >>> 30, quality: Quality = severity === 0 ? 'GOOD' : severity === 1 ? 'UNCERTAIN' : 'BAD';
        const numeric = typeof value.value?.value === 'number' && Number.isFinite(value.value.value) ? value.value.value : null;
        spool.append({ tagCode: point.tagCode, nodeId: point.nodeId, unit: point.unit, eventTime: value.sourceTimestamp.toISOString(), value: numeric, quality: numeric === null ? 'BAD' : quality });
        lastSample = value.sourceTimestamp.toISOString();
      }
      if (values.every(value => value.sourceTimestamp)) lastError = null;
    } catch (error) {
      gaps++;
      if (error instanceof Error && error.message === 'SPOOL_CAPACITY_REACHED') { skippedBatches++; lastError = null; }
      else { lastError = 'OPC_READ_FAILED'; opcConnected = false; try { await session?.close(); } catch {} session = undefined; try { await opc.disconnect(); } catch {} }
    }
  }
  function startCapture() {
    if (closing || captureTask) return;
    captureTask = capture().finally(() => { captureTask = undefined; });
    void captureTask.catch(() => { lastError = 'SPOOL_READ_FAILED'; });
  }
  function shutdown() {
    return shutdownTask ??= (async () => {
      closing = true; flow?.stop(); clearInterval(captureTimer); clearInterval(publishTimer);
      await captureTask?.catch(() => undefined);
      const listenerClosed = new Promise<void>(resolve => status.close(() => resolve())); status.closeIdleConnections();
      if (mqttClient) await new Promise<void>(resolve => mqttClient!.end(true, {}, () => resolve()));
      try { await session?.close(); } catch {} try { await opc.disconnect(); } catch {}
      await listenerClosed; spool?.close();
    })();
  }
  try {
    await mkdir(dirname(edge.spool), { recursive: true }); spool = new EdgeSpool(edge.spool, source, edge.capacity);
    mqttClient = mqtt.connect(config.mqtt.url, { username: edge.username, password: edge.password, clientId: edge.username,
      protocolVersion: 5, clean: true, reconnectPeriod: 1000, connectTimeout: 3000, queueQoSZero: false, resubscribe: false,
      properties: { maximumPacketSize: 16384, receiveMaximum: options.window } });
    flow = new BusinessAckFlow(spool, (payload, done) => mqttClient!.publish(topicFor(source, 'telemetry'), payload, { qos: 1, retain: false }, done), options);
    mqttClient.on('connect', () => {
      mqttConnected = true; ackSubscribed = false; const generation = ++connectionGeneration;
      mqttClient!.subscribe(topicFor(source, 'ack'), { qos: 1 }, (error, granted) => {
        if (generation !== connectionGeneration || !mqttConnected || !mqttClient!.connected || closing) return;
        ackSubscribed = !error && !!granted?.length && granted.every(g => g.qos < 128);
        if (!ackSubscribed) lastError = 'MQTT_ACK_SUBSCRIBE_FAILED';
      });
    });
    mqttClient.on('close', () => { mqttConnected = false; ackSubscribed = false; connectionGeneration++; });
    mqttClient.on('error', () => { lastError = 'MQTT_CONNECTION_ERROR'; });
    mqttClient.on('message', (topic, bytes) => {
      if (closing || topic !== topicFor(source, 'ack') || bytes.length > 8192) return;
      try { if (!flow!.acknowledge(JSON.parse(bytes.toString()))) lastError = 'ACK_INVALID'; }
      catch { lastError = 'ACK_INVALID'; }
    });
    captureTimer = setInterval(startCapture, edge.pollMs);
    publishTimer = setInterval(() => {
      if (!closing) try { flow!.tick(mqttConnected && ackSubscribed); } catch { lastError = 'SPOOL_READ_FAILED'; }
    }, 100);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown().then(() => process.exit(0), () => process.exit(1)); });
    process.on('message', message => {
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'STOP_LEGACY_EDGE_FLOW_V1') {
        void shutdown().then(() => process.exit(0), () => process.exit(1));
      }
    });
    startCapture();
    console.log('Legacy simulator business-ACK flow v1 ready; source protocol and durable spool unchanged.');
  } catch (error) { await shutdown(); throw error; }
}
main().catch(() => { console.error('LEGACY_EDGE_FLOW_START_FAILED'); process.exitCode = 1; });
