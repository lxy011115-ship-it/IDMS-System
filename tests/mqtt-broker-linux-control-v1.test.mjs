import test from 'node:test';
import assert from 'node:assert/strict';
import {mqttBrokerLinuxControlV1} from '../scripts/mqtt-broker-linux-control-v1.mjs';

test('normal shutdown readiness requires the actual SIGINT handler bit, including full 64-bit masks',()=>{
  assert.deepEqual(mqttBrokerLinuxControlV1('Name:\tmosquitto\nSigCgt:\t8000000000004002\n'),{sigintCaught:true,sigtermCaught:true,ready:true});
  assert.deepEqual(mqttBrokerLinuxControlV1('SigCgt:\t0000000000000002\n'),{sigintCaught:true,sigtermCaught:false,ready:true});
});
test('a listener or another caught/ignored signal does not establish SIGINT control readiness',()=>{
  for(const mask of ['0','0000000000004000','8000000000000000'])assert.equal(mqttBrokerLinuxControlV1('SigIgn:\t0000000000000002\nSigCgt:\t'+mask+'\n').ready,false);
});
test('missing, duplicate or malformed kernel signal status fails closed',()=>{
  for(const value of ['',null,'SigCgt:\txx\n','SigCgt:\t1\nSigCgt:\t2\n','SigCgt:\t12345678901234567\n'])assert.throws(()=>mqttBrokerLinuxControlV1(value),/MQTT_BROKER_SIGNAL_STATUS_INVALID/);
});
