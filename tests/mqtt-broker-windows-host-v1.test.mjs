import test from 'node:test';
import assert from 'node:assert/strict';
import {mqttBrokerWindowsHostV1,assertMqttBrokerWindowsHostV1} from '../scripts/mqtt-broker-windows-host-v1.mjs';
import {readMqttBrokerFileV1} from '../scripts/mqtt-broker-runtime-v1.mjs';

test('only the fixed Windows OS host admits servicing hard links and still requires unchanged identity and full bytes',{skip:process.platform!=='win32'},async()=>{
  const host=await mqttBrokerWindowsHostV1();assert(host.nlink>=1&&host.bytes>0);assert.match(host.sha256,/^[a-f0-9]{64}$/);
  await assertMqttBrokerWindowsHostV1(host);
  for(const changed of [{...host,sha256:'0'.repeat(64)},{...host,ino:'foreign'},{...host,path:'C:\\untrusted\\powershell.exe'},{...host,extra:'untrusted'}])await assert.rejects(assertMqttBrokerWindowsHostV1(changed),/MQTT_BROKER_WINDOWS_HOST_CHANGED/);
  if(host.nlink>1)await assert.rejects(readMqttBrokerFileV1(host.path),/MQTT_BROKER_FILE/);
});
