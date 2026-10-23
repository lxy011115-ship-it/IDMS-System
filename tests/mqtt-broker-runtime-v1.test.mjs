import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fieldMqttClientId,fieldMqttTopic} from '../integrations/field-profile.ts';
import {mqttBrokerRuntimeV1,mqttBrokerFilesV1} from '../scripts/mqtt-broker-runtime-v1.mjs';

const fixture=()=>({format:1,purpose:'MQTT_BROKER_SERVICE_V1',toolingDirectory:resolve('work/mqtt-broker-tools-contract-only'),host:'127.0.0.1',port:29883,server:{caFile:resolve('work/broker-ca.pem'),certificateFile:resolve('work/broker-server.pem'),keyFile:resolve('work/broker-server.key')},probe:{clientId:'idms-broker-probe-'+'1'.repeat(16),certificateFile:resolve('work/broker-probe.pem'),keyFile:resolve('work/broker-probe.key')},channels:[{tenantId:'alpha',edgeId:'edge-a'},{tenantId:'beta',edgeId:'edge-b'}]});
test('broker accepts only the fixed loopback mTLS profile and declared tenant-edge pairs',()=>{const value=fixture();assert.deepEqual(mqttBrokerRuntimeV1(value),value);});
test('PID, executable, hook, arbitrary ACL and duplicate channels are rejected before any process creation',()=>{
  for(const key of ['pid','executable','command','include','plugin','acl']){const value=fixture();value[key]='untrusted';assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_FIELDS/);}
  let value=fixture();value.channels[0].telemetryTopic='foreign/#';assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_CHANNEL/);
  value=fixture();value.channels[1]=value.channels[0];assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_DUPLICATE/);
});
test('wildcards, non-loopback listeners, low ports, credential strings and path-line injection are rejected',()=>{
  for(const host of ['0.0.0.0','localhost','::1']){const value=fixture();value.host=host;assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_ENDPOINT/);}
  let value=fixture();value.port=188;assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_ENDPOINT/);
  value=fixture();value.server.keyFile+='\ninclude bad';assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_SERVER/);
  value=fixture();value.probe.password='do-not-log';assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_PROBE/);
  for(const tenantId of ['alpha/#','alpha\nuser other','alpha+']){value=fixture();value.channels[0].tenantId=tenantId;assert.throws(()=>mqttBrokerRuntimeV1(value),/MQTT_BROKER_CONFIG_CHANNEL/);}
});
test('fixed ACL derives the exact existing field identities and gives the health identity no business topic rights',()=>{
  const config=fixture(),owner=randomUUID(),generated=mqttBrokerFilesV1(config,{owner,aclFile:join(resolve('work'),'acl')});
  assert.equal(generated.probeTopic,'idms/control/'+owner+'/health');
  const sections=generated.acl.trim().split('\nuser ');assert.equal(sections.length,5);
  assert.equal(sections[0],'user '+config.probe.clientId+'\ntopic readwrite '+generated.probeTopic);
  for(let i=0;i<2;i++){
    const source=config.channels[i];
    assert.equal(sections[1+i*2],fieldMqttClientId(source,'EDGE')+'\ntopic write '+fieldMqttTopic(source,'telemetry')+'\ntopic read '+fieldMqttTopic(source,'ack'));
    assert.equal(sections[2+i*2],fieldMqttClientId(source,'PLATFORM')+'\ntopic read '+fieldMqttTopic(source,'telemetry')+'\ntopic write '+fieldMqttTopic(source,'ack'));
  }
  assert.match(generated.configuration,/^listener 29883 127\.0\.0\.1\n/);assert.match(generated.configuration,/\nrequire_certificate true\n/);assert.match(generated.configuration,/\nretain_available false\n/);
  assert.doesNotMatch(generated.configuration,/\n(?:include|plugin|password_file|pid_file|bridge|daemon)\b/);
});
