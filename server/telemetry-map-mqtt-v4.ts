import type {MqttClient} from 'mqtt';
import type {EdgeSource,TelemetryAck} from '../integrations/telemetry.ts';
import {topicFor} from '../integrations/telemetry.ts';
import type {DomainMapV4} from './domain-map-v4.ts';
import {TelemetryMapV4Receiver} from './telemetry-map-v4.ts';
export async function bindTelemetryMapMqttV4(client:MqttClient,store:DomainMapV4,sources:readonly EdgeSource[],options:{beforePublish?:(ack:TelemetryAck)=>Promise<void>;onError?:(error:unknown)=>void;onHandled?:(ack:TelemetryAck|null,receiver:TelemetryMapV4Receiver)=>void}={}){
 const report=(error:unknown)=>{try{if(options.onError)options.onError(error);else console.error('[IDMS v4 telemetry] receive or publish failed; the event remains retryable');}catch{console.error('[IDMS v4 telemetry] error reporter failed');}};
 const receiver=new TelemetryMapV4Receiver(store,sources,async(topic,ack)=>{
  await options.beforePublish?.(ack);
  // Waiting for this callback inside handleMessage deadlocks incoming PUBACK.
  // The DB commit is already confirmed; broker delivery and edge validation are asynchronous.
  client.publish(topic,JSON.stringify(ack),{qos:1,retain:false},error=>{if(error)report(error);});
 });
 client.handleMessage=(packet,done)=>{void receiver.receive(packet.topic,Buffer.from(packet.payload)).then(ack=>options.onHandled?.(ack,receiver)).catch(report).finally(()=>done());};
 await new Promise<void>((ok,no)=>client.subscribe(sources.map(s=>topicFor(s,'telemetry')),{qos:1},(error,grants)=>{if(error)no(error);else if(!grants||grants.length!==sources.length||grants.some(g=>g.qos>=128))no(Error('DOMAIN_MQTT_SUBSCRIBE_DENIED'));else ok();}));
 return receiver;
}
