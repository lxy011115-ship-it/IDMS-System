import {DomainError} from './service.ts';
import {authorize,canonical,getBatch,type ImportView,type BatchBody,type RowError,type StoredRow} from './imports.ts';
import {revisionFacts,recordKey} from './import-revisions.ts';
import type {AccessContext} from './access.ts';
export class BatchReadError extends DomainError {readonly code:string;constructor(status:number,code:string,message:string){super(status,message);this.code=code;}}
export const batchReadIntegrity=()=>new BatchReadError(503,'BATCH_READ_INTEGRITY','批次来源暂无法核对，请稍后重试');
export interface BatchPagePlan {page:number;pageSize:number;snapshotDigest?:string}
export interface BatchDescriptor {batchId:string;tenantId:string;dataType:string;sourceSystem:string;status:string;version:number;snapshotDigest:string;fileSha256:string;hasCorrection:boolean}
export interface InputPageItem {inputOrdinal:number;sourceRow:number;validOrdinal:number|null;validation:'VALIDATED'|'ERRORS'|'NOT_SELECTED';value:Record<string,unknown>;errors:RowError[]}
export interface FactPageItem {record:StoredRow;source:{snapshotDigest:string;recordVersion:number;supersedesBatchId:string|null;previousSourceRow:number|null;previousRecordDigest:string|null}}
export function parseBatchPage(params:URLSearchParams):BatchPagePlan{
 if([...params.keys()].some(k=>!['page','pageSize','snapshotDigest'].includes(k))||new Set(params.keys()).size!==[...params.keys()].length)throw new BatchReadError(400,'BATCH_PAGE_QUERY','分页参数无效');
 const integer=(name:string,fallback:number,max:number)=>{const v=params.get(name);if(v===null)return fallback;const n=Number(v);if(!/^[1-9][0-9]*$/.test(v)||!Number.isSafeInteger(n)||n>max)throw new BatchReadError(400,'BATCH_PAGE_QUERY','分页参数须为有效正整数');return n;};
 const snapshotDigest=params.get('snapshotDigest');if(snapshotDigest!==null&&!/^[a-f0-9]{64}$/.test(snapshotDigest))throw new BatchReadError(400,'BATCH_PAGE_QUERY','输入摘要格式无效');return {page:integer('page',1,1000000),pageSize:integer('pageSize',50,100),...(snapshotDigest!==null?{snapshotDigest}:{})};
}
export function assertBatchPin(batch:BatchDescriptor,plan:BatchPagePlan){if(plan.snapshotDigest!==undefined&&plan.snapshotDigest!==batch.snapshotDigest)throw new BatchReadError(409,'BATCH_INPUT_CHANGED','批次输入版本已变化，请重新打开批次');}
export function batchPageEnvelope(batch:BatchDescriptor,plan:BatchPagePlan,kind:'rows'|'records',total:number,items:InputPageItem[]|FactPageItem[]){
 if(!Number.isSafeInteger(total)||total<0||items.length>plan.pageSize)throw batchReadIntegrity();
 return {batchId:batch.batchId,dataType:batch.dataType,sourceSystem:batch.sourceSystem,status:batch.status,batchVersion:batch.version,snapshotDigest:batch.snapshotDigest,fileSha256:batch.fileSha256,kind,items,total,page:plan.page,pageSize:plan.pageSize,hasPrevious:plan.page>1&&total>0,hasNext:plan.page*plan.pageSize<total,verificationScope:'SERVER_FULL_TENANT_CANONICAL',notice:kind==='rows'?'冻结的是标准化输入行；有效行不等于已批准入库。':'展示本批批准时的历史记录，更正后的当前值请查看记录历史。'};
}
export function inputPageItem(inputOrdinal:number,sourceRow:unknown,validOrdinal:unknown,value:unknown,errors:RowError[]):InputPageItem{
 if(!Number.isSafeInteger(inputOrdinal)||inputOrdinal<1||!Number.isSafeInteger(sourceRow)||(sourceRow as number)<1||validOrdinal!==null&&(!Number.isSafeInteger(validOrdinal)||(validOrdinal as number)<1)||!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(errors))throw batchReadIntegrity();
 return {inputOrdinal,sourceRow:sourceRow as number,validOrdinal:validOrdinal as number|null,validation:validOrdinal!==null?'VALIDATED':errors.length?'ERRORS':'NOT_SELECTED',value:value as Record<string,unknown>,errors};
}
const filePage=(...args:Parameters<typeof batchPageEnvelope>)=>({...batchPageEnvelope(...args),verificationScope:'FILE_DEMO_ARRAY_MODEL'});
const descriptor=(batch:BatchBody):BatchDescriptor=>({batchId:batch.batchId,tenantId:batch.tenantId,dataType:batch.dataType,sourceSystem:batch.sourceSystem,status:batch.status,version:batch.version,snapshotDigest:batch.snapshotDigest,fileSha256:batch.fileSha256,hasCorrection:!!batch.correction});
// File adapter is explicitly an array path. It never pretends a page is a full BatchBody.
export function fileBatchPage(data:ImportView,id:string,ctx:AccessContext,plan:BatchPagePlan,kind:'rows'|'records'){
 authorize(ctx,'read');const batch=getBatch(data,id,ctx),desc=descriptor(batch);assertBatchPin(desc,plan);const start=(plan.page-1)*plan.pageSize;
 if(kind==='rows'){
  const remaining=new Map<string,{ordinals:number[];used:number}>();batch.validRows.forEach((r,i)=>{const key=canonical(r),entry=remaining.get(key)||{ordinals:[],used:0};entry.ordinals.push(i+1);remaining.set(key,entry);});
  const selected:InputPageItem[]=[];batch.rows.forEach((r,i)=>{const entry=remaining.get(canonical(r)),valid=entry&&entry.used<entry.ordinals.length?entry.ordinals[entry.used++]:null;if(i>=start&&i<start+plan.pageSize)selected.push(inputPageItem(i+1,batch.lineNumbers[i],valid,r,batch.errors.filter(e=>e.row===batch.lineNumbers[i])));});return filePage(desc,plan,kind,batch.rows.length,selected);
 }
 if(batch.status!=='COMMITTED')return filePage(desc,plan,kind,0,[]);
 const roots=new Map(data.records.map((r,i)=>[recordKey(r),i+1]));const rows:(FactPageItem&{root:number})[]=data.records.filter(r=>r.tenantId===ctx.tenantId&&r.batchId===id).map(r=>({record:r,root:roots.get(recordKey(r))!,source:{snapshotDigest:batch.snapshotDigest,recordVersion:1,supersedesBatchId:null,previousSourceRow:null,previousRecordDigest:null}}));
 for(const f of revisionFacts(data,ctx.tenantId).facts)if(f.record.batchId===id)rows.push({record:f.record,root:roots.get(recordKey(f.root))!,source:{snapshotDigest:f.snapshotDigest,recordVersion:f.revision,supersedesBatchId:f.previous.batchId,previousSourceRow:f.previous.row,previousRecordDigest:canonicalDigestRecord(f.previous)}});
 rows.sort((a,b)=>a.record.row-b.record.row||a.root-b.root||a.source.recordVersion-b.source.recordVersion);return filePage(desc,plan,kind,rows.length,rows.slice(start,start+plan.pageSize).map(({root,...r})=>r));
}
import {digest} from './imports.ts';
const canonicalDigestRecord=(r:StoredRow)=>digest(canonical(r));
