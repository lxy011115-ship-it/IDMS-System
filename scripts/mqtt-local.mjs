import { randomBytes,randomUUID } from 'node:crypto';
import { mkdir,readFile,access } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import mqtt from 'mqtt';
import { writePrivate } from './keycloak-local.mjs';
const exec=promisify(execFile);
const secret=()=>randomBytes(32).toString('base64url');
export const brokerRoot=join(process.env.LOCALAPPDATA,'IDMS/runtime/mosquitto-2.1.2');
export async function createMqttConfig(directory,{port=1884,statusPort=4014,opcPort=4841,simulatorPort=4015,edgeId='sandbox-edge',tenantId='sandbox'}={}){
  await mkdir(directory,{recursive:true});
  const file=join(directory,'telemetry-runtime.json');let config;
  try{config=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!config){
    const source={edgeId,tenantId,deviceCode:'SIM-CNC-01',origin:'SIMULATOR',mapVersion:'cnc-simulator-1',signingKey:secret(),acknowledgementKey:secret(),statusKey:secret(),statusUrl:`http://127.0.0.1:${statusPort}/status`,points:[['vibration_rms','mm/s'],['bearing_temperature','degC'],['motor_current_std','%']].map(([tagCode,unit])=>({tagCode,nodeId:`ns=1;s=${tagCode}`,unit}))};
    config={version:1,mqtt:{url:`mqtt://127.0.0.1:${port}`,username:'idms-core',password:secret()},sources:[source],edge:{username:edgeId,password:secret(),endpoint:`opc.tcp://127.0.0.1:${opcPort}`,securityMode:'None',securityPolicy:'None',spool:join(directory,'edge-spool.sqlite'),capacity:10000,pollMs:10000},simulator:{port:opcPort,statusPort:simulatorPort,statusKey:secret()}};
    await writePrivate(file,JSON.stringify(config));
  }
  await access(join(brokerRoot,'mosquitto.exe'));
  const passwordFile=join(directory,'mqtt-passwords'),aclFile=join(directory,'mqtt-acl'),brokerFile=join(directory,'mosquitto.conf');
  if(!/^[A-Za-z0-9_-]+$/.test(config.edge.username)||config.sources.length!==1)throw Error('Local broker provisioning only supports one explicitly bound development edge');
  await writePrivate(passwordFile,`${config.mqtt.username}:${config.mqtt.password}\n${config.edge.username}:${config.edge.password}\n`);
  await exec(join(brokerRoot,'mosquitto_passwd.exe'),['-U',passwordFile],{windowsHide:true});
  const s=config.sources[0],topic=`idms/v1/${s.tenantId}/${s.edgeId}`;
  await writePrivate(aclFile,`user ${config.mqtt.username}\ntopic read ${topic}/telemetry\ntopic write ${topic}/ack\nuser ${config.edge.username}\ntopic write ${topic}/telemetry\ntopic read ${topic}/ack\n`);
  const nativePath=p=>p.replaceAll('\\','/');
  await writePrivate(brokerFile,`listener ${new URL(config.mqtt.url).port} 127.0.0.1\nallow_anonymous false\nuse_username_as_clientid false\npassword_file ${nativePath(passwordFile)}\nacl_file ${nativePath(aclFile)}\nmax_packet_size 16384\nmax_queued_messages 200\nmax_inflight_messages 20\nlog_type error\nlog_type warning\npersistence false\n`);
  return {config,file,brokerFile};
}
export async function brokerReady(config){
  return new Promise(resolveReady=>{
    const client=mqtt.connect(config.mqtt.url,{username:config.mqtt.username,password:config.mqtt.password,clientId:'idms-probe-'+randomUUID(),connectTimeout:2000,reconnectPeriod:0,protocolVersion:5});let done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);client.end(true);resolveReady(result);};
    const timer=setTimeout(()=>finish(false),2500);client.once('connect',()=>finish(true));client.on('error',()=>finish(false));
  });
}
export function launchBroker(brokerFile){return spawn(join(brokerRoot,'mosquitto.exe'),['-c',brokerFile],{stdio:['ignore','pipe','pipe'],windowsHide:true});}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const {config,file}=await createMqttConfig(resolve('.local/mqtt'));console.log(`MQTT private configuration prepared: ${file}. Broker ${new URL(config.mqtt.url).host}; no credentials logged.`);}
