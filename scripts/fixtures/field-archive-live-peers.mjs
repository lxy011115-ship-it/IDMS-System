import {resolve,basename} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createFieldOpcuaServer} from './field-opcua-server.mjs';
import {fieldMqttCertificateFixture} from './field-mqtt-fixture.mjs';
import {createFieldMqttBroker} from './field-mqtt-broker.mjs';
import {writePrivate} from '../keycloak-local.mjs';
// Real loopback peers kept by the archive QA parent, so they survive the seed,
// source freeze, archive, restore, independent approval and activation workers.
export async function createArchiveLivePeers(directory,source){
 if(!/^formal-archive-[a-f0-9]{10}$/.test(basename(directory)))throw Error('Owned archive peer workspace required');let opc,broker;
 const close=async()=>{await broker?.close();await opc?.close();};
 try{
  const password='owned-archive-'+randomBytes(24).toString('base64url');opc=await createFieldOpcuaServer({userIdentity:{userName:'owned-archive-reader',password}});
  const mqtt=await fieldMqttCertificateFixture(source,{directory:resolve(directory,'peer-mqtt')});broker=await createFieldMqttBroker(mqtt);
  const points=source.points.map((p,i)=>({...opc.point(i===0?'pressure':'native-Double'),tagCode:p.tagCode,unit:p.unit})),mapped={...source,points:source.points.map((p,i)=>({...p,nodeId:points[i].nodeId}))},profile={...opc.profile,format:'idms-field-channel-profile-v2',source:{tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion},certificates:{serverFile:'live-server.der',clientFile:'live-client.der',privateKeyFile:'live-client-key.pem'},userIdentity:{type:'UserName',userName:'owned-archive-reader',passwordFile:'live-opc-password.txt'},points,transport:mqtt.declaration(broker.url)};
  for(const [name,bytes]of [['live-server.der',opc.materials.serverCertificate],['live-client.der',opc.materials.clientCertificate],['live-client-key.pem',opc.materials.privateKeyPem],['live-opc-password.txt',password],['live-event.bin',mqtt.eventKey]])await writePrivate(resolve(directory,name),bytes);
  const transport=role=>({url:broker.url,caFile:'peer-mqtt/ca.pem',serverCertificateFile:'peer-mqtt/broker.pem',clientCertificateFile:'peer-mqtt/'+(role==='EDGE'?'edge.pem':'platform.pem'),privateKeyFile:'peer-mqtt/'+(role==='EDGE'?'edge.key':'platform.key')});
  return {source:mapped,configuration:{profileSeed:profile,eventKeyFile:resolve(directory,'live-event.bin'),edgeMqtt:transport('EDGE'),platformMqtt:transport('PLATFORM')},state:()=>({actualLiveOpcuaReadRequests:opc.state.requests.ReadRequest||0,writeRequests:opc.state.requests.WriteRequest||0,callRequests:opc.state.requests.CallRequest||0}),close};
 }catch(e){await close();throw e;}
}
