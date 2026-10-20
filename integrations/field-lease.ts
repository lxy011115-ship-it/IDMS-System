import {createPublicKey,sign,verify,KeyObject,randomUUID} from 'node:crypto';
import {fieldHash,fieldInteger,fieldObject,fieldText,fieldSha256,freezeFieldValue} from './field-profile.ts';
import {stable} from './telemetry.ts';
import {fieldFailure} from '../services/field/error.ts';
export interface FieldLeaseBody {
 format:'idms-field-channel-lease-v1';keyId:string;leaseId:string;requestId:string;
 tenantId:string;edgeId:string;deviceCode:string;mapVersion:string;profileDigest:string;admissionDigest:string;
 registryRevision:string;registryDigest:string;issuedAtMs:number;expiresAtMs:number;
}
export interface SignedFieldLease {body:FieldLeaseBody;signature:string}
const purpose='idms:field-channel-lease:1\n';
const uuid=(v:unknown)=>{const s=fieldText(v,36);if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s))fieldFailure('FIELD_LEASE_INVALID');return s;};
export function fieldLeaseBody(raw:unknown):FieldLeaseBody{
 const b=fieldObject(raw,['format','keyId','leaseId','requestId','tenantId','edgeId','deviceCode','mapVersion','profileDigest','admissionDigest','registryRevision','registryDigest','issuedAtMs','expiresAtMs']);
 if(b.format!=='idms-field-channel-lease-v1')fieldFailure('FIELD_LEASE_INVALID');const tenantId=fieldText(b.tenantId,80),edgeId=fieldText(b.edgeId,80),deviceCode=fieldText(b.deviceCode,128),mapVersion=fieldText(b.mapVersion,128),registryRevision=fieldText(b.registryRevision,19),issuedAtMs=fieldInteger(b.issuedAtMs,0,8640000000000000),expiresAtMs=fieldInteger(b.expiresAtMs,0,8640000000000000);
 if(!/^[A-Za-z0-9_-]+$/.test(tenantId)||!/^[A-Za-z0-9_-]+$/.test(edgeId)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deviceCode)||!/^[1-9][0-9]{0,18}$/.test(registryRevision)||BigInt(registryRevision)>9223372036854775807n||expiresAtMs<=issuedAtMs||expiresAtMs-issuedAtMs>30000)fieldFailure('FIELD_LEASE_INVALID');
 return {format:'idms-field-channel-lease-v1',keyId:fieldHash(b.keyId),leaseId:uuid(b.leaseId),requestId:uuid(b.requestId),tenantId,edgeId,deviceCode,mapVersion,profileDigest:fieldHash(b.profileDigest),admissionDigest:fieldHash(b.admissionDigest),registryRevision,registryDigest:fieldHash(b.registryDigest),issuedAtMs,expiresAtMs};
}
export function fieldLeaseKeyId(key:KeyObject){if(!(key instanceof KeyObject)||key.asymmetricKeyType!=='ed25519'||!['private','public'].includes(key.type))fieldFailure('FIELD_LEASE_KEY_INVALID');const pub=key.type==='private'?createPublicKey(key):key;return fieldSha256(pub.export({type:'spki',format:'der'}));}
// Signing is a cryptographic primitive, not an approval bypass. The platform
// issuer must build the body from a fresh verified transaction and registry,
// commit its issuance audit, and only then return the signed lease.
export function signFieldLease(raw:unknown,key:KeyObject):SignedFieldLease{
 try{const b=fieldLeaseBody(raw);if(key.type!=='private'||b.keyId!==fieldLeaseKeyId(key))fieldFailure('FIELD_LEASE_KEY_INVALID');const result={body:b,signature:sign(null,Buffer.from(purpose+stable(b)),key).toString('base64url')};freezeFieldValue(result);return result;}catch{fieldFailure('FIELD_LEASE_INVALID');}
}
export interface FieldLeaseExpected {tenantId:string;edgeId:string;deviceCode:string;mapVersion:string;profileDigest:string;requestId?:string;admissionDigest?:string;registryRevision?:string;registryDigest?:string}
export function verifyFieldLease(raw:unknown,key:KeyObject,expected:FieldLeaseExpected,now:number):SignedFieldLease{
 try{const s=fieldObject(raw,['body','signature']),b=fieldLeaseBody(s.body);if(!Number.isSafeInteger(now)||now<b.issuedAtMs||now>=b.expiresAtMs||b.keyId!==fieldLeaseKeyId(key)||key.type!=='public'||typeof s.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(s.signature))throw Error();
  const sig=Buffer.from(s.signature,'base64url');if(sig.length!==64||sig.toString('base64url')!==s.signature||!verify(null,Buffer.from(purpose+stable(b)),key,sig))throw Error();
  for(const k of ['tenantId','edgeId','deviceCode','mapVersion','profileDigest','requestId','admissionDigest','registryRevision','registryDigest'] as const)if(expected[k]!==undefined&&expected[k]!==b[k])throw Error();const result={body:b,signature:s.signature};freezeFieldValue(result);return result;
 }catch{fieldFailure('FIELD_LEASE_INVALID');}
}
export class FieldLeaseGuard {
 #lease:SignedFieldLease|null=null;#highestIssuedAt=-1;#lastNow=-1;#monotonicDeadline=-Infinity;#pending:{requestId:string;startedAt:number;deadline:number}|null=null;
 readonly #key:KeyObject;readonly #expected:FieldLeaseExpected;readonly #clock:()=>number;readonly #monotonic:()=>number;
 constructor(key:KeyObject,expected:Omit<FieldLeaseExpected,'requestId'>,clock:()=>number=Date.now,monotonic:()=>number=()=>performance.now()){
  if(key.type!=='public')fieldFailure('FIELD_LEASE_KEY_INVALID');fieldLeaseKeyId(key);this.#key=key;this.#expected=Object.freeze({...expected});this.#clock=clock;this.#monotonic=monotonic;
 }
 beginRequest(){this.revoke();const startedAt=this.#now(),tick=this.#monotonic();if(!Number.isFinite(tick))fieldFailure('FIELD_LEASE_CLOCK_INVALID');const requestId=randomUUID();this.#pending={requestId,startedAt,deadline:tick+30000};return requestId;}
 install(raw:unknown){
  this.#lease=null;const pending=this.#pending;this.#pending=null;const now=this.#now(),tick=this.#monotonic();if(!pending||!Number.isFinite(tick)||tick>=pending.deadline||now-pending.startedAt>=30000)fieldFailure('FIELD_LEASE_REQUEST_UNAVAILABLE');
  const lease=verifyFieldLease(raw,this.#key,{...this.#expected,requestId:pending.requestId},now);if(lease.body.issuedAtMs<pending.startedAt||lease.body.issuedAtMs<=this.#highestIssuedAt)fieldFailure('FIELD_LEASE_REPLAY');
  this.#highestIssuedAt=lease.body.issuedAtMs;this.#monotonicDeadline=this.#monotonic()+lease.body.expiresAtMs-now;if(!Number.isFinite(this.#monotonicDeadline))fieldFailure('FIELD_LEASE_INVALID');this.#lease=lease;
 }
 #now(){const now=this.#clock();if(!Number.isSafeInteger(now)||now<this.#lastNow){this.#lease=null;fieldFailure('FIELD_LEASE_CLOCK_INVALID');}this.#lastNow=now;return now;}
 revoke(){this.#lease=null;this.#pending=null;this.#monotonicDeadline=-Infinity;}
 readonly authorize=(permit:Readonly<{profileDigest:string;phase:string}>):void=>{if(permit.profileDigest!==this.#expected.profileDigest){this.revoke();fieldFailure('FIELD_LEASE_PROFILE_MISMATCH');}this.assertCurrent();};
 assertCurrent(){const now=this.#now(),tick=this.#monotonic();if(!this.#lease||!Number.isFinite(tick)||tick>=this.#monotonicDeadline){this.revoke();fieldFailure('FIELD_LEASE_UNAVAILABLE');}try{return verifyFieldLease(this.#lease,this.#key,this.#expected,now);}catch(e){this.revoke();throw e;}}
}
