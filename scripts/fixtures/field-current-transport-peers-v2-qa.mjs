import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical} from '../../server/imports.ts';
import {publicFieldProfileDigest,parsePublicFieldProfile,fieldSha256} from '../../integrations/field-profile.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
import {launchMqttBrokerLifecycleV4,bindMqttBrokerLifecycleV4,stopMqttBrokerLifecycleV4} from '../mqtt-broker-lifecycle-v4.mjs';
import {createFieldMapSiteOpcuaQaV2} from './field-map-site-opcua-v2-qa.mjs';
/** QA connection address is separate from its public profile's authenticated digest. */
export function fieldCurrentTransportEndpointQaV2(source){
 try{
  assert(source?.format==='FIELD_REVIEW_TRANSPORT_SOURCE_QA_V1'&&source.controlledQaSourceOnly===true&&source.physicalDeviceAttestation===false);
  const profile=parsePublicFieldProfile(source.profile);assert(typeof source.opcuaEndpoint==='string'&&source.opcuaEndpoint.length<=4096&&fieldSha256(source.opcuaEndpoint)===profile.opcua.endpointSha256);
  const endpoint=new URL(source.opcuaEndpoint);assert(endpoint.protocol==='opc.tcp:'&&endpoint.hostname==='127.0.0.1'&&endpoint.pathname==='/fieldqa'&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash&&Number.isInteger(Number(endpoint.port))&&Number(endpoint.port)>=1024&&Number(endpoint.port)<=65535&&endpoint.href===source.opcuaEndpoint);return endpoint;
 }catch{throw Object.assign(Error('FIELD_CURRENT_QA_ENDPOINT_BINDING'),{code:'FIELD_CURRENT_QA_ENDPOINT_BINDING'});}
}
/** New controlled QA peers; no normal field client or business SITE is started. */
export async function startFieldCurrentTransportPeersQaV2({source,files,workDirectory}){
 assert(source?.format==='FIELD_REVIEW_TRANSPORT_SOURCE_QA_V1'&&source.controlledQaSourceOnly&&!source.physicalDeviceAttestation);
 const endpoint=fieldCurrentTransportEndpointQaV2(source);
 assert(source.serverCertificate.sha256===source.profile.opcua.serverCertificateSha256&&source.clientCertificate.sha256===source.profile.opcua.clientCertificateSha256);
 const descriptor=JSON.parse(await readFile(files.configurationFile,'utf8'));assert(descriptor.brokerRuntimeFile&&descriptor.tenantMaterials.length===1);
 const directory=join(workDirectory,'controlled-transport-peers');await privateDirectory(directory);let broker,opc,terminal,closeJob;
 const close=()=>closeJob??=(async()=>{const errors=[];const requests=structuredClone(opc?.state.requests??{});let opcShutdown=false,brokerStop=null;
 try{if(opc){await opc.close();opcShutdown=true;}}catch{errors.push('FIELD_REVIEW_OPCUA_CLOSE');}
 try{if(broker)brokerStop=await stopMqttBrokerLifecycleV4(broker);}catch{errors.push('FIELD_REVIEW_BROKER_CLOSE');}
 terminal={format:'FIELD_CURRENT_TRANSPORT_PEERS_TERMINAL_QA_V1',directory,controlledQaPeersOnly:true,physicalDeviceAttestation:false,originalInProcessOpcuaShutdownCompleted:opcShutdown,opcuaRequests:requests,brokerDirectory:broker?.directory??null,brokerStop,cleanupErrors:errors};await privateNewFile(join(directory,'terminal.private.json'),canonical(terminal));assert.deepEqual(errors,[]);return terminal;})();
 try{
  broker=await launchMqttBrokerLifecycleV4({runtimeFile:descriptor.brokerRuntimeFile,workDirectory:directory});await bindMqttBrokerLifecycleV4(broker);
  opc=await createFieldMapSiteOpcuaQaV2({points:source.profile.points,serverCertificate:source.serverCertificate,clientCertificate:source.clientCertificate,port:Number(endpoint.port)});
  assert.equal(opc.profile.opcua.endpoint,source.opcuaEndpoint);assert.equal(opc.profile.opcua.serverCertificateSha256,source.profile.opcua.serverCertificateSha256);assert.deepEqual(opc.profile.points,source.profile.points);
  return Object.freeze({directory,profileDigest:publicFieldProfileDigest(source.profile),close});
 }catch(error){await close();throw error;}
}
