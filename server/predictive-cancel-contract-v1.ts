import {DomainError} from './service.ts';
import type {WorkflowReservationResultV1} from './workflow-cancel-reservation-transport-v1.ts';
export const cancelReconciliationFormatV1='IDMS_PREDICTIVE_CANCEL_RECONCILIATION_V1';
export const cancelHashV1=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const cancelUuidV1=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const cancelOrdinalV1=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<9223372036854775807n;
export const cancelFailV1=(status:number,code:string):never=>{throw new DomainError(status,code);};
export const cancelWireV1=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
export interface CancelOpenV1 {id:string;commandId:string;expectedNativeHash:string}
export interface CancelObserveV1 {operationId:string;expectedRevision:string}
export interface CancelReviewV1 extends CancelObserveV1 {evidenceDigest:string;decision:'APPROVE'|'RETURN';comment:string}
export interface CancelConfirmV1 extends CancelObserveV1 {evidenceDigest:string;comment:string}
export interface CancelSettleV1 extends CancelObserveV1 {comment:string}
function object(raw:unknown,fields:string[]){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!==fields.sort().join(','))cancelFailV1(400,'RECONCILIATION_INPUT');return raw as Record<string,unknown>;}
const comment=(v:unknown)=>typeof v==='string'&&v.trim().length>=2&&v.length<=2000;
export function cancelOpenV1(raw:unknown):CancelOpenV1{const v=object(raw,['id','commandId','expectedNativeHash']);if(!cancelUuidV1(v.id)||!cancelUuidV1(v.commandId)||!cancelHashV1(v.expectedNativeHash))cancelFailV1(400,'RECONCILIATION_OPEN_INPUT');return cancelWireV1(v) as unknown as CancelOpenV1;}
export function cancelActionV1<T extends CancelObserveV1>(kind:'OBSERVE'|'REVIEW'|'CONFIRM'|'SETTLE',raw:unknown):T{
 const fields=['operationId','expectedRevision',...(kind==='OBSERVE'?[]:['comment']),...(['REVIEW','CONFIRM'].includes(kind)?['evidenceDigest']:[]),...(kind==='REVIEW'?['decision']:[])],v=object(raw,fields);
 if(!cancelUuidV1(v.operationId)||!cancelOrdinalV1(v.expectedRevision)||kind!=='OBSERVE'&&!comment(v.comment)||['REVIEW','CONFIRM'].includes(kind)&&!cancelHashV1(v.evidenceDigest)||kind==='REVIEW'&&!['APPROVE','RETURN'].includes(String(v.decision)))cancelFailV1(400,'RECONCILIATION_ACTION_INPUT');return cancelWireV1(v) as unknown as T;
}
export interface CancelReviewWitnessV1 {actorId:string;identityHash:string;sessionHash:string;sessionCreatedAt:number;at:number;operationId:string;evidenceDigest:string;decision:'APPROVE'|'RETURN';comment:string}
export interface CancelBusinessEvidenceV1 {eligible:boolean;reason:string|null;digest:string}
export interface CancelCaseV1 {
 format:typeof cancelReconciliationFormatV1;tenantId:string;id:string;configuration:string;originalActorId:string;commandId:string;jobKey:string;nativeHash:string;cancelReceiptHash:string;planDigest:string;deviceCode:string;alertId:string;orderId:string;
 revision:string;status:'OPEN'|'AWAITING_REVIEW'|'AWAITING_ORIGINAL_CONFIRMATION'|'RETURNED'|'RELEASE_PENDING'|'RESOLVED_BLOCKED'|'RESOLVED_LINKED'|'NEEDS_ATTENTION';
 openedAt:number;openingSessionHash:string;intentHeld:boolean;observed:null|{external:WorkflowReservationResultV1;business:CancelBusinessEvidenceV1;evidenceDigest:string;at:number};review:CancelReviewWitnessV1|null;
 confirmation:null|{actorId:string;identityHash:string;sessionHash:string;sessionCreatedAt:number;at:number;operationId:string;comment:string};releaseDigest:string|null;linkedOrderId:string|null;attentionReason:string|null;
}
