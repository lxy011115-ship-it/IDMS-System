import {fieldObject,fieldHash,fieldSha256,fieldInteger,type PublicFieldProfile} from '../integrations/field-profile.ts';
import {fieldCertificateDer,verifyPublicFieldCertificate} from '../services/field/certificates.ts';
import {verifyFieldMqttCertificates} from '../services/field/mqtt-materials.ts';
import {canonical} from './imports.ts';

export const fieldEvidenceFailure=(code='FIELD_EVIDENCE_INVALID'):never=>{throw Object.assign(Error(code),{code});};
export const evidenceNeed=(v:unknown,code='FIELD_EVIDENCE_INVALID'):void=>{if(!v)fieldEvidenceFailure(code);};
export const evidenceSame=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function fieldEvidencePublicMaterials(raw:unknown){
 const m=fieldObject(raw,['format','profiles','certificates']);evidenceNeed(m.format==='idms-field-evidence-public-materials-v1'&&Array.isArray(m.profiles)&&m.profiles.length>0&&m.profiles.length<=32&&Array.isArray(m.certificates)&&m.certificates.length<=256);
 const profiles=new Map<string,{opcuaEndpoint:string;mqttBrokerUrl:string}>(),certificates=new Map<string,Buffer>();let bytes=0;
 for(const value of m.profiles as unknown[]){const p=fieldObject(value,['profileDigest','opcuaEndpoint','mqttBrokerUrl']),id=fieldHash(p.profileDigest);evidenceNeed(!profiles.has(id)&&typeof p.opcuaEndpoint==='string'&&p.opcuaEndpoint.length<=2048&&typeof p.mqttBrokerUrl==='string'&&p.mqttBrokerUrl.length<=2048);profiles.set(id,{opcuaEndpoint:p.opcuaEndpoint as string,mqttBrokerUrl:p.mqttBrokerUrl as string});}
 for(const value of m.certificates as unknown[]){const c=fieldObject(value,['sha256','derBase64']),id=fieldHash(c.sha256);evidenceNeed(typeof c.derBase64==='string'&&c.derBase64.length<=90000&&!certificates.has(id));const der=Buffer.from(c.derBase64 as string,'base64');bytes+=der.length;evidenceNeed(der.toString('base64')===c.derBase64&&fieldSha256(der)===id&&fieldCertificateDer(der).equals(der)&&bytes<=4*1024**2);certificates.set(id,der);}
 return {profiles,certificates};
}
export function verifyFieldEvidenceCertificates(materials:ReturnType<typeof fieldEvidencePublicMaterials>,profile:PublicFieldProfile,digest:string,event:any,receivedAt:number){
 const context=materials.profiles.get(digest);evidenceNeed(context&&profile.transport,'FIELD_EVIDENCE_CERTIFICATES_MISSING');const c=context!,t=profile.transport!,get=(id:string)=>{const der=materials.certificates.get(id);if(!der)fieldEvidenceFailure('FIELD_EVIDENCE_CERTIFICATES_MISSING');return der!;};
 const start=Date.parse(event.witness.startedAt),end=Date.parse(event.witness.observedAt);fieldInteger(receivedAt,0,8640000000000000);
 for(const role of ['SERVER','CLIENT'] as const){const pin=role==='SERVER'?profile.opcua.serverCertificateSha256:profile.opcua.clientCertificateSha256;const first=verifyPublicFieldCertificate(get(pin),profile,c.opcuaEndpoint,role,start),last=verifyPublicFieldCertificate(get(pin),profile,c.opcuaEndpoint,role,end);evidenceNeed(evidenceSame(first,last)&&evidenceSame(last,event.witness.channel[role.toLowerCase()]),'FIELD_EVIDENCE_CERTIFICATE_WITNESS_CHANGED');}
 for(const role of ['EDGE','PLATFORM'] as const)verifyFieldMqttCertificates(profile,c.mqttBrokerUrl,role,{caCertificate:get(t.caCertificateSha256),serverCertificate:get(t.serverCertificateSha256),clientCertificate:get(role==='EDGE'?t.edgeCertificateSha256:t.platformCertificateSha256)},receivedAt);
}
