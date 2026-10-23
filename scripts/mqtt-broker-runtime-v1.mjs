import {lstat,readFile,realpath,readdir} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createHash,X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {exploreCertificate} from 'node-opcua-crypto';
import {fieldCertificateDer} from '../services/field/certificate-bytes.ts';
import {fieldMqttClientId,fieldMqttTopic} from '../integrations/field-profile.ts';

export const mqttBrokerHashV1=bytes=>createHash('sha256').update(bytes).digest('hex');
export const mqttBrokerNeedV1=(value,code)=>{if(!value)throw Error(code);};
const need=mqttBrokerNeedV1;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const normal=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const path=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&isAbsolute(value)&&!/[\x00-\x1f\x7f"#]/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);

export function mqttBrokerRuntimeV1(value){
  need(exact(value,['format','purpose','toolingDirectory','host','port','server','probe','channels'])&&value.format===1&&value.purpose==='MQTT_BROKER_SERVICE_V1','MQTT_BROKER_CONFIG_FIELDS');
  need(value.host==='127.0.0.1'&&Number.isInteger(value.port)&&value.port>1024&&value.port<=65535,'MQTT_BROKER_CONFIG_ENDPOINT');
  need(path(value.toolingDirectory)&&exact(value.server,['caFile','certificateFile','keyFile'])&&Object.values(value.server).every(path),'MQTT_BROKER_CONFIG_SERVER');
  need(exact(value.probe,['clientId','certificateFile','keyFile'])&&/^idms-broker-probe-[a-f0-9]{16,32}$/.test(value.probe.clientId)&&path(value.probe.certificateFile)&&path(value.probe.keyFile),'MQTT_BROKER_CONFIG_PROBE');
  need(Array.isArray(value.channels)&&value.channels.length>0&&value.channels.length<=64,'MQTT_BROKER_CONFIG_CHANNELS');const seen=new Set();
  for(const channel of value.channels){need(exact(channel,['tenantId','edgeId'])&&id(channel.tenantId)&&id(channel.edgeId),'MQTT_BROKER_CONFIG_CHANNEL');const key=channel.tenantId+'/'+channel.edgeId;need(!seen.has(key),'MQTT_BROKER_CONFIG_DUPLICATE');seen.add(key);}
  return structuredClone(value);
}

export async function readMqttBrokerFileV1(file,max=2*1024**2){
  need(path(resolve(file)),'MQTT_BROKER_FILE_PATH');const name=resolve(file),before=await lstat(name);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=max&&normal(await realpath(name))===normal(name),'MQTT_BROKER_FILE');
  const bytes=await readFile(name),after=await lstat(name);
  need(after.isFile()&&!after.isSymbolicLink()&&after.nlink===1&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'MQTT_BROKER_FILE_CHANGED');
  return {path:name,bytes,sha256:mqttBrokerHashV1(bytes)};
}

function certificate(bytes,ca,now){
  const der=fieldCertificateDer(bytes),x=new X509Certificate(der),parsed=exploreCertificate(der),ext=parsed.tbsCertificate.extensions;
  need(Number.isSafeInteger(now)&&Date.parse(x.validFrom)<=now&&Date.parse(x.validTo)>now,'MQTT_BROKER_CERTIFICATE_TIME');
  need(x.publicKey.asymmetricKeyType==='rsa'&&x.publicKey.asymmetricKeyDetails?.publicExponent===65537n&&(x.publicKey.asymmetricKeyDetails.modulusLength>=2048&&x.publicKey.asymmetricKeyDetails.modulusLength<=4096),'MQTT_BROKER_CERTIFICATE_KEY');
  need(['sha256WithRSAEncryption','sha384WithRSAEncryption','sha512WithRSAEncryption','RSA-SHA256','RSA-SHA384','RSA-SHA512','1.2.840.113549.1.1.11','1.2.840.113549.1.1.12','1.2.840.113549.1.1.13'].includes(parsed.signatureAlgorithm.identifier),'MQTT_BROKER_CERTIFICATE_SIGNATURE');
  need(ca?x.ca&&ext?.basicConstraints?.cA&&ext.keyUsage?.keyCertSign&&ext.keyUsage.cRLSign&&x.issuer===x.subject&&x.verify(x.publicKey):!x.ca&&!ext?.basicConstraints?.cA&&ext?.keyUsage?.digitalSignature&&ext.keyUsage.keyEncipherment&&!ext.keyUsage.keyCertSign,'MQTT_BROKER_CERTIFICATE_USAGE');
  return {x,ext,subject:parsed.tbsCertificate.subject,der};
}

export function mqttBrokerMaterialsV1(config,bytes,now=Date.now()){
  try{
    const ca=certificate(bytes.ca,true,now),server=certificate(bytes.server,false,now),probe=certificate(bytes.probe,false,now);
    for(const leaf of [server,probe])need(leaf.x.checkIssued(ca.x)&&leaf.x.verify(ca.x.publicKey)&&Date.parse(leaf.x.validFrom)>=Date.parse(ca.x.validFrom)&&Date.parse(leaf.x.validTo)<=Date.parse(ca.x.validTo),'MQTT_BROKER_CERTIFICATE_ISSUER');
    need(server.ext.extKeyUsage?.serverAuth&&!server.ext.extKeyUsage?.clientAuth&&server.x.checkIP('127.0.0.1')==='127.0.0.1','MQTT_BROKER_CERTIFICATE_SERVER');
    need(probe.ext.extKeyUsage?.clientAuth&&!probe.ext.extKeyUsage?.serverAuth&&probe.subject.entries.filter(entry=>entry.oid==='2.5.4.3').length===1&&probe.subject.commonName===config.probe.clientId,'MQTT_BROKER_CERTIFICATE_PROBE');
    for(const[leaf,key]of [[server,bytes.serverKey],[probe,bytes.probeKey]]){
      const privateKey=createPrivateKey(key),publicKey=createPublicKey(privateKey).export({type:'spki',format:'der'});
      need(publicKey.equals(leaf.x.publicKey.export({type:'spki',format:'der'})),'MQTT_BROKER_CERTIFICATE_KEY_MISMATCH');
    }
    return {serverCertificateSha256:mqttBrokerHashV1(server.der),caCertificateSha256:mqttBrokerHashV1(ca.der),probeCertificateSha256:mqttBrokerHashV1(probe.der),notAfter:Math.min(...[ca,server,probe].map(item=>Date.parse(item.x.validTo)))};
  }catch(error){throw Error(/^MQTT_BROKER_[A-Z_]+$/.test(error.message)?error.message:'MQTT_BROKER_MATERIAL_INVALID');}
}

export async function inspectMqttBrokerRuntimeV1(file){
  let item,config;
  try{item=await readMqttBrokerFileV1(file,65536);config=mqttBrokerRuntimeV1(JSON.parse(item.bytes.toString('utf8')));}catch(error){throw Error(/^MQTT_BROKER_CONFIG_[A-Z_]+$/.test(error.message)?error.message:'MQTT_BROKER_RUNTIME_READ');}
  const materialPaths={ca:config.server.caFile,server:config.server.certificateFile,serverKey:config.server.keyFile,probe:config.probe.certificateFile,probeKey:config.probe.keyFile},pins=new Map([[normal(item.path),{path:item.path,sha256:item.sha256}]]),materials={};
  for(const[name,path]of Object.entries(materialPaths)){const entry=await readMqttBrokerFileV1(path,65536);materials[name]=entry.bytes;pins.set(normal(entry.path),{path:entry.path,sha256:entry.sha256});}
  const materialBinding=mqttBrokerMaterialsV1(config,materials),directory=resolve(config.toolingDirectory),stat=await lstat(directory);
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&normal(await realpath(directory))===normal(directory),'MQTT_BROKER_TOOLING_DIRECTORY');
  const program=join(directory,process.platform==='win32'?'mosquitto.exe':'mosquitto');
  const programFiles=[program];
  if(process.platform==='win32')for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.name.toLowerCase().endsWith('.dll')){need(entry.isFile()&&!entry.isSymbolicLink(),'MQTT_BROKER_TOOLING_FILE');programFiles.push(join(directory,entry.name));}
  for(const name of programFiles){const entry=await readMqttBrokerFileV1(name,32*1024**2);pins.set(normal(entry.path),{path:entry.path,sha256:entry.sha256});}
  return {config,runtime:{path:item.path,sha256:item.sha256},program,pins:[...pins.values()],materials,materialBinding};
}

/** Generated directives only: no include, user-supplied plugins, commands or arbitrary ACL fragments. */
export function mqttBrokerFilesV1(config,{owner,aclFile}){
  config=mqttBrokerRuntimeV1(config);need(typeof owner==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner)&&path(aclFile),'MQTT_BROKER_GENERATION_BINDING');
  const native=file=>file.replaceAll('\\','/'),probeTopic='idms/control/'+owner+'/health';
  const blocks=[`user ${config.probe.clientId}\ntopic readwrite ${probeTopic}`];
  for(const channel of config.channels)blocks.push(`user ${fieldMqttClientId(channel,'EDGE')}\ntopic write ${fieldMqttTopic(channel,'telemetry')}\ntopic read ${fieldMqttTopic(channel,'ack')}`,`user ${fieldMqttClientId(channel,'PLATFORM')}\ntopic read ${fieldMqttTopic(channel,'telemetry')}\ntopic write ${fieldMqttTopic(channel,'ack')}`);
  const directives=[`listener ${config.port} 127.0.0.1`,'allow_anonymous false','require_certificate true','use_identity_as_username true','use_username_as_clientid true',`cafile ${native(config.server.caFile)}`,`certfile ${native(config.server.certificateFile)}`,`keyfile ${native(config.server.keyFile)}`,`acl_file ${native(aclFile)}`,'max_qos 1','retain_available false','max_packet_size 32768','max_queued_messages 20','max_inflight_messages 1','persistence false','log_dest stderr','log_type error','log_type warning','log_type notice'];
  return {configuration:directives.join('\n')+'\n',acl:blocks.join('\n')+'\n',probeTopic};
}

export async function assertMqttBrokerPinsV1(pins){for(const pin of pins)need((await readMqttBrokerFileV1(pin.path,32*1024**2)).sha256===pin.sha256,'MQTT_BROKER_INPUT_CHANGED');}
