import {canonical,authorize,type BatchBody,type ImportView} from './imports.ts';
import {effectiveRecords} from './import-revisions.ts';
import {scopeAllows,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {csv} from './data-export.ts';

export function correctionReviewCsv(data:ImportView,batch:BatchBody,ctx:AccessContext){
 authorize(ctx,'read');if(batch.tenantId!==ctx.tenantId)throw new DomainError(404,'更正批次不存在');
 if(!batch.correction)throw new DomainError(404,'此批次不是更正批次');
 const assets=new Map(effectiveRecords(data).filter(r=>r.tenantId===ctx.tenantId&&r.dataType==='DEVICE').map(r=>[r.value.device_code,r.value]));
 const rows:unknown[][]=[];
 for(let i=0;i<batch.rows.length;i++){
  const before=batch.correction.baseRows[i],after=batch.rows[i],asset=assets.get(after.device_code)||{};
  if(!scopeAllows(ctx,batch.dataType==='DEVICE'?before.before:asset)||!scopeAllows(ctx,batch.dataType==='DEVICE'?after:asset))throw new DomainError(403,'更正记录不在当前数据范围内');
  for(const field of new Set([...Object.keys(before.before),...Object.keys(after)]))if(canonical(before.before[field])!==canonical(after[field]))rows.push([before.sourceRecordId,before.revision,field,before.before[field],after[field],before.batchId,before.sourceRow,before.recordDigest,batch.lineNumbers[i],batch.snapshotDigest]);
 }
 return csv(['source_record_id','new_revision','field','before','after','base_batch_id','base_source_row','previous_record_digest','new_source_row','new_snapshot_digest'],rows);
}
