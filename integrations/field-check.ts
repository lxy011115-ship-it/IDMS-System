import {KeyObject,createHmac,timingSafeEqual,sign,verify} from 'node:crypto';
import {fieldObject,fieldText,fieldHash,fieldInteger,fieldSha256,freezeFieldValue} from './field-profile.ts';
import {fieldLeaseBody,fieldLeaseKeyId,type SignedFieldLease} from './field-lease.ts';
import {stable} from './telemetry.ts';
import {fieldFailure} from '../services/field/error.ts';
export interface FieldCheckRequestBody {format:'idms-field-lease-check-request-v1';requestId:string;requestedAtMs:number;lease:SignedFieldLease}
export interface FieldCheckRequest extends FieldCheckRequestBody {signature:string}
export interface FieldCheckBody {
 format:'idms-field-lease-check-v1';keyId:string;requestId:string;leaseId:string;leaseDigest:string;
 tenantId:string;edgeId:string;deviceCode:string;mapVersion:string;profileDigest:string;
 checkedAtMs:number;validUntilMs:number;allowed:boolean;reason:string|null;
 admissionDigest:string|null;registryRevision:string;registryDigest:string;
}
export interface SignedFieldCheck {body:FieldCheckBody;signature:string}
const requestPurpose='idms:field-lease-check-request:1\n',statusPurpose='idms:field-lease-check:1\n';
const uuid=(v:unknown)=>{const s=fieldText(v,36);if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s))fieldFailure('FIELD_LEASE_CHECK_INVALID');return s;};
export function fieldSignedLease(raw:unknown):SignedFieldLease{const s=fieldObject(raw,['body','signature']),body=fieldLeaseBody(s.body),signature=fieldText(s.signature,86);if(!/^[A-Za-z0-9_-]{86}$/.test(signature)||Buffer.from(signature,'base64url').toString('base64url')!==signature)fieldFailure('FIELD_LEASE_CHECK_INVALID');return {body,signature};}
export const fieldLeaseDigest=(raw:unknown)=>fieldSha256(stable(fieldSignedLease(raw)));
function requestBody(raw:unknown):FieldCheckRequestBody{const r=fieldObject(raw,['format','requestId','requestedAtMs','lease']);if(r.format!=='idms-field-lease-check-request-v1')fieldFailure('FIELD_LEASE_CHECK_INVALID');return {format:'idms-field-lease-check-request-v1',requestId:uuid(r.requestId),requestedAtMs:fieldInteger(r.requestedAtMs,0,8640000000000000),lease:fieldSignedLease(r.lease)};}
const mac=(body:FieldCheckRequestBody,key:Uint8Array)=>{if(!(key instanceof Uint8Array)||key.byteLength!==32)fieldFailure('FIELD_LEASE_CHECK_INVALID');return createHmac('sha256',key).update(requestPurpose+stable(body)).digest('hex');};
export function signFieldCheckRequest(raw:unknown,key:Uint8Array):FieldCheckRequest{try{const body=requestBody(raw),result={...body,signature:mac(body,key)};freezeFieldValue(result);return result;}catch{fieldFailure('FIELD_LEASE_CHECK_INVALID');}}
export function verifyFieldCheckRequest(raw:unknown,key:Uint8Array,now:number):FieldCheckRequest{
 try{const r=fieldObject(raw,['format','requestId','requestedAtMs','lease','signature']),{signature,...data}=r,body=requestBody(data);if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!Number.isSafeInteger(now)||body.requestedAtMs>now||now-body.requestedAtMs>=30000||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(mac(body,key),'hex')))throw Error();const result={...body,signature};freezeFieldValue(result);return result;}catch{fieldFailure('FIELD_LEASE_CHECK_INVALID');}
}
export function fieldCheckBody(raw:unknown):FieldCheckBody{
 const b=fieldObject(raw,['format','keyId','requestId','leaseId','leaseDigest','tenantId','edgeId','deviceCode','mapVersion','profileDigest','checkedAtMs','validUntilMs','allowed','reason','admissionDigest','registryRevision','registryDigest']),tenantId=fieldText(b.tenantId,80),edgeId=fieldText(b.edgeId,80),deviceCode=fieldText(b.deviceCode,128),mapVersion=fieldText(b.mapVersion,128),checkedAtMs=fieldInteger(b.checkedAtMs,0,8640000000000000),validUntilMs=fieldInteger(b.validUntilMs,0,8640000000000000),registryRevision=fieldText(b.registryRevision,19);
 if(b.format!=='idms-field-lease-check-v1'||typeof b.allowed!=='boolean'||!/^[A-Za-z0-9_-]+$/.test(tenantId)||!/^[A-Za-z0-9_-]+$/.test(edgeId)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deviceCode)||validUntilMs<=checkedAtMs||validUntilMs-checkedAtMs>2000||!/^[1-9][0-9]{0,18}$/.test(registryRevision)||BigInt(registryRevision)>9223372036854775807n)fieldFailure('FIELD_LEASE_CHECK_INVALID');
 const reason=b.reason===null?null:fieldText(b.reason,128),admissionDigest=b.admissionDigest===null?null:fieldHash(b.admissionDigest);if(b.allowed&&(reason!==null||admissionDigest===null)||!b.allowed&&(reason===null||!/^(FIELD|SOURCE)_[A-Z0-9_]{1,96}$/.test(reason)))fieldFailure('FIELD_LEASE_CHECK_INVALID');
 return {format:'idms-field-lease-check-v1',keyId:fieldHash(b.keyId),requestId:uuid(b.requestId),leaseId:uuid(b.leaseId),leaseDigest:fieldHash(b.leaseDigest),tenantId,edgeId,deviceCode,mapVersion,profileDigest:fieldHash(b.profileDigest),checkedAtMs,validUntilMs,allowed:b.allowed,reason,admissionDigest,registryRevision,registryDigest:fieldHash(b.registryDigest)};
}
export function signFieldCheck(raw:unknown,key:KeyObject):SignedFieldCheck{try{const body=fieldCheckBody(raw);if(key.type!=='private'||fieldLeaseKeyId(key)!==body.keyId)throw Error();const result={body,signature:sign(null,Buffer.from(statusPurpose+stable(body)),key).toString('base64url')};freezeFieldValue(result);return result;}catch{fieldFailure('FIELD_LEASE_CHECK_INVALID');}}
export function verifyFieldCheck(raw:unknown,key:KeyObject,expected:{requestId:string;requestedAtMs:number;lease:SignedFieldLease},now:number):SignedFieldCheck{
 try{const s=fieldObject(raw,['body','signature']),body=fieldCheckBody(s.body),lease=fieldSignedLease(expected.lease);if(key.type!=='public'||fieldLeaseKeyId(key)!==body.keyId||typeof s.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(s.signature)||Buffer.from(s.signature,'base64url').toString('base64url')!==s.signature||!verify(null,Buffer.from(statusPurpose+stable(body)),key,Buffer.from(s.signature,'base64url'))||!Number.isSafeInteger(now)||body.checkedAtMs>now||now>=body.validUntilMs||body.checkedAtMs<expected.requestedAtMs||body.requestId!==expected.requestId||body.leaseId!==lease.body.leaseId||body.leaseDigest!==fieldLeaseDigest(lease))throw Error();
  for(const name of ['tenantId','edgeId','deviceCode','mapVersion','profileDigest'] as const)if(body[name]!==lease.body[name])throw Error();if(body.allowed&&(body.admissionDigest!==lease.body.admissionDigest||body.registryRevision!==lease.body.registryRevision||body.registryDigest!==lease.body.registryDigest||body.validUntilMs>lease.body.expiresAtMs||now<lease.body.issuedAtMs||now>=lease.body.expiresAtMs))throw Error();const result={body,signature:s.signature};freezeFieldValue(result);return result;
 }catch{fieldFailure('FIELD_LEASE_CHECK_INVALID');}
}
