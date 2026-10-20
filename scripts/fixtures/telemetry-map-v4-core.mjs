import {readFile} from 'node:fs/promises';
import mqtt from 'mqtt';
import {DomainMapV4} from '../../server/domain-map-v4.ts';
import {telemetryReceiptKey} from '../../server/telemetry-map-v4.ts';
import {bindTelemetryMapMqttV4} from '../../server/telemetry-map-mqtt-v4.ts';
import {topicFor} from '../../integrations/telemetry.ts';
const cfg=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!/^idms_v4qa_[a-f0-9]{12}_sandbox_map$/.test(cfg.account.database)||!process.send)throw Error('Owned v4 QA core required');
const RealDate=Date;let clock=cfg.clock;
globalThis.Date=class extends RealDate{constructor(...args){if(args.length)super(...args);else super(clock);}static now(){return clock;}};
const store=new DomainMapV4(cfg.account,cfg.binding),client=mqtt.connect(cfg.mqtt.url,{username:cfg.mqtt.username,password:cfg.mqtt.password,clientId:'v4-child-'+process.pid,protocolVersion:5,reconnectPeriod:0,connectTimeout:3000}),errors=[];
client.on('error',e=>errors.push(e.message));await new Promise((ok,no)=>{client.once('connect',ok);client.once('error',no);});
let pending=0;const receiver=await bindTelemetryMapMqttV4(client,store,[cfg.source],{beforePublish:async ack=>{
 const s=await store.snapshot();try{const r=await s.get('receipt',telemetryReceiptKey(ack.edgeId,ack.eventId,ack.digest));if(ack.status==='STORED'&&r.receipt.status!=='STORED')throw Error('QA ACK before stored proof');}finally{await s.close();}
},onHandled:(ack,r)=>process.send?.({type:'HANDLED',pid:process.pid,eventId:ack?.eventId,status:ack?.status,stats:r.lastReadStats}),onError:e=>{process.send?.({type:'FAILED',pid:process.pid,error:e.message});errors.push(e.message);}});process.send({type:'READY',pid:process.pid});
process.on('message',message=>{if(message.type==='CLOCK'){clock=message.at;process.send?.({type:'CLOCK_SET',at:clock});}else if(message.type==='STOP'){void new Promise(ok=>client.end(true,{},ok)).then(()=>{globalThis.Date=RealDate;process.send?.({type:'STOPPED',pid:process.pid,errors});process.disconnect();});}});
