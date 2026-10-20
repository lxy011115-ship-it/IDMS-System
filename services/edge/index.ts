import { readFile,mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import mqtt from 'mqtt';
import { OPCUAClient,AttributeIds,MessageSecurityMode,SecurityPolicy,type ClientSession } from 'node-opcua';
import { topicFor,type EdgeSource,type Quality } from '../../integrations/telemetry.ts';
import { EdgeSpool } from './spool.ts';
const config=JSON.parse(await readFile(process.env.IDMS_TELEMETRY_CONFIG||'.local/mqtt/telemetry-runtime.json','utf8'));
const source:EdgeSource=config.sources.find((s:EdgeSource)=>s.edgeId===(process.env.IDMS_EDGE_ID||config.sources[0].edgeId));
if(!source)throw Error('Unknown edge identity');
const edge=config.edge,endpoint=new URL(edge.endpoint),local=['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname);
if(source.origin!=='SIMULATOR'||!local||edge.securityMode!=='None')throw Error('Field acquisition is disabled pending trusted certificate and point-map commissioning; only loopback simulator is allowed');
if(!['mqtt:','mqtts:'].includes(new URL(config.mqtt.url).protocol))throw Error('Invalid MQTT transport');
if(new URL(config.mqtt.url).protocol!=='mqtts:'&&!['127.0.0.1','localhost','[::1]'].includes(new URL(config.mqtt.url).hostname))throw Error('Remote MQTT requires TLS');
const statusUrl=new URL(source.statusUrl);if(statusUrl.hostname!=='127.0.0.1'||statusUrl.protocol!=='http:')throw Error('Edge status must use loopback');
await mkdir(dirname(edge.spool),{recursive:true});
const spool=new EdgeSpool(edge.spool,source,edge.capacity);
let mqttConnected=false,opcConnected=false,capturing=false,lastSample:string|null=null,lastError:string|null=null,gaps=0,closing=false,session:ClientSession|undefined;
// Status listener doubles as a single-instance guard before any broker/OPC side effects.
const status=createServer((req,res)=>{
  const token=String(req.headers.authorization||''),expected='Bearer '+source.statusKey;
  if(req.url!=='/status'||token.length!==expected.length||!timingSafeEqual(Buffer.from(token),Buffer.from(expected))){res.writeHead(403);res.end();return;}
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({edgeId:source.edgeId,tenantId:source.tenantId,origin:source.origin,mode:'READ_ONLY_POLL',mqttConnected,opcConnected,lastSample,lastError,gaps,...spool.stats()}));
});
await new Promise<void>((resolve,reject)=>{status.once('error',reject);status.listen(Number(statusUrl.port),'127.0.0.1',resolve);});
const mqttClient=mqtt.connect(config.mqtt.url,{username:edge.username,password:edge.password,clientId:edge.username,protocolVersion:5,clean:true,reconnectPeriod:1000,connectTimeout:3000,queueQoSZero:false,properties:{maximumPacketSize:16384,receiveMaximum:20}});
mqttClient.on('connect',()=>{mqttConnected=true;mqttClient.subscribe(topicFor(source,'ack'),{qos:1},err=>{if(err)lastError='MQTT_ACK_SUBSCRIBE_FAILED';});});
mqttClient.on('close',()=>{mqttConnected=false;});mqttClient.on('error',()=>{lastError='MQTT_CONNECTION_ERROR';});
mqttClient.on('message',(topic,bytes)=>{if(topic!==topicFor(source,'ack')||bytes.length>8192)return;try{spool.acknowledge(JSON.parse(bytes.toString()));}catch{lastError='ACK_INVALID';}});
const opc=OPCUAClient.create({endpointMustExist:false,securityMode:MessageSecurityMode.None,securityPolicy:SecurityPolicy.None,connectionStrategy:{initialDelay:500,maxDelay:2000,maxRetry:0},keepSessionAlive:true,clientName:'IDMS read-only simulator edge'});
opc.on('connection_lost',()=>{opcConnected=false;});
async function capture(){
  if(closing||capturing)return;capturing=true;
  try{
    if(!session){await opc.connect(edge.endpoint);session=await opc.createSession();opcConnected=true;}
    const values=await session.read(source.points.map(p=>({nodeId:p.nodeId,attributeId:AttributeIds.Value})),0);
    for(let i=0;i<values.length;i++){
      const value=values[i],point=source.points[i];
      if(!value.sourceTimestamp){gaps++;lastError='SOURCE_TIMESTAMP_MISSING';continue;}
      const severity=value.statusCode.value>>>30,quality:Quality=severity===0?'GOOD':severity===1?'UNCERTAIN':'BAD';
      const numeric=typeof value.value?.value==='number'&&Number.isFinite(value.value.value)?value.value.value:null;
      spool.append({tagCode:point.tagCode,nodeId:point.nodeId,unit:point.unit,eventTime:value.sourceTimestamp.toISOString(),value:numeric,quality:numeric===null?'BAD':quality});lastSample=value.sourceTimestamp.toISOString();
    }
    if(!lastError?.startsWith('SPOOL'))lastError=null;
  }catch(e){
    if(e instanceof Error&&e.message==='SPOOL_CAPACITY_REACHED'){lastError='SPOOL_CAPACITY_REACHED';gaps++;}
    else {lastError='OPC_READ_FAILED';opcConnected=false;gaps++;try{await session?.close();}catch{}session=undefined;try{await opc.disconnect();}catch{}}
  }finally{capturing=false;}
}
const captureTimer=setInterval(()=>void capture(),Math.max(100,Number(edge.pollMs)||10000));
const publishTimer=setInterval(()=>{
  if(!mqttConnected||closing)return;
  for(const record of spool.ready(20,2000)){spool.attempted(record.event_id);mqttClient.publish(topicFor(source,'telemetry'),record.payload,{qos:1,retain:false},err=>{if(err)lastError='MQTT_PUBLISH_FAILED';});}
},250);
void capture();
console.log(`Edge ${source.edgeId}: read-only ${source.origin}, durable SQLite spool, signed platform acknowledgements.`);
for(const sig of ['SIGINT','SIGTERM'] as const)process.once(sig,async()=>{closing=true;clearInterval(captureTimer);clearInterval(publishTimer);status.close();mqttClient.end(true);try{await session?.close();await opc.disconnect();}catch{}spool.close();process.exit(0);});
