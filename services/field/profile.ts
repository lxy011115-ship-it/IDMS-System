import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {stable} from '../../integrations/telemetry.ts';
import {fieldFailure,FieldChannelError} from './error.ts';

import {fieldProfileVersion,fieldObject as object,fieldText as text,fieldHash as hash,fieldUri as uri,freezeFieldValue as deepFreeze,fieldSource,fieldLimits,fieldPoints,fieldSha256,parsePublicFieldProfile,type FieldPoint,fieldMqttTransport,type FieldMqttTransport} from '../../integrations/field-profile.ts';
export {fieldProfileVersion,numericDataTypes,fieldSha256} from '../../integrations/field-profile.ts';
export type {FieldNumericType,FieldPoint} from '../../integrations/field-profile.ts';
export interface FieldProfile {
 format:'idms-field-channel-profile-v1'|'idms-field-channel-profile-v2';transport?:FieldMqttTransport;
 source:{tenantId:string;edgeId:string;deviceCode:string;mapVersion:string};
 opcua:{endpoint:string;serverApplicationUri:string;clientApplicationUri:string;securityMode:'SignAndEncrypt';securityPolicy:'Basic256Sha256'|'Aes256_Sha256_RsaPss';serverCertificateSha256:string;clientCertificateSha256:string;trustMode:'PINNED_LEAF';revokedCertificateSha256:string[]};
 certificates:{serverFile:string;clientFile:string;privateKeyFile:string};
 userIdentity:{type:'Anonymous'}|{type:'UserName';userName:string;passwordFile:string};
 limits:{timeoutMs:number;cleanupTimeoutMs:number;maxSampleAgeMs:number;maxFutureSkewMs:number};points:FieldPoint[];
}
function file(v:unknown){const s=text(v,256);if(isAbsolute(s)||s.includes('\\')||s.includes(':')||s.split('/').some(p=>!p||p==='.'||p==='..'||/[<>"|?*]/.test(p)))fieldFailure('FIELD_PROFILE_INVALID');return s;}
export function parseFieldProfile(raw:unknown):Readonly<FieldProfile>{
 try{
  const complete=(raw as any)?.format==='idms-field-channel-profile-v2',p=object(raw,['format','source','opcua','certificates','userIdentity','limits','points',...(complete?['transport']:[])]);if(p.format!==(complete?'idms-field-channel-profile-v2':'idms-field-channel-profile-v1'))fieldFailure('FIELD_PROFILE_INVALID');const source=fieldSource(p.source);
  const o=object(p.opcua,['endpoint','serverApplicationUri','clientApplicationUri','securityMode','securityPolicy','serverCertificateSha256','clientCertificateSha256','trustMode','revokedCertificateSha256']),endpoint=text(o.endpoint,2048),u=new URL(endpoint);
  if(u.protocol!=='opc.tcp:'||!u.hostname||!u.port||Number(u.port)<1||Number(u.port)>65535||u.username||u.password||u.search||u.hash||o.securityMode!=='SignAndEncrypt'||!['Basic256Sha256','Aes256_Sha256_RsaPss'].includes(String(o.securityPolicy))||o.trustMode!=='PINNED_LEAF'||!Array.isArray(o.revokedCertificateSha256)||o.revokedCertificateSha256.length>64)fieldFailure('FIELD_PROFILE_INVALID');
  const opcua:FieldProfile['opcua']={endpoint:u.toString(),serverApplicationUri:uri(o.serverApplicationUri),clientApplicationUri:uri(o.clientApplicationUri),securityMode:'SignAndEncrypt',securityPolicy:o.securityPolicy as FieldProfile['opcua']['securityPolicy'],serverCertificateSha256:hash(o.serverCertificateSha256),clientCertificateSha256:hash(o.clientCertificateSha256),trustMode:'PINNED_LEAF',revokedCertificateSha256:o.revokedCertificateSha256.map(hash).sort()};if(new Set(opcua.revokedCertificateSha256).size!==opcua.revokedCertificateSha256.length||opcua.serverApplicationUri===opcua.clientApplicationUri||opcua.serverCertificateSha256===opcua.clientCertificateSha256)fieldFailure('FIELD_PROFILE_INVALID');
  const c=object(p.certificates,['serverFile','clientFile','privateKeyFile']),certificates={serverFile:file(c.serverFile),clientFile:file(c.clientFile),privateKeyFile:file(c.privateKeyFile)};if(new Set(Object.values(certificates)).size!==3)fieldFailure('FIELD_PROFILE_INVALID');
  if(!p.userIdentity||typeof p.userIdentity!=='object')fieldFailure('FIELD_PROFILE_INVALID');const rawIdentity=p.userIdentity as Record<string,unknown>,i=object(rawIdentity,rawIdentity.type==='Anonymous'?['type']:['type','userName','passwordFile']);let userIdentity:FieldProfile['userIdentity'];if(i.type==='Anonymous')userIdentity={type:'Anonymous'};else if(i.type==='UserName')userIdentity={type:'UserName',userName:text(i.userName,128),passwordFile:file(i.passwordFile)};else fieldFailure('FIELD_PROFILE_INVALID');
  const limits=fieldLimits(p.limits),points=fieldPoints(p.points);
  const result:FieldProfile={format:complete?'idms-field-channel-profile-v2':'idms-field-channel-profile-v1',...(complete?{transport:fieldMqttTransport(p.transport,source)}:{}),source,opcua,certificates,userIdentity:userIdentity!,limits,points};deepFreeze(result);return result;
 }catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_PROFILE_INVALID');}
}
export function publicFieldProfile(raw:unknown){const p=parseFieldProfile(raw),{endpoint,...opcua}=p.opcua;return parsePublicFieldProfile({format:p.format==='idms-field-channel-profile-v2'?'idms-field-channel-public-profile-v2':'idms-field-channel-public-profile-v1',...(p.transport?{transport:p.transport}:{}),ruleVersion:fieldProfileVersion,source:{...p.source,origin:'FIELD'},opcua:{...opcua,endpointSha256:fieldSha256(endpoint)},userTokenType:p.userIdentity.type,userIdentitySha256:fieldSha256(stable({source:p.source,type:p.userIdentity.type,...(p.userIdentity.type==='UserName'?{userName:p.userIdentity.userName}:{})})),limits:p.limits,points:p.points,unitEvidence:'DECLARED_MAP_NOT_AUTOMATIC_PHYSICAL_UNIT_VERIFICATION',trustEvidence:'EXPLICIT_LEAF_PIN_NOT_CA_PATH_OR_ONLINE_OCSP',fieldCommissioned:false});}
export const fieldProfileDigest=(raw:unknown)=>fieldSha256(stable(publicFieldProfile(raw)));
export async function readBoundedFieldFile(path:string,maximum:number){
 let h;try{if(!(await lstat(path)).isFile())fieldFailure('FIELD_MATERIAL_INVALID');h=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);const before=await h.stat();if(!before.isFile()||before.size<1||before.size>maximum)fieldFailure('FIELD_MATERIAL_INVALID');const bytes=Buffer.alloc(before.size);let n=0;while(n<bytes.length){const r=await h.read(bytes,n,bytes.length-n,n);if(!r.bytesRead)fieldFailure('FIELD_MATERIAL_CHANGED');n+=r.bytesRead;}if((await h.read(Buffer.alloc(1),0,1,n)).bytesRead)fieldFailure('FIELD_MATERIAL_CHANGED');const after=await h.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fieldFailure('FIELD_MATERIAL_CHANGED');return bytes;}catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_MATERIAL_UNAVAILABLE');}finally{await h?.close();}
}
export async function loadFieldProfile(path:string){try{return parseFieldProfile(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedFieldFile(path,131072))));}catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_PROFILE_INVALID');}}
export async function readFieldMaterial(root:string,name:string,maximum=65536){
 const safe=file(name);try{const base=await realpath(root),target=resolve(base,safe);if((await lstat(target)).isSymbolicLink())fieldFailure('FIELD_MATERIAL_UNAVAILABLE');const resolved=await realpath(target),rel=relative(base,resolved);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))fieldFailure('FIELD_MATERIAL_UNAVAILABLE');return await readBoundedFieldFile(resolved,maximum);}catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_MATERIAL_UNAVAILABLE');}
}
export const fieldProfileDirectory=(path:string)=>dirname(resolve(path));
