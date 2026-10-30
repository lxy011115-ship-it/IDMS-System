import {cancelOpenV1,cancelActionV1,cancelUuidV1,cancelFailV1,type CancelOpenV1,type CancelObserveV1} from './predictive-cancel-contract-v1.ts';
import {canonicalDigest} from './canonical-state.ts';
import type {CancelJobActionV1,CancelJobMetaV1} from './predictive-cancel-job-store-v1.ts';
export interface CancelJobCommandV1 {action:CancelJobActionV1;caseId:string;request:CancelOpenV1|CancelObserveV1}
export function cancelJobCommandV1(raw:unknown):CancelJobCommandV1{
 const v=raw as CancelJobCommandV1;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='action,caseId,request'||!cancelUuidV1(v.caseId)||!['OPEN','OBSERVE','REVIEW','CONFIRM','SETTLE'].includes(v.action))cancelFailV1(400,'RECON_JOB_INPUT');
 const request=v.action==='OPEN'?cancelOpenV1(v.request):cancelActionV1(v.action,v.request);if(v.action==='OPEN'&&(request as CancelOpenV1).id!==v.caseId)cancelFailV1(400,'RECON_JOB_CASE_ID');return {action:v.action,caseId:v.caseId,request};
}
export const cancelJobOperationV1=(command:CancelJobCommandV1)=>command.action==='OPEN'?(command.request as CancelOpenV1).id:(command.request as CancelObserveV1).operationId;
export const cancelJobHashesV1=(command:CancelJobCommandV1)=>({requestHash:canonicalDigest(command),domainHash:canonicalDigest({kind:command.action,request:command.request})});
export function verifyCancelJobCommandV1(meta:CancelJobMetaV1,raw:unknown){const command=cancelJobCommandV1(raw),hashes=cancelJobHashesV1(command);if(meta.action!==command.action||meta.caseId!==command.caseId||meta.operationId!==cancelJobOperationV1(command)||meta.requestHash!==hashes.requestHash||meta.domainHash!==hashes.domainHash)cancelFailV1(409,'RECON_JOB_SEALED_COMMAND_BINDING');return command;}
