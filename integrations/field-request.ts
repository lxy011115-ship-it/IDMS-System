import {createHmac,timingSafeEqual} from 'node:crypto';
import {fieldObject,fieldText,fieldHash,fieldInteger,freezeFieldValue} from './field-profile.ts';
import {stable} from './telemetry.ts';
import {fieldFailure} from '../services/field/error.ts';
export interface FieldLeaseRequestBody {format:'idms-field-lease-request-v1';requestId:string;tenantId:string;edgeId:string;deviceCode:string;mapVersion:string;profileDigest:string;requestedAtMs:number}
export interface FieldLeaseRequest extends FieldLeaseRequestBody {signature:string}
const purpose='idms:field-lease-request:1\n';
export function fieldLeaseRequestBody(raw:unknown):FieldLeaseRequestBody{
 const r=fieldObject(raw,['format','requestId','tenantId','edgeId','deviceCode','mapVersion','profileDigest','requestedAtMs']),requestId=fieldText(r.requestId,36),tenantId=fieldText(r.tenantId,80),edgeId=fieldText(r.edgeId,80),deviceCode=fieldText(r.deviceCode,128),mapVersion=fieldText(r.mapVersion,128),profileDigest=fieldHash(r.profileDigest),requestedAtMs=fieldInteger(r.requestedAtMs,0,8640000000000000);
 if(r.format!=='idms-field-lease-request-v1'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId)||!/^[A-Za-z0-9_-]+$/.test(tenantId)||!/^[A-Za-z0-9_-]+$/.test(edgeId)||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deviceCode))fieldFailure('FIELD_LEASE_REQUEST_INVALID');return {format:'idms-field-lease-request-v1',requestId,tenantId,edgeId,deviceCode,mapVersion,profileDigest,requestedAtMs};
}
const signature=(body:FieldLeaseRequestBody,key:Uint8Array)=>{if(!(key instanceof Uint8Array)||key.byteLength!==32)fieldFailure('FIELD_LEASE_REQUEST_INVALID');return createHmac('sha256',key).update(purpose+stable(body)).digest('hex');};
export function signFieldLeaseRequest(raw:unknown,key:Uint8Array):FieldLeaseRequest{try{const body=fieldLeaseRequestBody(raw),result={...body,signature:signature(body,key)};freezeFieldValue(result);return result;}catch{fieldFailure('FIELD_LEASE_REQUEST_INVALID');}}
export function verifyFieldLeaseRequest(raw:unknown,key:Uint8Array,now:number):FieldLeaseRequest{
 try{const r=fieldObject(raw,['format','requestId','tenantId','edgeId','deviceCode','mapVersion','profileDigest','requestedAtMs','signature']),{signature:supplied,...data}=r,body=fieldLeaseRequestBody(data);
  if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied)||!Number.isSafeInteger(now)||body.requestedAtMs>now||now-body.requestedAtMs>=30000||!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(signature(body,key),'hex')))throw Error();const result={...body,signature:supplied};freezeFieldValue(result);return result;
 }catch{fieldFailure('FIELD_LEASE_REQUEST_INVALID');}
}
