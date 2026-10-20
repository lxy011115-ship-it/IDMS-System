import type pg from 'pg';
import type {DataType} from './imports.ts';
import {historicalImportPlanSql} from './asof-imports-sql.ts';
import {historicalRecord,importHistoryIntegrity,type HistoricalImportRecord} from './asof-imports.ts';
import {streamRows} from './pg-row-stream.ts';
import {DomainError} from './service.ts';
import {accountValue,requestSignal,CapacityError} from './capacity.ts';
export const operationalTypes:readonly DataType[]=Object.freeze(['DEVICE','PRODUCTION','STATE_INTERVAL','MAINTENANCE','QUALITY']);
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
const count=(v:unknown)=>{if(!/^(0|[1-9][0-9]*)$/.test(String(v))||!Number.isSafeInteger(Number(v)))throw importHistoryIntegrity();return Number(v);};
const selected=`WITH versions AS (
 SELECT r.tenant_id,r.ordinal AS root_ordinal,1 AS record_version,r.batch_id::text,r.source_row,r.data_type,r.source_system,r.source_record_id,r.snapshot_digest,r.body FROM managed_import_rows r WHERE r.tenant_id=$1 AND r.data_type=ANY($3::text[])
 UNION ALL
 SELECT r.tenant_id,r.root_ordinal,r.revision,r.batch_id::text,r.source_row,b.data_type,b.source_system,b.source_record_id,r.snapshot_digest,r.body FROM managed_record_revisions r JOIN managed_import_rows b ON b.tenant_id=r.tenant_id AND b.ordinal=r.root_ordinal WHERE r.tenant_id=$1 AND b.data_type=ANY($3::text[])
),selected AS (SELECT DISTINCT ON(root_ordinal) * FROM versions WHERE batch_id=ANY($2::text[]) ORDER BY root_ordinal,record_version DESC),
device_rows AS (SELECT * FROM selected WHERE body->>'device_code'=$4),
episodes AS (SELECT DISTINCT (body->>'failure_time')::timestamptz AS failure_at FROM device_rows WHERE data_type='MAINTENANCE' AND (
 ((body->>'failure_time')::timestamptz>=$5::timestamptz AND (body->>'failure_time')::timestamptz<$6::timestamptz)
 OR ((body->>'failure_time')::timestamptz<$6::timestamptz AND (body->>'repair_end')::timestamptz>$5::timestamptz)
 OR ((body->>'repair_end')::timestamptz>=$5::timestamptz AND (body->>'repair_end')::timestamptz<$6::timestamptz))),
filtered AS (SELECT * FROM device_rows d WHERE data_type='DEVICE'
 OR (data_type='PRODUCTION' AND (body->>'period_start')::timestamptz<$6::timestamptz AND (body->>'period_end')::timestamptz>$5::timestamptz)
 OR (data_type='STATE_INTERVAL' AND (body->>'start_time')::timestamptz<$6::timestamptz AND (body->>'end_time')::timestamptz>$5::timestamptz)
 OR (data_type='QUALITY' AND (body->>'measured_at')::timestamptz>=$5::timestamptz AND (body->>'measured_at')::timestamptz<$6::timestamptz)
 OR (data_type='MAINTENANCE' AND EXISTS(SELECT 1 FROM episodes e WHERE e.failure_at=(body->>'failure_time')::timestamptz)))`;
export async function operationalRecordsSql(client:pg.PoolClient,tenant:string,device:string,from:number,to:number,knownAt:number){
 const plan=await historicalImportPlanSql(client,tenant,knownAt,operationalTypes),values=[tenant,[...plan.keys()],operationalTypes,device,new Date(from).toISOString(),new Date(to).toISOString()];accountValue(values);
 const head=(await client.query(`/* IDMS_OPERATIONAL_IMPORT_HEAD */ ${selected} SELECT count(*)::text AS count FROM filtered`,values)).rows;check();if(head.length!==1)throw importHistoryIntegrity();const expected=count(head[0].count);if(expected>25000)throw new DomainError(422,'运营完整输入超过25000条，请缩小设备或时间范围');const rows:HistoricalImportRecord[]=[],seen=new Set<string>();
 await streamRows<any>(client,`/* IDMS_OPERATIONAL_IMPORT_ROWS */ ${selected} SELECT tenant_id,root_ordinal::text AS root_ordinal,record_version,batch_id,source_row,data_type,source_system,source_record_id,snapshot_digest,body FROM filtered ORDER BY filtered.root_ordinal`,row=>{
  check();accountValue(row);const b=plan.get(row.batch_id);if(row.tenant_id!==tenant||!b||!operationalTypes.includes(row.data_type)||row.body?.device_code!==device||String(row.body?.source_record_id)!==row.source_record_id||!/^[1-9][0-9]*$/.test(row.root_ordinal)||seen.has(row.root_ordinal)||row.snapshot_digest!==b.batch.snapshotDigest||!Number.isSafeInteger(row.record_version)||row.record_version<1)throw importHistoryIntegrity();seen.add(row.root_ordinal);const record={tenantId:tenant,sourceSystem:row.source_system,dataType:row.data_type,batchId:row.batch_id,row:row.source_row,value:row.body},item=historicalRecord(record,row.record_version,plan);accountValue(item);rows.push(item);
 },()=>{rows.length=0;seen.clear();},values);check();if(rows.length!==expected)throw importHistoryIntegrity();return rows;
}

