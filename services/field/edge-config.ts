import {dirname,resolve} from 'node:path';
import {createPublicKey,type KeyObject} from 'node:crypto';
import {fieldObject,fieldText,fieldInteger,fieldSha256} from '../../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../../integrations/field-lease.ts';
import {fieldEventMaxBytes} from '../../integrations/field-event.ts';
import {parseFieldProfile,publicFieldProfile,readBoundedFieldFile,readFieldMaterial,type FieldProfile} from './profile.ts';
import {loadFieldMaterials,type FieldMaterials} from './certificates.ts';
import {loadFieldMqttMaterials,type FieldMqttMaterials} from './mqtt-materials.ts';
import {fieldFailure} from './error.ts';

export interface FieldEdgeConfiguration {
 root:string;profile:Readonly<FieldProfile>;publicProfile:ReturnType<typeof publicFieldProfile>;opcua:FieldMaterials;
 lease:{url:string;requestKey:Buffer;publicKey:KeyObject;timeoutMs:number;renewBeforeMs:number};eventKey:Buffer;mqtt:{url:string;materials:FieldMqttMaterials};
 spool:{directory:string;capacity:number;maxBytes:number;maxStreams:number};
 schedule:{sampleIntervalMs:number;retryMs:number;ackTimeoutMs:number;batchLimit:number;onceTimeoutMs:number;retryBackoffMs:number};
}
export function fieldEdgeDirectoryName(raw:unknown){const name=fieldText(raw,256);if(name.split('/').some(p=>!p||p==='.'||p==='..'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(p)||/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)||/[. ]$/.test(p)))fieldFailure('FIELD_EDGE_CONFIG_INVALID');return name;}
const parse=(b:Buffer)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
export function clearFieldEdgeConfiguration(c:FieldEdgeConfiguration){c.lease.requestKey.fill(0);c.eventKey.fill(0);c.opcua.privateKeyPem.fill(0);c.opcua.password=undefined;c.mqtt.materials.privateKeyPem.fill(0);}
export async function loadFieldEdgeConfiguration(path:string):Promise<FieldEdgeConfiguration>{
 let requestKey:Buffer|undefined,eventKey:Buffer|undefined,opcua:FieldMaterials|undefined,mqtt:FieldEdgeConfiguration['mqtt']|undefined;
 try{
  const r=fieldObject(parse(await readBoundedFieldFile(path,262144)),['format','profileFile','lease','eventKeyFile','mqtt','spool','schedule']),root=dirname(resolve(path));if(r.format!=='idms-field-edge-config-v1')throw Error();
  const profile=parseFieldProfile(parse(await readFieldMaterial(root,fieldText(r.profileFile,256),131072))),publicProfile=publicFieldProfile(profile);if(profile.format!=='idms-field-channel-profile-v2'||!publicProfile.transport)throw Error();
  const l=fieldObject(r.lease,['url','requestKeyFile','platformPublicKeyFile','timeoutMs','renewBeforeMs']),url=new URL(fieldText(l.url,2048));if(!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/api/v1/field-channel/lease')throw Error();
  requestKey=await readFieldMaterial(root,fieldText(l.requestKeyFile,256),32);eventKey=await readFieldMaterial(root,fieldText(r.eventKeyFile,256),32);if(requestKey.length!==32||eventKey.length!==32||requestKey.every(b=>b===0)||eventKey.every(b=>b===0)||requestKey.equals(eventKey)||fieldSha256(eventKey)!==publicProfile.transport.eventKeySha256)throw Error();
  const pem=await readFieldMaterial(root,fieldText(l.platformPublicKeyFile,256),16384);if(!/^\s*-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem.toString('utf8')))throw Error();const publicKey=createPublicKey(pem);if(publicKey.asymmetricKeyType!=='ed25519'||fieldLeaseKeyId(publicKey)!==publicProfile.transport.acknowledgementKeyId)throw Error();
  const lease={url:url.toString(),requestKey,publicKey,timeoutMs:fieldInteger(l.timeoutMs,250,10000),renewBeforeMs:fieldInteger(l.renewBeforeMs,0,10000)},s=fieldObject(r.spool,['directory','capacity','maxBytes','maxStreams']),spool={directory:fieldEdgeDirectoryName(s.directory),capacity:fieldInteger(s.capacity,profile.points.length,10000),maxBytes:fieldInteger(s.maxBytes,Math.max(65536,profile.points.length*fieldEventMaxBytes),268435456),maxStreams:fieldInteger(s.maxStreams,1,64)};
  const q=fieldObject(r.schedule,['sampleIntervalMs','retryMs','ackTimeoutMs','batchLimit','onceTimeoutMs','retryBackoffMs']),schedule={sampleIntervalMs:fieldInteger(q.sampleIntervalMs,500,3600000),retryMs:fieldInteger(q.retryMs,100,60000),ackTimeoutMs:fieldInteger(q.ackTimeoutMs,250,10000),batchLimit:fieldInteger(q.batchLimit,1,100),onceTimeoutMs:fieldInteger(q.onceTimeoutMs,1000,300000),retryBackoffMs:fieldInteger(q.retryBackoffMs,1000,30000)};
  opcua=await loadFieldMaterials(root,profile);mqtt=await loadFieldMqttMaterials(root,r.mqtt,publicProfile,'EDGE');return {root,profile,publicProfile,opcua,lease,eventKey,mqtt,spool,schedule};
 }catch{requestKey?.fill(0);eventKey?.fill(0);opcua?.privateKeyPem.fill(0);if(opcua)opcua.password=undefined;mqtt?.materials.privateKeyPem.fill(0);fieldFailure('FIELD_EDGE_CONFIG_INVALID');}
}
