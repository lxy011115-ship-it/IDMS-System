import type {BatchBody,StoredRow} from '../../server/imports.ts';
import {canonical} from '../../server/imports.ts';
import {canonicalDigest,canonicalEqual} from '../../server/canonical-state.ts';
import {holdAllocation,holdValue} from '../../server/capacity.ts';
import {DomainError} from '../../server/service.ts';
export const coldImportIntegrity=()=>new DomainError(503,'企业冷读取完整来源校验失败');
export function coldRank(value:unknown){if(typeof value!=='string'||!/^[1-9][0-9]{0,18}$/.test(value))throw coldImportIntegrity();const n=BigInt(value);if(n>9223372036854775807n)throw coldImportIntegrity();return n;}
export const coldObject=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const key=(record:StoredRow)=>canonical([record.tenantId,record.sourceSystem,record.dataType,record.value.source_record_id]);
interface Expected {key:string;revision:number;batchId:string;sourceRow:number;previousBatchId:string;previousRow:number;previousDigest:string;beforeDigest:string;afterDigest:string;deviceCode:unknown;release:()=>void}
export interface RevisionSource {kind:'root'|'revision';tenant_id:string;root_ordinal:string;revision:number;batch_id:string;source_row:number;previous_batch_id:string|null;previous_row:number|null;previous_digest:string|null;snapshot_digest:string;body:Record<string,any>;data_type:StoredRow['dataType'];source_system:string;source_record_id:string}
// Only corrected keys and immutable digests are retained. All roots themselves
// are verified in the canonical facts stream; this stream retains one version.
const invalidCorrection=()=>Error('Correction SQL ledger disagrees with immutable history');
export class ColdCorrectionIndex {
 private tenant:string;private expected=new Map<string,Expected[]>();private previousRoot=0n;private current?:{rank:bigint;record:StoredRow;version:number;entries:Expected[];next:number;release:()=>void};private closed=false;private releaseIndex=holdAllocation(65536);private count=0;
 constructor(tenant:string){this.tenant=tenant;}
 add(batch:BatchBody){
  if(this.closed)throw invalidCorrection();if(batch.status!=='COMMITTED'||!batch.correction)return;
  if(batch.tenantId!==this.tenant||batch.rows.length!==batch.correction.baseRows.length||batch.counts.committed!==batch.rows.length||!canonicalEqual(batch.validRows,batch.rows))throw invalidCorrection();
  for(let i=0;i<batch.rows.length;i++){
   const row=batch.rows[i],base=batch.correction.baseRows[i],record={tenantId:this.tenant,dataType:batch.dataType,sourceSystem:batch.sourceSystem,batchId:batch.batchId,row:batch.lineNumbers[i],value:row};
   if(!base||String(row.source_record_id)!==base.sourceRecordId||base.batchId!==batch.correction.supersedesBatchId||!Number.isSafeInteger(base.sourceRow)||base.sourceRow<2||!Number.isSafeInteger(base.revision)||base.revision<2||!/^[a-f0-9]{64}$/.test(base.recordDigest)||!coldObject(base.before)||!Number.isSafeInteger(record.row)||record.row<2)throw invalidCorrection();
   const value={key:key(record),revision:base.revision,batchId:batch.batchId,sourceRow:record.row,previousBatchId:base.batchId,previousRow:base.sourceRow,previousDigest:base.recordDigest,beforeDigest:canonicalDigest(base.before),afterDigest:canonicalDigest(record),deviceCode:row.device_code};
   const releaseValue=holdValue(value);let releaseSlot=()=>{};try{releaseSlot=holdAllocation(128);const list=this.expected.get(value.key)||[];if(list.some(e=>e.batchId===batch.batchId))throw invalidCorrection();list.push({...value,release:()=>{releaseValue();releaseSlot();}});this.expected.set(value.key,list);this.count++;}catch(e){releaseValue();releaseSlot();throw e;}
  }
 }
 private endRoot(){const c=this.current;if(!c)return;if(c.next!==c.entries.length)throw invalidCorrection();this.expected.delete(key(c.record));for(const entry of c.entries)entry.release();c.release();this.current=undefined;}
 accept(row:RevisionSource){
  if(this.closed||row.tenant_id!==this.tenant||!coldObject(row.body)||!Number.isSafeInteger(row.source_row)||row.source_row<2||typeof row.source_system!=='string'||String(row.body.source_record_id)!==row.source_record_id)throw invalidCorrection();const rank=coldRank(row.root_ordinal);
  const record:StoredRow={tenantId:row.tenant_id,dataType:row.data_type,sourceSystem:row.source_system,batchId:row.batch_id,row:row.source_row,value:row.body};
  if(row.kind==='root'){
   this.endRoot();if(rank<=this.previousRoot||row.revision!==1||row.previous_batch_id!==null||row.previous_row!==null||row.previous_digest!==null)throw invalidCorrection();this.previousRoot=rank;
   const entries=this.expected.get(key(record));if(!entries?.length)throw invalidCorrection();this.current={rank,record,version:1,entries,next:0,release:holdValue(record)};return;
  }
  const c=this.current,entry=c?.entries[c.next];if(row.kind!=='revision'||!c||rank!==c.rank||!entry||row.revision!==c.version+1||row.revision!==entry.revision||key(record)!==entry.key||row.batch_id!==entry.batchId||row.source_row!==entry.sourceRow||row.previous_batch_id!==entry.previousBatchId||row.previous_row!==entry.previousRow||row.previous_digest!==entry.previousDigest||c.record.batchId!==entry.previousBatchId||c.record.row!==entry.previousRow||canonicalDigest(c.record)!==entry.previousDigest||canonicalDigest(c.record.value)!==entry.beforeDigest||record.value.device_code!==c.record.value.device_code||record.value.device_code!==entry.deviceCode||canonicalDigest(record)!==entry.afterDigest)throw invalidCorrection();
  const release=holdValue(record);c.release();c.release=release;c.record=record;c.version=row.revision;c.next++;
 }
 finish(){if(this.closed)throw invalidCorrection();this.endRoot();if(this.expected.size)throw invalidCorrection();return this.count;}
 dispose(){if(this.closed)return;this.closed=true;this.current?.release();this.current=undefined;for(const entries of this.expected.values())for(const e of entries)e.release();this.expected.clear();this.releaseIndex();}
}
