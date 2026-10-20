import {createHash} from 'node:crypto';
import {coerceNodeId,NodeIdType} from 'node-opcua-nodeid';
import {stable} from './telemetry.ts';
import {fieldFailure,FieldChannelError} from '../services/field/error.ts';

// Public declarations only. This module must not load files, OPC UA clients,
// certificate stores, or the server catalog dependency graph.
export const fieldProfileVersion='pinned-read-only-opcua-1.0.0' as const;
export const numericDataTypes=['SByte','Byte','Int16','UInt16','Int32','UInt32','Int64','UInt64','Float','Double'] as const;
export type FieldNumericType=typeof numericDataTypes[number];
export interface FieldPoint {tagCode:string;nodeId:string;namespaceUri:string;unit:string;dataType:FieldNumericType;minimum:number;maximum:number}
export function fieldObject(v:unknown,allowed:readonly string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)fieldFailure('FIELD_PROFILE_INVALID');const o=v as Record<string,unknown>;
 if(Object.keys(o).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(o,k)))fieldFailure('FIELD_PROFILE_INVALID');return o;
}
export function fieldText(v:unknown,max:number){if(typeof v!=='string'||!v.length||v.length>max||v.trim()!==v||/[\u0000-\u001f\u007f]/.test(v))fieldFailure('FIELD_PROFILE_INVALID');return v as string;}
export function fieldHash(v:unknown){const s=fieldText(v,64);if(!/^[a-f0-9]{64}$/.test(s))fieldFailure('FIELD_PROFILE_INVALID');return s;}
export function fieldInteger(v:unknown,low:number,high:number){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<low||v>high)fieldFailure('FIELD_PROFILE_INVALID');return v as number;}
export function fieldUri(v:unknown){const s=fieldText(v,256);try{const u=new URL(s);if(!['urn:','http:','https:'].includes(u.protocol)||!u.pathname||u.username||u.password||u.hash||u.search)fieldFailure('FIELD_PROFILE_INVALID');}catch{fieldFailure('FIELD_PROFILE_INVALID');}return s;}
export function freezeFieldValue(o:unknown):void{if(!o||typeof o!=='object'||Object.isFrozen(o))return;for(const v of Object.values(o))freezeFieldValue(v);Object.freeze(o);}
export const fieldSha256=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
export function fieldSource(raw:unknown){const s=fieldObject(raw,['tenantId','edgeId','deviceCode','mapVersion']),source={tenantId:fieldText(s.tenantId,80),edgeId:fieldText(s.edgeId,80),deviceCode:fieldText(s.deviceCode,128),mapVersion:fieldText(s.mapVersion,128)};if(!/^[A-Za-z0-9_-]+$/.test(source.tenantId)||!/^[A-Za-z0-9_-]+$/.test(source.edgeId)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.deviceCode))fieldFailure('FIELD_PROFILE_INVALID');return source;}
export function fieldLimits(raw:unknown){const l=fieldObject(raw,['timeoutMs','cleanupTimeoutMs','maxSampleAgeMs','maxFutureSkewMs']);return {timeoutMs:fieldInteger(l.timeoutMs,250,30000),cleanupTimeoutMs:fieldInteger(l.cleanupTimeoutMs,250,10000),maxSampleAgeMs:fieldInteger(l.maxSampleAgeMs,500,86400000),maxFutureSkewMs:fieldInteger(l.maxFutureSkewMs,0,300000)};}
export function fieldPoints(raw:unknown):FieldPoint[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>128)fieldFailure('FIELD_PROFILE_INVALID');const tags=new Set<string>(),nodes=new Set<string>();
 return raw.map(raw=>{const p=fieldObject(raw,['tagCode','nodeId','namespaceUri','unit','dataType','minimum','maximum']),tagCode=fieldText(p.tagCode,128),nodeId=fieldText(p.nodeId,512),namespaceUri=fieldUri(p.namespaceUri),unit=fieldText(p.unit,64),id=coerceNodeId(nodeId);
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tagCode)||tags.has(tagCode)||nodes.has(nodeId)||id.toString()!==nodeId||![NodeIdType.NUMERIC,NodeIdType.STRING,NodeIdType.GUID].includes(id.identifierType)||!numericDataTypes.includes(p.dataType as FieldNumericType)||typeof p.minimum!=='number'||!Number.isFinite(p.minimum)||typeof p.maximum!=='number'||!Number.isFinite(p.maximum)||p.minimum>=p.maximum||id.namespace===0&&namespaceUri!=='http://opcfoundation.org/UA/')fieldFailure('FIELD_PROFILE_INVALID');tags.add(tagCode);nodes.add(nodeId);return {tagCode,nodeId,namespaceUri,unit,dataType:p.dataType as FieldNumericType,minimum:p.minimum,maximum:p.maximum};
 }).sort((a,b)=>a.tagCode<b.tagCode?-1:a.tagCode>b.tagCode?1:0);
}
export function fieldPublicOpcua(raw:unknown){
 const o=fieldObject(raw,['serverApplicationUri','clientApplicationUri','securityMode','securityPolicy','serverCertificateSha256','clientCertificateSha256','trustMode','revokedCertificateSha256','endpointSha256']);
 if(o.securityMode!=='SignAndEncrypt'||!['Basic256Sha256','Aes256_Sha256_RsaPss'].includes(String(o.securityPolicy))||o.trustMode!=='PINNED_LEAF'||!Array.isArray(o.revokedCertificateSha256)||o.revokedCertificateSha256.length>64)fieldFailure('FIELD_PROFILE_INVALID');
 const result={serverApplicationUri:fieldUri(o.serverApplicationUri),clientApplicationUri:fieldUri(o.clientApplicationUri),securityMode:'SignAndEncrypt' as const,securityPolicy:o.securityPolicy as 'Basic256Sha256'|'Aes256_Sha256_RsaPss',serverCertificateSha256:fieldHash(o.serverCertificateSha256),clientCertificateSha256:fieldHash(o.clientCertificateSha256),trustMode:'PINNED_LEAF' as const,revokedCertificateSha256:o.revokedCertificateSha256.map(fieldHash).sort(),endpointSha256:fieldHash(o.endpointSha256)};
 if(result.serverApplicationUri===result.clientApplicationUri||result.serverCertificateSha256===result.clientCertificateSha256||new Set(result.revokedCertificateSha256).size!==result.revokedCertificateSha256.length)fieldFailure('FIELD_PROFILE_INVALID');return result;
}
export const fieldMqttVersion='mtls-field-mqtt-1.0.0' as const;
export function fieldMqttClientId(source:Pick<ReturnType<typeof fieldSource>,'tenantId'|'edgeId'>,role:'EDGE'|'PLATFORM'){
 return (role==='EDGE'?'idms-field-edge-':'idms-field-platform-')+fieldSha256(stable({tenantId:source.tenantId,edgeId:source.edgeId,role})).slice(0,32);
}
export const fieldMqttTopic=(source:Pick<ReturnType<typeof fieldSource>,'tenantId'|'edgeId'>,kind:'telemetry'|'ack')=>`idms/field/v1/${source.tenantId}/${source.edgeId}/${kind}`;
export function fieldMqttTransport(raw:unknown,source:ReturnType<typeof fieldSource>){
 const t=fieldObject(raw,['format','ruleVersion','brokerUrlSha256','caCertificateSha256','serverCertificateSha256','edgeCertificateSha256','platformCertificateSha256','edgeClientId','platformClientId','eventKeySha256','acknowledgementKeyId','topics','revokedCertificateSha256','maxPacketBytes','trustEvidence']),topics=fieldObject(t.topics,['telemetry','ack']);
 if(t.format!=='idms-field-mqtt-transport-v1'||t.ruleVersion!==fieldMqttVersion||t.maxPacketBytes!==32768||t.trustEvidence!=='SINGLE_APPROVED_CA_CN_ACL_AND_PINNED_SERVER_NO_OCSP'||t.edgeClientId!==fieldMqttClientId(source,'EDGE')||t.platformClientId!==fieldMqttClientId(source,'PLATFORM')||topics.telemetry!==fieldMqttTopic(source,'telemetry')||topics.ack!==fieldMqttTopic(source,'ack')||!Array.isArray(t.revokedCertificateSha256)||t.revokedCertificateSha256.length>64)fieldFailure('FIELD_TRANSPORT_INVALID');
 const pins=['caCertificateSha256','serverCertificateSha256','edgeCertificateSha256','platformCertificateSha256'] as const,parsed=Object.fromEntries(pins.map(k=>[k,fieldHash(t[k])])) as Record<typeof pins[number],string>,revokedCertificateSha256=t.revokedCertificateSha256.map(fieldHash).sort();
 if(new Set(Object.values(parsed)).size!==4||new Set(revokedCertificateSha256).size!==revokedCertificateSha256.length)fieldFailure('FIELD_TRANSPORT_INVALID');
 const result={format:'idms-field-mqtt-transport-v1' as const,ruleVersion:fieldMqttVersion,brokerUrlSha256:fieldHash(t.brokerUrlSha256),...parsed,edgeClientId:t.edgeClientId as string,platformClientId:t.platformClientId as string,eventKeySha256:fieldHash(t.eventKeySha256),acknowledgementKeyId:fieldHash(t.acknowledgementKeyId),topics:{telemetry:topics.telemetry as string,ack:topics.ack as string},revokedCertificateSha256,maxPacketBytes:32768 as const,trustEvidence:'SINGLE_APPROVED_CA_CN_ACL_AND_PINNED_SERVER_NO_OCSP' as const};freezeFieldValue(result);return result;
}
export type FieldMqttTransport=ReturnType<typeof fieldMqttTransport>;
export function parsePublicFieldProfile(raw:unknown){
 try{const complete=(raw as any)?.format==='idms-field-channel-public-profile-v2',p=fieldObject(raw,['format','ruleVersion','source','opcua','userTokenType','userIdentitySha256','limits','points','unitEvidence','trustEvidence','fieldCommissioned',...(complete?['transport']:[])]);
  if(p.format!==(complete?'idms-field-channel-public-profile-v2':'idms-field-channel-public-profile-v1')||p.ruleVersion!==fieldProfileVersion||!['Anonymous','UserName'].includes(String(p.userTokenType))||p.unitEvidence!=='DECLARED_MAP_NOT_AUTOMATIC_PHYSICAL_UNIT_VERIFICATION'||p.trustEvidence!=='EXPLICIT_LEAF_PIN_NOT_CA_PATH_OR_ONLINE_OCSP'||p.fieldCommissioned!==false)fieldFailure('FIELD_PROFILE_INVALID');
  const s=fieldObject(p.source,['tenantId','edgeId','deviceCode','mapVersion','origin']),{origin,...identity}=s;if(origin!=='FIELD')fieldFailure('FIELD_PROFILE_INVALID');
  const result={format:(complete?'idms-field-channel-public-profile-v2':'idms-field-channel-public-profile-v1') as 'idms-field-channel-public-profile-v1'|'idms-field-channel-public-profile-v2',...(complete?{transport:fieldMqttTransport(p.transport,fieldSource(identity))}:{}),ruleVersion:fieldProfileVersion,source:{...fieldSource(identity),origin:'FIELD' as const},opcua:fieldPublicOpcua(p.opcua),userTokenType:p.userTokenType as 'Anonymous'|'UserName',userIdentitySha256:fieldHash(p.userIdentitySha256),limits:fieldLimits(p.limits),points:fieldPoints(p.points),unitEvidence:'DECLARED_MAP_NOT_AUTOMATIC_PHYSICAL_UNIT_VERIFICATION' as const,trustEvidence:'EXPLICIT_LEAF_PIN_NOT_CA_PATH_OR_ONLINE_OCSP' as const,fieldCommissioned:false as const};
  if(result.transport&&new Set([result.opcua.serverCertificateSha256,result.opcua.clientCertificateSha256,result.transport.caCertificateSha256,result.transport.serverCertificateSha256,result.transport.edgeCertificateSha256,result.transport.platformCertificateSha256]).size!==6)fieldFailure('FIELD_TRANSPORT_INVALID');freezeFieldValue(result);return result;
 }catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_PROFILE_INVALID');}
}
export type PublicFieldProfile=ReturnType<typeof parsePublicFieldProfile>;
export const publicFieldProfileDigest=(raw:unknown)=>fieldSha256(stable(parsePublicFieldProfile(raw)));
