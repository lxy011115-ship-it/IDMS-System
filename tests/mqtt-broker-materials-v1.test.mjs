import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {privateDirectory} from '../scripts/backup-support.mjs';
import {mqttBrokerMaterialsFixtureQaV1} from '../scripts/fixtures/mqtt-broker-materials-v1-qa.mjs';
import {mqttBrokerMaterialsV1} from '../scripts/mqtt-broker-runtime-v1.mjs';

test('real isolated certificate material binds the probe identity, private keys, server host and expiry',async()=>{
  const directory=resolve('work/mqtt-broker-materials-unit-v1','case-'+randomUUID());await privateDirectory(directory);
  const fixture=await mqttBrokerMaterialsFixtureQaV1({tenantId:'unit',edgeId:'edge-unit'},{directory:join(directory,'materials')}),clientId='idms-broker-probe-'+randomBytes(8).toString('hex'),probe=await fixture.leaf('health',clientId);
  const config={probe:{clientId}},bytes={ca:fixture.ca.certificate,server:fixture.server.certificate,serverKey:fixture.server.privateKey,probe:probe.certificate,probeKey:probe.privateKey};
  const value=mqttBrokerMaterialsV1(config,bytes);assert.match(value.serverCertificateSha256,/^[a-f0-9]{64}$/);assert(value.notAfter>Date.now());
  assert.throws(()=>mqttBrokerMaterialsV1(config,{...bytes,serverKey:probe.privateKey}),/MQTT_BROKER_CERTIFICATE_KEY_MISMATCH/);
  assert.throws(()=>mqttBrokerMaterialsV1(config,{...bytes,probe:fixture.edge.certificate,probeKey:fixture.edge.privateKey}),/MQTT_BROKER_CERTIFICATE_PROBE/);
  assert.throws(()=>mqttBrokerMaterialsV1(config,bytes,Date.now()+10*86400000),/MQTT_BROKER_CERTIFICATE_TIME/);
  const wrongHost=await fixture.leaf('wrong-host','localhost','serverAuth','ca',{san:'DNS:elsewhere.invalid'});
  assert.throws(()=>mqttBrokerMaterialsV1(config,{...bytes,server:wrongHost.certificate,serverKey:wrongHost.privateKey}),/MQTT_BROKER_CERTIFICATE_SERVER/);
});
