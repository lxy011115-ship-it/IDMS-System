import {X509Certificate,createPrivateKey,createPublicKey,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {exploreCertificate} from 'node-opcua-crypto';
import {fieldCertificateDer} from './certificate-bytes.ts';
import {readFieldMaterial} from './profile.ts';
import {fieldFailure,FieldChannelError} from './error.ts';
import {parsePublicFieldProfile,fieldHash,fieldObject,fieldText,fieldSha256,type PublicFieldProfile} from '../../integrations/field-profile.ts';
export type FieldMqttRole='EDGE'|'PLATFORM';
export interface FieldMqttMaterials {caCertificate:Buffer;serverCertificate:Buffer;clientCertificate:Buffer;privateKeyPem:Buffer}
export function completeFieldMqttProfile(raw:unknown){const profile=parsePublicFieldProfile(raw);if(profile.format!=='idms-field-channel-public-profile-v2'||!profile.transport)fieldFailure('FIELD_TRANSPORT_REQUIRED');return profile as PublicFieldProfile&{transport:NonNullable<PublicFieldProfile['transport']>};}
export function fieldBrokerUrl(raw:unknown,profile:ReturnType<typeof completeFieldMqttProfile>){
 try{const text=fieldText(raw,2048),u=new URL(text);if(u.protocol!=='mqtts:'||!u.hostname||!u.port||Number(u.port)<1||Number(u.port)>65535||u.username||u.password||u.search||u.hash||u.pathname||u.toString()!==text||fieldSha256(text)!==profile.transport.brokerUrlSha256)throw Error();return u;}catch{fieldFailure('FIELD_MQTT_URL_INVALID');}
}
function certificate(bytes:Buffer,pin:string,profile:ReturnType<typeof completeFieldMqttProfile>,now:number,ca=false){
 const der=fieldCertificateDer(bytes),x=new X509Certificate(der),parsed=exploreCertificate(der),ext=parsed.tbsCertificate.extensions;
 if(fieldSha256(der)!==fieldHash(pin))fieldFailure('FIELD_MQTT_CERTIFICATE_PIN_MISMATCH');if(profile.transport.revokedCertificateSha256.includes(pin))fieldFailure('FIELD_MQTT_CERTIFICATE_REVOKED');
 if(!Number.isSafeInteger(now)||!Number.isFinite(Date.parse(x.validFrom))||!Number.isFinite(Date.parse(x.validTo))||Date.parse(x.validFrom)>now||Date.parse(x.validTo)<=now)fieldFailure('FIELD_MQTT_CERTIFICATE_TIME_INVALID');
 if(x.publicKey.asymmetricKeyType!=='rsa'||x.publicKey.asymmetricKeyDetails?.publicExponent!==65537n||(x.publicKey.asymmetricKeyDetails?.modulusLength||0)<2048||(x.publicKey.asymmetricKeyDetails?.modulusLength||0)>4096||!['sha256WithRSAEncryption','sha384WithRSAEncryption','sha512WithRSAEncryption','RSA-SHA256','RSA-SHA384','RSA-SHA512','1.2.840.113549.1.1.11','1.2.840.113549.1.1.12','1.2.840.113549.1.1.13'].includes(parsed.signatureAlgorithm.identifier))fieldFailure('FIELD_MQTT_CERTIFICATE_USAGE_INVALID');
 if(ca?(!x.ca||!ext?.basicConstraints?.cA||!ext.keyUsage?.keyCertSign||!ext.keyUsage.cRLSign||x.issuer!==x.subject||!x.verify(x.publicKey)):(x.ca||ext?.basicConstraints?.cA||!ext?.keyUsage?.digitalSignature||!ext.keyUsage.keyEncipherment||ext.keyUsage.keyCertSign))fieldFailure('FIELD_MQTT_CERTIFICATE_USAGE_INVALID');
 return {x,ext,subject:parsed.tbsCertificate.subject,der};
}
export function verifyFieldMqttCertificates(raw:unknown,url:unknown,role:FieldMqttRole,materials:Omit<FieldMqttMaterials,'privateKeyPem'>,now=Date.now()){
 try{if(!['EDGE','PLATFORM'].includes(role))throw Error();const profile=completeFieldMqttProfile(raw),u=fieldBrokerUrl(url,profile),t=profile.transport,ca=certificate(materials.caCertificate,t.caCertificateSha256,profile,now,true),server=certificate(materials.serverCertificate,t.serverCertificateSha256,profile,now),client=certificate(materials.clientCertificate,role==='EDGE'?t.edgeCertificateSha256:t.platformCertificateSha256,profile,now),host=u.hostname.replace(/^\[|\]$/g,'');
  for(const leaf of [server,client])if(!leaf.x.checkIssued(ca.x)||!leaf.x.verify(ca.x.publicKey)||Date.parse(leaf.x.validFrom)<Date.parse(ca.x.validFrom)||Date.parse(leaf.x.validTo)>Date.parse(ca.x.validTo))fieldFailure('FIELD_MQTT_CERTIFICATE_ISSUER_INVALID');
  if(!server.ext?.extKeyUsage?.serverAuth||!client.ext?.extKeyUsage?.clientAuth||client.ext.extKeyUsage.serverAuth||client.subject.entries.filter(e=>e.oid==='2.5.4.3').length!==1||client.subject.commonName!==(role==='EDGE'?t.edgeClientId:t.platformClientId))fieldFailure('FIELD_MQTT_CERTIFICATE_IDENTITY_INVALID');
  if(isIP(host)?!server.x.checkIP(host):!server.x.checkHost(host,{subject:'never',wildcards:false,partialWildcards:false,multiLabelWildcards:false,singleLabelSubdomains:false}))fieldFailure('FIELD_MQTT_CERTIFICATE_HOST_INVALID');
  return {profile,host,clientId:role==='EDGE'?t.edgeClientId:t.platformClientId,notAfter:Math.min(...[ca,server,client].map(c=>Date.parse(c.x.validTo))),caCertificate:Buffer.from(ca.x.toString()),serverCertificate:server.der,clientCertificate:Buffer.from(client.x.toString())};
 }catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_MQTT_MATERIAL_INVALID');}
}
export function verifyFieldMqttMaterials(raw:unknown,url:unknown,role:FieldMqttRole,materials:FieldMqttMaterials,now=Date.now()){
 const checked=verifyFieldMqttCertificates(raw,url,role,materials,now);
 try{
  if(!Buffer.isBuffer(materials.privateKeyPem)||materials.privateKeyPem.length>65536||!/^\s*-----BEGIN (?:RSA )?PRIVATE KEY-----[A-Za-z0-9+/=\r\n]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(materials.privateKeyPem.toString('utf8')))fieldFailure('FIELD_MQTT_PRIVATE_KEY_INVALID');
  const key=createPrivateKey(materials.privateKeyPem),actual=createPublicKey(key).export({type:'spki',format:'der'}),expected=new X509Certificate(checked.clientCertificate).publicKey.export({type:'spki',format:'der'});if(actual.length!==expected.length||!timingSafeEqual(actual,expected))fieldFailure('FIELD_MQTT_PRIVATE_KEY_MISMATCH');
  return checked;
 }catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_MQTT_MATERIAL_INVALID');}
}

export async function loadFieldMqttMaterials(root:string,raw:unknown,profile:unknown,role:FieldMqttRole){
 let key:Buffer|undefined;try{const r=fieldObject(raw,['url','caFile','serverCertificateFile','clientCertificateFile','privateKeyFile']),names=['caFile','serverCertificateFile','clientCertificateFile','privateKeyFile'].map(k=>fieldText(r[k],256));if(new Set(names).size!==4)throw Error();const materials={caCertificate:await readFieldMaterial(root,names[0]),serverCertificate:await readFieldMaterial(root,names[1]),clientCertificate:await readFieldMaterial(root,names[2]),privateKeyPem:key=await readFieldMaterial(root,names[3])};verifyFieldMqttMaterials(profile,r.url,role,materials);return {url:fieldText(r.url,2048),materials};}catch(e){key?.fill(0);if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_MQTT_MATERIAL_INVALID');}
}
