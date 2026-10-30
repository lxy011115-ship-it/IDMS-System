import {uuid,terminal,safeRecords as baseRecords,unresolved as baseUnresolved} from './predictive-console-protocol-v4.js';
export * from './predictive-console-protocol-v4.js';
const statuses=new Set(['UNKNOWN','ACCEPTED','RUNNING','WAITING_AUTH','RETRY','HUMAN_REVIEW',...terminal]);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
/** A recovery reference is never a stored authorization or business payload. */
export function safeRecords(input){
 if(!Array.isArray(input))return [];const result=[],seen=new Set();
 for(const raw of input){let r;
  if(raw?.kind==='ADOPTION'){
   if(!uuid(raw.controlId)||!uuid(raw.commandId)||raw.jobId!==undefined&&!uuid(raw.jobId)||raw.expectedNativeHash!==undefined&&!hash(raw.expectedNativeHash)||typeof raw.recoverClosedAcceptance!=='boolean')continue;
   r={kind:'ADOPTION',controlId:raw.controlId,commandId:raw.commandId,recoverClosedAcceptance:raw.recoverClosedAcceptance,status:statuses.has(raw.status)?raw.status:'UNKNOWN',...(raw.expectedNativeHash?{expectedNativeHash:raw.expectedNativeHash}:{}),...(raw.jobId?{jobId:raw.jobId}:{}),...(['ANALYZE','REVIEW'].includes(raw.action)?{action:raw.action}:{})};
  }else r=baseRecords([raw])[0];
  if(!r)continue;const id=r.kind+':'+(r.kind==='COMMAND'?r.commandId:r.controlId);if(seen.has(id))continue;seen.add(id);result.push(r);if(result.length===30)break;
 }return result;
}
export const unresolved=r=>baseUnresolved(r)||r.kind==='ADOPTION'&&r.status==='UNKNOWN';
