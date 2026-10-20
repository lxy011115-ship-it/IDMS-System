import {fieldCertificateDer} from './certificate-bytes.ts';
export {fieldCertificateDer} from './certificate-bytes.ts';
import {X509Certificate,createPrivateKey,createPublicKey,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {parsePublicFieldProfile} from '../../integrations/field-profile.ts';
import {exploreCertificate,split_der} from 'node-opcua-crypto';
import {StatusCodes,type StatusCode} from 'node-opcua-status-code';
import type {ICertificateStore} from 'node-opcua-common';
import {type FieldProfile,parseFieldProfile,readFieldMaterial,fieldSha256} from './profile.ts';
import {fieldFailure,FieldChannelError} from './error.ts';

export interface FieldCertificateIdentity {sha256:string;applicationUri:string;notBefore:string;notAfter:string;role:'CLIENT'|'SERVER';trustMode:'PINNED_LEAF'}
export interface FieldMaterials {serverCertificate:Buffer;clientCertificate:Buffer;privateKeyPem:Buffer;password?:string}
const checkTime=(time:number)=>{if(!Number.isFinite(time))fieldFailure('FIELD_CLOCK_INVALID');};
export function fieldPeerLeaf(chain:Buffer|Buffer[]){
 try{const pieces=Array.isArray(chain)?chain:split_der(chain);if(!pieces.length||pieces.length>8||pieces.reduce((n,b)=>n+b.length,0)>262144)fieldFailure('FIELD_CERTIFICATE_INVALID');for(const p of pieces)fieldCertificateDer(p);return Buffer.from(pieces[0]);}catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_CERTIFICATE_INVALID');}
}
function verifyCertificate(raw:Buffer,profile:Pick<FieldProfile,'opcua'>,role:'CLIENT'|'SERVER',now:number):FieldCertificateIdentity{
 checkTime(now);if(role!=='CLIENT'&&role!=='SERVER')fieldFailure('FIELD_CERTIFICATE_INVALID');try{
  const der=fieldCertificateDer(raw),sha256=fieldSha256(der),expected=role==='SERVER'?profile.opcua.serverCertificateSha256:profile.opcua.clientCertificateSha256;
  if(!timingSafeEqual(Buffer.from(sha256,'hex'),Buffer.from(expected,'hex')))fieldFailure('FIELD_CERTIFICATE_PIN_MISMATCH');if(profile.opcua.revokedCertificateSha256.includes(sha256))fieldFailure('FIELD_CERTIFICATE_REVOKED');
  const x=new X509Certificate(der),internals=exploreCertificate(der),tbs=internals.tbsCertificate,ext=tbs.extensions,applicationUri=role==='SERVER'?profile.opcua.serverApplicationUri:profile.opcua.clientApplicationUri,uris=ext?.subjectAltName?.uniformResourceIdentifier;
  const before=Date.parse(x.validFrom),after=Date.parse(x.validTo);if(!Number.isFinite(before)||!Number.isFinite(after)||before>now||after<=now||before>=after)fieldFailure('FIELD_CERTIFICATE_TIME_INVALID');
  if(x.ca||ext?.basicConstraints?.cA||x.publicKey.asymmetricKeyType!=='rsa'||x.publicKey.asymmetricKeyDetails?.publicExponent!==65537n||(x.publicKey.asymmetricKeyDetails?.modulusLength||0)<2048||(x.publicKey.asymmetricKeyDetails?.modulusLength||0)>4096||!ext?.keyUsage?.digitalSignature||!ext.keyUsage.keyEncipherment||!ext.keyUsage.dataEncipherment||role==='SERVER'&&!ext.extKeyUsage?.serverAuth||role==='CLIENT'&&!ext.extKeyUsage?.clientAuth)fieldFailure('FIELD_CERTIFICATE_USAGE_INVALID');
  // Exact leaf trust is an explicit approval model. It does not infer trust
  // from an unknown issuer, build CA paths, fetch AIA/CRLs, or perform OCSP.
  const algorithm=internals.signatureAlgorithm.identifier;if(!['sha256WithRSAEncryption','sha384WithRSAEncryption','sha512WithRSAEncryption','RSA-SHA256','RSA-SHA384','RSA-SHA512','1.2.840.113549.1.1.11','1.2.840.113549.1.1.12','1.2.840.113549.1.1.13'].includes(algorithm))fieldFailure('FIELD_CERTIFICATE_ALGORITHM_INVALID');
  if(x.issuer===x.subject&&!x.verify(x.publicKey))fieldFailure('FIELD_CERTIFICATE_SIGNATURE_INVALID');
  if(!Array.isArray(uris)||uris.length!==1||uris[0]!==applicationUri)fieldFailure('FIELD_CERTIFICATE_URI_MISMATCH');
  if(role==='SERVER'){const hostname=new URL(profile.opcua.endpoint).hostname.replace(/^\[|\]$/g,'');if(isIP(hostname)?!x.checkIP(hostname):!x.checkHost(hostname,{subject:'never',wildcards:false,partialWildcards:false,multiLabelWildcards:false,singleLabelSubdomains:false}))fieldFailure('FIELD_CERTIFICATE_HOST_MISMATCH');}
  return {sha256,applicationUri,notBefore:new Date(before).toISOString(),notAfter:new Date(after).toISOString(),role,trustMode:'PINNED_LEAF'};
 }catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_CERTIFICATE_INVALID');}
}
export function verifyFieldCertificate(raw:Buffer,rawProfile:unknown,role:'CLIENT'|'SERVER',now=Date.now()):FieldCertificateIdentity{return verifyCertificate(raw,parseFieldProfile(rawProfile),role,now);}
export function verifyPublicFieldCertificate(raw:Buffer,rawProfile:unknown,endpoint:string,role:'CLIENT'|'SERVER',now:number):FieldCertificateIdentity{
 const profile=parsePublicFieldProfile(rawProfile);let url:URL;try{url=new URL(endpoint);if(url.toString()!==endpoint||url.protocol!=='opc.tcp:'||!url.hostname||!url.port||Number(url.port)<1||Number(url.port)>65535||url.username||url.password||url.search||url.hash||fieldSha256(endpoint)!==profile.opcua.endpointSha256)throw Error();}catch{fieldFailure('FIELD_CERTIFICATE_ENDPOINT_MISMATCH');}
 return verifyCertificate(raw,{opcua:{...profile.opcua,endpoint:url!.toString()}},role,now);
}

export function verifyFieldMaterials(rawProfile:unknown,materials:FieldMaterials,now=Date.now()){
 const profile=parseFieldProfile(rawProfile),serverCertificate=fieldCertificateDer(materials.serverCertificate),clientCertificate=fieldCertificateDer(materials.clientCertificate),server=verifyFieldCertificate(serverCertificate,profile,'SERVER',now),client=verifyFieldCertificate(clientCertificate,profile,'CLIENT',now);
 try{
  if(!Buffer.isBuffer(materials.privateKeyPem)||materials.privateKeyPem.length<100||materials.privateKeyPem.length>65536||!/^\s*-----BEGIN (?:RSA )?PRIVATE KEY-----[A-Za-z0-9+/=\r\n]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(materials.privateKeyPem.toString('utf8')))fieldFailure('FIELD_PRIVATE_KEY_INVALID');
  const key=createPrivateKey(materials.privateKeyPem),publicKey=createPublicKey(key).export({type:'spki',format:'der'}),expected=new X509Certificate(clientCertificate).publicKey.export({type:'spki',format:'der'});if(publicKey.length!==expected.length||!timingSafeEqual(publicKey,expected))fieldFailure('FIELD_PRIVATE_KEY_MISMATCH');
  if(profile.userIdentity.type==='UserName'&&(typeof materials.password!=='string'||!materials.password.length||materials.password.length>512||/[\u0000-\u001f\u007f]/.test(materials.password))||profile.userIdentity.type==='Anonymous'&&materials.password!==undefined)fieldFailure('FIELD_USER_IDENTITY_INVALID');
  return {server,client,serverCertificate,clientCertificate};
 }catch(e){if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_PRIVATE_KEY_INVALID');}
}
export async function loadFieldMaterials(root:string,rawProfile:unknown):Promise<FieldMaterials>{
 const p=parseFieldProfile(rawProfile),serverCertificate=await readFieldMaterial(root,p.certificates.serverFile),clientCertificate=await readFieldMaterial(root,p.certificates.clientFile),privateKeyPem=await readFieldMaterial(root,p.certificates.privateKeyFile);let password:string|undefined;
 try{if(p.userIdentity.type==='UserName')password=new TextDecoder('utf-8',{fatal:true}).decode(await readFieldMaterial(root,p.userIdentity.passwordFile,2048));const result={serverCertificate,clientCertificate,privateKeyPem,...(password!==undefined?{password}:{})};verifyFieldMaterials(p,result);return result;}catch(e){privateKeyPem.fill(0);if(e instanceof FieldChannelError)throw e;fieldFailure('FIELD_USER_IDENTITY_INVALID');}
}
// A connection-local immutable allowlist. There is no auto-trust mutation or
// writable default PKI. All acceptance paths recheck the exact approved leaf.
export class PinnedFieldCertificateStore implements ICertificateStore {
 referenceCounter=0;#closed=false;#profile:Readonly<FieldProfile>;#now:()=>number;
 constructor(profile:unknown,now:()=>number=Date.now){this.#profile=parseFieldProfile(profile);this.#now=now;}
 async initialize(){if(this.#closed)fieldFailure('FIELD_CERTIFICATE_STORE_CLOSED');}
 async dispose(){this.referenceCounter=Math.max(0,this.referenceCounter-1);if(!this.referenceCounter)this.#closed=true;}
 async checkCertificate(chain:Buffer|Buffer[]):Promise<StatusCode>{
  if(this.#closed)return StatusCodes.BadCertificateUntrusted;try{verifyFieldCertificate(fieldPeerLeaf(chain),this.#profile,'SERVER',this.#now());return StatusCodes.Good;}catch(e){const c=(e as FieldChannelError).code;if(c==='FIELD_CERTIFICATE_TIME_INVALID')return StatusCodes.BadCertificateTimeInvalid;if(c==='FIELD_CERTIFICATE_HOST_MISMATCH')return StatusCodes.BadCertificateHostNameInvalid;if(c==='FIELD_CERTIFICATE_URI_MISMATCH')return StatusCodes.BadCertificateUriInvalid;if(c==='FIELD_CERTIFICATE_REVOKED')return StatusCodes.BadCertificateRevoked;return StatusCodes.BadCertificateUntrusted;}
 }
 async verifyCertificate(chain:Buffer|Buffer[],_options?:{acceptOutdatedCertificate?:boolean}){return (await this.checkCertificate(chain)).name;}
 async getTrustStatus(certificate:Buffer){return this.checkCertificate(certificate);}
 async trustCertificate(_certificate:Buffer|Buffer[]):Promise<void>{fieldFailure('FIELD_TRUST_MUTATION_FORBIDDEN');}
 async rejectCertificate(_certificate:Buffer|Buffer[]):Promise<void>{fieldFailure('FIELD_TRUST_MUTATION_FORBIDDEN');}
 async addIssuer(_certificate:Buffer,_validate?:boolean,_trust?:boolean):Promise<unknown>{fieldFailure('FIELD_TRUST_MUTATION_FORBIDDEN');}
 async addRevocationList(_crl:Buffer,_target?:'issuers'|'trusted'):Promise<unknown>{fieldFailure('FIELD_TRUST_MUTATION_FORBIDDEN');}
}
