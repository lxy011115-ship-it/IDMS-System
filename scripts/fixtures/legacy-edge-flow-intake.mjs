// QA fault wrapper around the unchanged production transaction receiver.
import { seedStore } from '../../server/store.ts';
import { loadRuntimeImports, waitForWrites } from '../../server/import-api.ts';
import { closePostgres } from '../../server/postgres-repository.ts';
import { TelemetryService } from '../../server/telemetry.ts';
import { topicFor } from '../../integrations/telemetry.ts';
import { createHash } from 'node:crypto';
const store = seedStore(), intake = new TelemetryService(), digests = new Map(); let handled = 0, dropped = 0, wireCount = 0, changedRetryBytes = false;
await loadRuntimeImports(store);
const receive = intake.receive.bind(intake);
intake.receive = async (...args) => {
  const id = JSON.parse(args[2].toString()).eventId, hash = createHash('sha256').update(args[2]).digest('hex'); wireCount++;
  if (digests.has(id) && digests.get(id) !== hash) changedRetryBytes = true; digests.set(id, hash);
  await new Promise(resolve => setTimeout(resolve, 600)); await receive(...args); handled++;
};
await intake.start(store);
const publish = intake.client.publish.bind(intake.client);
intake.client.publish = (topic, payload, ...args) => {
  if (!dropped && topic === topicFor(intake.config.sources[0], 'ack') && JSON.parse(payload.toString()).status === 'STORED') { dropped++; return intake.client; }
  return publish(topic, payload, ...args);
};
process.on('message', async message => {
  if (message?.type === 'STATUS') process.send?.({ id: message.id, connected: intake.connected, subscribed: intake.subscribed, handled, dropped,
    duplicateWireEvents: wireCount - digests.size, changedRetryBytes, lastError: intake.lastError });
  if (message?.type === 'STOP') { await intake.close(); await waitForWrites(); await closePostgres(); process.exit(0); }
});
process.send?.({ type: 'READY' });
