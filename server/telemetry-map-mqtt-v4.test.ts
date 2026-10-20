import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bindTelemetryMapMqttV4} from './telemetry-map-mqtt-v4.ts';
import {signEvent,topicFor,type EdgeSource} from '../integrations/telemetry.ts';
test('a failing error reporter does not strand the MQTT completion callback or publish an ACK',{timeout:2000},async()=>{
 const source:EdgeSource={tenantId:'sandbox',edgeId:'test',deviceCode:'SIM-1',origin:'SIMULATOR',mapVersion:'1',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=v',unit:'mm/s'}],signingKey:'s'.repeat(64),acknowledgementKey:'a'.repeat(64),statusKey:'x'.repeat(64),statusUrl:'http://127.0.0.1:1/status'},store={tenantId:'sandbox',snapshot:async()=>{throw Error('database refused');}},messages:string[]=[],client:any={subscribe:(topics:string[],_o:unknown,callback:Function)=>callback(null,topics.map(topic=>({topic,qos:1}))),publish:()=>{throw Error('must not publish');}},original=console.error;console.error=(m:string)=>messages.push(m);
 try{await bindTelemetryMapMqttV4(client,store as any,[source],{onError:()=>{throw Error('reporter refused');}});const e=signEvent({version:1,eventId:randomUUID(),tenantId:'sandbox',edgeId:source.edgeId,deviceCode:source.deviceCode,tagCode:'vibration_rms',nodeId:'ns=1;s=v',mapVersion:'1',sequenceNo:1,eventTime:new Date().toISOString(),value:1,unit:'mm/s',quality:'GOOD'},source.signingKey);await new Promise<void>(ok=>client.handleMessage({topic:topicFor(source,'telemetry'),payload:Buffer.from(JSON.stringify(e))},ok));assert.deepEqual(messages,['[IDMS v4 telemetry] error reporter failed']);}finally{console.error=original;}
});
