import {fullBatchEvidence,metadataBatchEvidence,type BatchEvidence,type MetadataBatchEvidence,type BatchMetadata,type FrozenInputEvidence} from './batch-evidence.ts';
import {canonical,digest,authorize,definitions,type ImportData,type ImportView,type BatchBody,type StoredRow,type Batch,type Row} from './imports.ts';
import {DomainError} from './service.ts';
import {scopeAllows,type AccessContext} from './access.ts';
import type {Store} from './store.ts';
import {mappedSnapshotFields} from './import-mapping.ts';

export interface CorrectionBinding {
  supersedesBatchId:string;reason:string;
  baseRows:{sourceRecordId:string;batchId:string;sourceRow:number;recordDigest:string;revision:number;before:Row}[];
}
export const recordKey=(r:StoredRow)=>canonical([r.tenantId,r.sourceSystem,r.dataType,r.value.source_record_id]);
export function batchInputFields(b:BatchMetadata){
  if(b.mappingBinding)return mappedSnapshotFields(b);
  return {templateVersion:b.templateVersion,ruleVersion:'upload-rules-1.0.0',sourceSystem:b.sourceSystem,dataType:b.dataType,...(b.correction||b.equipmentProfileBinding?{...(b.correction?{correction:b.correction}:{}),...(b.equipmentProfileBinding?{equipmentProfileBinding:b.equipmentProfileBinding}:{}),fileSha256:b.fileSha256,lineNumbers:b.lineNumbers}: {})};
}
export function batchInputValue(b:BatchBody){return {rows:b.rows,...batchInputFields(b)};}
export function fullFrozenInputEvidence(b:BatchBody):FrozenInputEvidence{return {rowCount:b.rows.length,digest:()=>batchInputDigest(b),profileReferencesMatch:ref=>b.rows.every(row=>row.source_profile_ref===ref)};}
export function batchInputDigest(b:BatchBody){return digest(canonical(batchInputValue(b)));}
export function verifyCorrectionBatch(store:Store,b:Batch){return verifyCorrectionEvidence(fullBatchEvidence(store),b);}
export function verifyCorrectionEvidence(evidence:BatchEvidence,b:BatchBody){return verifyCorrectionMetadataEvidence(metadataBatchEvidence(evidence,b),b,fullFrozenInputEvidence(b));}
export function verifyCorrectionMetadataEvidence(evidence:MetadataBatchEvidence,b:BatchMetadata,input:FrozenInputEvidence){
  const anchors=evidence.received(b.tenantId,b.batchId);
  if(!b.correction&&!anchors.hasCorrection)return;
  if(!b.correction||anchors.count!==1||canonical(anchors.first!.metadata?.correction)!==canonical(b.correction)||anchors.first!.metadata?.snapshotDigest!==b.snapshotDigest||b.snapshotDigest!==input.digest()||!evidence.originalMatches(b))throw new DomainError(409,'更正冻结输入与原接收审计不一致');
}
export function revisionFacts(data:ImportView,tenantId?:string){
  const current=new Map(data.records.filter(r=>!tenantId||r.tenantId===tenantId).map(r=>[recordKey(r),{record:r,root:r,revision:1}]));
  const facts:{record:StoredRow;root:StoredRow;previous:StoredRow;revision:number;snapshotDigest:string}[]=[];
  for(const b of data.batches){
    if(b.status!=='COMMITTED'||!b.correction||(tenantId&&b.tenantId!==tenantId))continue;
    if(b.snapshotDigest!==batchInputDigest(b)||b.rows.length!==b.correction.baseRows.length||b.counts.committed!==b.rows.length||canonical(b.validRows)!==canonical(b.rows))throw new DomainError(409,'更正历史输入或提交行不一致');
    const seen=new Set<string>();
    for(let i=0;i<b.rows.length;i++){
      const row=b.rows[i],base=b.correction.baseRows[i],record={tenantId:b.tenantId,sourceSystem:b.sourceSystem,dataType:b.dataType,batchId:b.batchId,row:b.lineNumbers[i],value:row},key=recordKey(record),old=current.get(key);
      if(seen.has(key)||!old||String(row.source_record_id)!==base.sourceRecordId||base.batchId!==b.correction.supersedesBatchId||old.record.batchId!==base.batchId||old.record.row!==base.sourceRow||digest(canonical(old.record))!==base.recordDigest||canonical(old.record.value)!==canonical(base.before)||base.revision!==old.revision+1||row.device_code!==old.record.value.device_code)throw new DomainError(409,'更正历史版本链断裂或冲突');
      seen.add(key);const fact={record,root:old.root,previous:old.record,revision:base.revision,snapshotDigest:b.snapshotDigest};facts.push(fact);current.set(key,{record,root:old.root,revision:base.revision});
    }
  }
  return {current,facts};
}
export function effectiveRecords(data:ImportView){if(!data.batches.some(b=>b.correction&&b.status==='COMMITTED'))return data.records;return [...revisionFacts(data).current.values()].map(v=>v.record);}
export function bindCorrection(data:ImportData,ctx:AccessContext,type:string,sourceSystem:string,rows:Row[],parent:unknown,reason:unknown):CorrectionBinding|undefined{
  if(parent===undefined&&reason===undefined)return;
  if(typeof parent!=='string'||typeof reason!=='string'||reason.trim().length<2||reason.trim().length>2000)throw new DomainError(400,'更正必须指定原批次及2至2000字符的理由');
  const original=data.batches.find(b=>b.tenantId===ctx.tenantId&&b.batchId===parent);
  if(!original)throw new DomainError(404,'本企业原批次不存在');
  if(original.status!=='COMMITTED'||original.dataType!==type||original.sourceSystem!==sourceSystem)throw new DomainError(409,'更正须引用同类型、同来源的已提交批次');
  const {current}=revisionFacts(data,ctx.tenantId),assets=new Map([...current.values()].filter(v=>v.record.dataType==='DEVICE').map(v=>[v.record.value.device_code,v.record.value]));
  const seen=new Set<string>();
  const baseRows=rows.map(row=>{
    const id=String(row.source_record_id),key=canonical([ctx.tenantId,sourceSystem,type,row.source_record_id]),old=current.get(key);
    if(seen.has(id))throw new DomainError(400,'更正批次不能包含重复来源记录ID');seen.add(id);
    if(!old||old.record.batchId!==parent)throw new DomainError(409,'只能更正原批次中当前有效的记录，不能新增或覆盖已更正版本');
    if(!scopeAllows(ctx,old.record.dataType==='DEVICE'?old.record.value:assets.get(old.record.value.device_code)||{}))throw new DomainError(403,'原记录不在授权数据范围内');
    if(row.device_code!==old.record.value.device_code||(type==='POINT_DEFINITION'&&row.tag_code!==old.record.value.tag_code))throw new DomainError(400,'更正不得改变设备编码或测点定义编码');
    if(canonical(row)===canonical(old.record.value))throw new DomainError(400,'更正记录没有变化');
    return {sourceRecordId:id,batchId:parent,sourceRow:old.record.row,recordDigest:digest(canonical(old.record)),revision:old.revision+1,before:structuredClone(old.record.value)};
  });
  return {supersedesBatchId:parent,reason:reason.trim(),baseRows};
}
export function withoutCorrectionTargets(data:ImportData,binding:CorrectionBinding,tenantId:string,sourceSystem:string,type:string):ImportData{
  const ids=new Set(binding.baseRows.map(r=>r.sourceRecordId));
  return {batches:[],requests:[],records:effectiveRecords(data).filter(r=>!(r.tenantId===tenantId&&r.sourceSystem===sourceSystem&&r.dataType===type&&ids.has(String(r.value.source_record_id))))};
}
export function recordHistory(data:ImportView,ctx:AccessContext,params:URLSearchParams){
  authorize(ctx,'read');const keys=['dataType','sourceSystem','sourceRecordId'];
  if([...params.keys()].length!==3||keys.some(k=>!params.get(k)||params.getAll(k).length!==1||params.get(k)!.length>128))throw new DomainError(400,'历史查询须唯一指定类型、来源系统、来源记录ID');
  const key=canonical([ctx.tenantId,params.get('sourceSystem'),params.get('dataType'),params.get('sourceRecordId')]),{current,facts}=revisionFacts(data,ctx.tenantId),latest=current.get(key);
  if(!latest)throw new DomainError(404,'记录不存在');
  const assets=new Map([...current.values()].filter(v=>v.record.dataType==='DEVICE').map(v=>[v.record.value.device_code,v.record.value]));
  const chain=[{record:latest.root,revision:1},...facts.filter(f=>recordKey(f.record)===key)];
  if(chain.some(f=>!scopeAllows(ctx,f.record.dataType==='DEVICE'?f.record.value:assets.get(f.record.value.device_code)||{})))throw new DomainError(404,'记录不存在');
  return {fields:definitions[latest.record.dataType].fields,items:chain.map(({record,revision})=>{const b=data.batches.find(b=>b.tenantId===ctx.tenantId&&b.batchId===record.batchId)!;return {record,revision,effective:revision===latest.revision,snapshotDigest:b.snapshotDigest,approvedAt:b.committedAt,approval:b.approval,reason:b.correction?.reason||null,...(b.equipmentProfileBinding?{equipmentProfileBinding:structuredClone(b.equipmentProfileBinding)}:{})};}),total:chain.length};
}
