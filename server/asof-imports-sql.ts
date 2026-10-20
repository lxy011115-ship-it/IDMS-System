import type pg from 'pg';
import type {DataType} from './imports.ts';
import {historicalImportPlan,historicalRecord,importHistoryIntegrity,type HistoricalBatchMetadata,type ImportHistoryEvidence,type HistoricalImportRecord} from './asof-imports.ts';
import {streamRows} from './pg-row-stream.ts';
import {DomainError} from './service.ts';
import {accountValue,requestSignal,CapacityError} from './capacity.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
const number=(v:unknown)=>{if(!/^(0|[1-9][0-9]*)$/.test(String(v))||!Number.isSafeInteger(Number(v)))throw importHistoryIntegrity();return Number(v);};
const types=['DEVICE','POINT_DEFINITION','MEASUREMENT'];
export async function historicalImportPlanSql(client:pg.PoolClient,tenant:string,knownAt:number,selectedTypes:readonly DataType[]=types as DataType[]){
 const types=selectedTypes;if(!types.length||new Set(types).size!==types.length||types.some(t=>!['DEVICE','POINT_DEFINITION','MEASUREMENT','PRODUCTION','STATE_INTERVAL','MAINTENANCE','QUALITY'].includes(t)))throw importHistoryIntegrity();
 const heads=(await client.query("/* IDMS_ASOF_BATCH_HEAD */ SELECT count(*)::text AS count FROM business_import_batches WHERE tenant_id=$1 AND data_type=ANY($2::text[])",[tenant,types])).rows;check();if(heads.length!==1)throw importHistoryIntegrity();const expected=number(heads[0].count),batches:HistoricalBatchMetadata[]=[],evidence=new Map<string,ImportHistoryEvidence>();
 const fields=['tenantId','batchId','sourceSystem','dataType','status','version','snapshotDigest','fileSha256','uploader','createdAt','counts','approval','committedAt'];
 const body=`jsonb_build_object(${fields.map(f=>`'${f}',b.body->'${f}'`).join(',')})||CASE WHEN b.body?'correction' THEN jsonb_build_object('correction',jsonb_build_object('supersedesBatchId',b.body->'correction'->'supersedesBatchId')) ELSE '{}'::jsonb END`;
 await streamRows<any>(client,`/* IDMS_ASOF_BATCH_ROWS */ SELECT b.tenant_id,b.batch_id::text,${body} AS body,a.event AS approval,a.sequence AS approval_sequence,a.count AS approval_count,c.event AS commit,c.sequence AS commit_sequence,c.count AS commit_count FROM business_import_batches b
 LEFT JOIN LATERAL (SELECT event,sequence_no::text AS sequence,count(*) OVER()::text AS count FROM audit_ledger WHERE tenant_id=b.tenant_id AND event->>'objectType'='DATA_IMPORT' AND event->>'objectId'=b.batch_id::text AND event->>'action'='IMPORT_HUMAN_APPROVED' ORDER BY sequence_no LIMIT 1) a ON true
 LEFT JOIN LATERAL (SELECT event,sequence_no::text AS sequence,count(*) OVER()::text AS count FROM audit_ledger WHERE tenant_id=b.tenant_id AND event->>'objectType'='DATA_IMPORT' AND event->>'objectId'=b.batch_id::text AND event->>'action'='IMPORT_COMMITTED' ORDER BY sequence_no LIMIT 1) c ON true
 WHERE b.tenant_id=$1 AND b.data_type=ANY($2::text[]) ORDER BY b.ordinal`,row=>{
  check();accountValue(row);if(row.tenant_id!==tenant||row.body?.tenantId!==tenant||row.body?.batchId!==row.batch_id||!types.includes(row.body.dataType)||evidence.has(row.batch_id))throw importHistoryIntegrity();batches.push(row.body);evidence.set(row.batch_id,{approval:row.approval||undefined,commit:row.commit||undefined,approvalCount:number(row.approval_count??0),commitCount:number(row.commit_count??0),approvalSequence:row.approval_sequence||'0',commitSequence:row.commit_sequence||'0'});
 },()=>{batches.length=0;evidence.clear();},[tenant,types]);check();if(batches.length!==expected)throw importHistoryIntegrity();return historicalImportPlan(batches,tenant,knownAt,id=>evidence.get(id));
}
const versions=`WITH versions AS (
 SELECT r.tenant_id,r.ordinal AS root_ordinal,1 AS record_version,r.batch_id::text,r.source_row,r.data_type,r.source_system,r.source_record_id,r.snapshot_digest,r.body FROM managed_import_rows r WHERE r.tenant_id=$1 AND r.data_type=ANY($3::text[])
 UNION ALL
 SELECT r.tenant_id,r.root_ordinal,r.revision,r.batch_id::text,r.source_row,b.data_type,b.source_system,b.source_record_id,r.snapshot_digest,r.body FROM managed_record_revisions r JOIN managed_import_rows b ON b.tenant_id=r.tenant_id AND b.ordinal=r.root_ordinal WHERE r.tenant_id=$1 AND b.data_type=ANY($3::text[])
),selected AS (
 SELECT DISTINCT ON(root_ordinal) * FROM versions WHERE batch_id=ANY($2::text[]) ORDER BY root_ordinal,record_version DESC
),filtered AS (
 SELECT * FROM selected WHERE body->>'device_code'=$4 AND (data_type='DEVICE' OR ($5::text IS NULL OR body->>'tag_code'=$5)) AND (data_type<>'MEASUREMENT' OR (body->>'measured_at')::timestamptz>=$6::timestamptz AND (body->>'measured_at')::timestamptz<$7::timestamptz)
)`;
export async function historicalImportRecordsSql(client:pg.PoolClient,tenant:string,device:string,knownAt:number,from:number,to:number,tag:string|null,limit=25000,includeMeasurements=true){
 const plan=await historicalImportPlanSql(client,tenant,knownAt),values:unknown[]=[tenant,[...plan.keys()],includeMeasurements?types:['DEVICE','POINT_DEFINITION'],device,tag,new Date(from).toISOString(),new Date(to).toISOString()];accountValue(values);
 const heads=(await client.query(`/* IDMS_ASOF_RECORD_HEAD */ ${versions} SELECT count(*)::text AS count FROM filtered`,values)).rows;check();if(heads.length!==1)throw importHistoryIntegrity();const count=number(heads[0].count);if(!Number.isSafeInteger(limit)||limit<1||count>limit)throw new DomainError(422,'历史输入超过25000条，请缩小设备、测点或时间范围');
 const result:HistoricalImportRecord[]=[],seen=new Set<string>();
 await streamRows<any>(client,`/* IDMS_ASOF_RECORD_ROWS */ ${versions} SELECT tenant_id,root_ordinal::text AS root_ordinal,record_version,batch_id,source_row,data_type,source_system,source_record_id,snapshot_digest,body FROM filtered ORDER BY filtered.root_ordinal`,row=>{
  check();accountValue(row);const b=plan.get(row.batch_id);if(row.tenant_id!==tenant||!b||!types.includes(row.data_type)||row.body?.device_code!==device||String(row.body?.source_record_id)!==row.source_record_id||!/^([1-9][0-9]*)$/.test(row.root_ordinal)||seen.has(row.root_ordinal)||row.snapshot_digest!==b.batch.snapshotDigest||row.record_version!==number(row.record_version)||row.record_version<1)throw importHistoryIntegrity();seen.add(row.root_ordinal);
  const record={tenantId:tenant,sourceSystem:row.source_system,dataType:row.data_type,batchId:row.batch_id,row:row.source_row,value:row.body},value=historicalRecord(record,row.record_version,plan);accountValue(value);result.push(value);
 },()=>{result.length=0;seen.clear();},values);check();if(result.length!==count)throw importHistoryIntegrity();return result;
}
