import type {AuditEvent} from './domain.ts';
import type {BatchMetadata} from './batch-evidence.ts';
import type {ImportView,StoredRow} from './imports.ts';
import {canonical} from './imports.ts';
import {revisionFacts} from './import-revisions.ts';
import {DomainError} from './service.ts';
import {calendarTime} from './calendar-schema.ts';

export const importHistoryIntegrity=()=>new DomainError(503,'历史上传批准、提交或更正链不可验证');
export type HistoricalBatchMetadata=Pick<BatchMetadata,'tenantId'|'batchId'|'sourceSystem'|'dataType'|'status'|'version'|'snapshotDigest'|'fileSha256'|'uploader'|'createdAt'|'counts'|'approval'|'committedAt'>&{correction?:Pick<NonNullable<BatchMetadata['correction']>,'supersedesBatchId'>};
export interface ImportHistoryEvidence {approval?:AuditEvent;commit?:AuditEvent;approvalCount:number;commitCount:number;approvalSequence:string;commitSequence:string}
export function importHistoryIndex(events:readonly AuditEvent[],tenant:string){
 const result=new Map<string,ImportHistoryEvidence>();let position=0n;
 for(const a of events){if(a.tenantId!==tenant)continue;position++;if(a.objectType!=='DATA_IMPORT'||!['IMPORT_HUMAN_APPROVED','IMPORT_COMMITTED'].includes(a.action))continue;const e=result.get(a.objectId)||{approvalCount:0,commitCount:0,approvalSequence:'0',commitSequence:'0'};
  if(a.action==='IMPORT_HUMAN_APPROVED'){e.approvalCount++;e.approval=a;e.approvalSequence=String(position);}else {e.commitCount++;e.commit=a;e.commitSequence=String(position);}result.set(a.objectId,e);
 }return result;
}
const sequence=(v:string)=>{if(!/^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)throw importHistoryIntegrity();return BigInt(v);};
export function batchHistory(batch:HistoricalBatchMetadata,e:ImportHistoryEvidence|undefined){
 const a=e?.approval,c=e?.commit,b=batch.approval;
 try{
  if(batch.status!=='COMMITTED'){if(e?.commitCount)throw Error();return null;}
  if(!a||!c||!b||e?.approvalCount!==1||e.commitCount!==1||sequence(e.approvalSequence)>=sequence(e.commitSequence)||a.objectType!=='DATA_IMPORT'||c.objectType!=='DATA_IMPORT'||a.objectId!==batch.batchId||c.objectId!==batch.batchId||a.tenantId!==batch.tenantId||c.tenantId!==batch.tenantId||a.action!=='IMPORT_HUMAN_APPROVED'||c.action!=='IMPORT_COMMITTED'||a.actorType!=='USER'||a.actorId!==b.approver||a.actorId===batch.uploader||c.actorType!=='SYSTEM'||c.actorId!=='demo.import-service'||b.decision!=='APPROVED'||!Number.isSafeInteger(batch.version)||batch.version!==(a.before as {version?:number})?.version!+1||!/^[a-f0-9]{64}$/.test(batch.snapshotDigest)||!/^[a-f0-9]{64}$/.test(batch.fileSha256))throw Error();
  const {snapshotDigest,...approved}=a.metadata;
  if(snapshotDigest!==batch.snapshotDigest||canonical(approved)!==canonical(b)||c.metadata.snapshotDigest!==batch.snapshotDigest||!Number.isSafeInteger(batch.counts.committed)||batch.counts.committed<0||c.metadata.committed!==batch.counts.committed||c.metadata.duplicates!==batch.counts.duplicates)throw Error();
  const approvedAt=calendarTime(a.businessTime),recordedAt=calendarTime(c.businessTime);
  if(calendarTime(batch.createdAt)>approvedAt||calendarTime(b.decidedAt)>approvedAt||approvedAt>recordedAt||calendarTime(batch.committedAt)<approvedAt||calendarTime(batch.committedAt)>recordedAt)throw Error();
  return {recordedAt:c.businessTime,approvalEventId:a.eventId,committedEventId:c.eventId,sequence:e.commitSequence};
 }catch{throw importHistoryIntegrity();}
}
export function historicalImportPlan(batches:readonly HistoricalBatchMetadata[],tenant:string,knownAt:number,get:(id:string)=>ImportHistoryEvidence|undefined){
 if(!Number.isFinite(knownAt))throw importHistoryIntegrity();const all=new Map<string,{batch:HistoricalBatchMetadata;history:NonNullable<ReturnType<typeof batchHistory>>}>(),eligible=new Map<string,{batch:HistoricalBatchMetadata;history:NonNullable<ReturnType<typeof batchHistory>>}>();
 for(const batch of batches){if(batch.tenantId!==tenant)continue;if(all.has(batch.batchId))throw importHistoryIntegrity();const history=batchHistory(batch,get(batch.batchId));if(!history)continue;all.set(batch.batchId,{batch,history});if(Date.parse(history.recordedAt)<=knownAt)eligible.set(batch.batchId,{batch,history});}
 for(const {batch,history}of all.values()){if(!batch.correction)continue;const parent=all.get(batch.correction.supersedesBatchId);if(!parent||parent.batch.dataType!==batch.dataType||parent.batch.sourceSystem!==batch.sourceSystem||sequence(parent.history.sequence)>=sequence(history.sequence)||Date.parse(parent.history.recordedAt)>Date.parse(history.recordedAt)||eligible.has(batch.batchId)&&!eligible.has(parent.batch.batchId))throw importHistoryIntegrity();}
 return eligible;
}
export interface HistoricalImportRecord {record:StoredRow;revision:number;source:{batchId:string;sourceRow:number;snapshotDigest:string;fileSha256:string;recordVersion:number;approvalEventId:string;committedEventId:string;recordedAt:string}}
export function historicalRecord(record:StoredRow,revision:number,plan:ReturnType<typeof historicalImportPlan>):HistoricalImportRecord{
 const b=plan.get(record.batchId);if(!b||record.tenantId!==b.batch.tenantId||record.dataType!==b.batch.dataType||record.sourceSystem!==b.batch.sourceSystem||!Number.isSafeInteger(record.row)||record.row<2||!Number.isSafeInteger(revision)||revision<1)throw importHistoryIntegrity();return {record,revision,source:{batchId:record.batchId,sourceRow:record.row,snapshotDigest:b.batch.snapshotDigest,fileSha256:b.batch.fileSha256,recordVersion:revision,approvalEventId:b.history.approvalEventId,committedEventId:b.history.committedEventId,recordedAt:b.history.recordedAt}};
}
export function historicalImports(data:ImportView,events:readonly AuditEvent[],tenant:string,knownAt:number,account?:(v:unknown)=>void){
 const index=importHistoryIndex(events,tenant),plan=historicalImportPlan(data.batches,tenant,knownAt,id=>index.get(id)),batches=[...plan.values()].sort((a,b)=>sequence(a.history.sequence)<sequence(b.history.sequence)?-1:1).map(x=>data.batches.find(b=>b.batchId===x.batch.batchId&&b.tenantId===tenant)!);
 const records=data.records.filter(r=>r.tenantId===tenant&&plan.has(r.batchId));let facts:ReturnType<typeof revisionFacts>;try{facts=revisionFacts({batches,records},tenant);}catch{throw importHistoryIntegrity();}
 const result=[...facts.current.values()].map(f=>historicalRecord(f.record,f.revision,plan));account?.(result);return result;
}
