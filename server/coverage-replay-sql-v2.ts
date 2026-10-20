import type pg from 'pg';
import {requireAccess,scopeAllows,type AccessContext} from './access.ts';
import {coverageQuery} from './plan-coverage.ts';
import {DomainError} from './service.ts';
import {currentQuery} from './revision-projection.ts';
import {historicalImportRecordsSql} from './asof-imports-sql.ts';
import {readRegistrySql} from './registry-history-sql.ts';
import {sqlCalendarTimeline} from './calendar-history-sql.ts';
import {frozenCoverageIntegrity,type FrozenTelemetry} from './frozen-coverage-v1.ts';
import {freezeCoveragePayloadV2,type FrozenCoverageInputV2} from './frozen-coverage-v2.ts';
import {originalReceiptUuidV2,receiptVerificationVersion} from './receipt-identity-v2.ts';
import {conditions} from './telemetry-quality-sql-v2.ts';
import {streamRows} from './pg-row-stream.ts';
import {accountValue,requestSignal,CapacityError,sqlScheduler,memoryTask} from './capacity.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
const count=(v:unknown)=>{if(!/^(0|[1-9][0-9]*)$/.test(String(v))||!Number.isSafeInteger(Number(v)))throw frozenCoverageIntegrity();return Number(v);};
import {replayQuery,replayDeviceAccessSql,type ReplayQuery} from './coverage-replay-sql.ts';
const timestamp=(col:string)=>`to_char(${col} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
async function telemetryInputs(client:pg.PoolClient,tenant:string,q:ReplayQuery,edges:string[],remaining:number){
 if(!edges.length)return [] as FrozenTelemetry[];const where=`w.tenant_id=$1 AND w.device_code=$2 AND w.edge_id=ANY($3::text[]) AND ($4::text IS NULL OR w.tag_code=$4) AND w.event_time>=$5::timestamptz AND w.event_time<$6::timestamptz AND w.received_at<=$7::timestamptz`,values=[tenant,q.device,edges,q.tag,new Date(q.from).toISOString(),new Date(q.to).toISOString(),new Date(q.knownAt!).toISOString()];
 const heads=(await client.query(`/* IDMS_REPLAY_TELEMETRY_HEAD */ SELECT count(*)::text AS count FROM telemetry_points w WHERE ${where}`,values)).rows;check();if(heads.length!==1)throw frozenCoverageIntegrity();const expected=count(heads[0].count);if(expected>remaining)throw new DomainError(422,'历史完整输入超过25000条，请缩小采集源、测点或时间范围');
 const result:FrozenTelemetry[]=[],seen=new Set<string>();
 await streamRows<any>(client,`/* IDMS_REPLAY_TELEMETRY_ROWS */ SELECT w.tenant_id,w.id::text AS "pointId",w.edge_id AS "edgeId",w.device_code AS "deviceCode",w.tag_code AS "tagCode",${timestamp('w.event_time')} AS "eventTime",${timestamp('w.received_at')} AS "receivedAt",w.input_digest AS "inputDigest",w.origin,w.map_version AS "mapVersion",w.node_id AS "nodeId",w.sequence_no::text AS "sequenceNo",CASE WHEN w.value::text IN ('NaN','Infinity','-Infinity') THEN to_jsonb(w.value::text) ELSE to_jsonb(w.value) END AS value,w.unit,w.quality,
 ((NOT (${conditions.SOURCE_RECEIPT_MISMATCH})) AND EXISTS(SELECT 1 FROM telemetry_receipts r WHERE r.edge_id=w.edge_id AND ${originalReceiptUuidV2} AND r.sequence_no=w.sequence_no AND r.point_id=w.id AND r.status='STORED' AND r.digest=w.input_digest AND r.received_at<=$7::timestamptz)) AS "receiptValid" FROM telemetry_points w WHERE ${where} ORDER BY w.event_time,w.id`,row=>{
  check();accountValue(row);if(row.tenant_id!==tenant||row.deviceCode!==q.device||!edges.includes(row.edgeId)||q.tag&&row.tagCode!==q.tag||typeof row.pointId!=='string'||seen.has(row.pointId))throw frozenCoverageIntegrity();seen.add(row.pointId);const {tenant_id,...item}=row;result.push(item);
 },()=>{result.length=0;seen.clear();},values);check();if(result.length!==expected)throw frozenCoverageIntegrity();return result;
}
// Caller owns one verified RR snapshot, with current authorization checked
// before loading any historical configuration, definitions, or sample bodies.
export async function replayInputsSqlV2(client:pg.PoolClient,ctx:AccessContext,q:ReplayQuery):Promise<FrozenCoverageInputV2>{
 await replayDeviceAccessSql(client,ctx,q.device);
 let registry:FrozenCoverageInputV2['registry']=null,telemetry:FrozenTelemetry[]=[];
 if(q.source==='TELEMETRY'){
  const history=await readRegistrySql(client,ctx.tenantId,q.knownAt!),selected=history.selected;if(!selected)throw new DomainError(422,'截止时间前没有可验证的接入配置观察，不能推断未记录的历史点表');
  registry={revision:selected.revision,observedAt:selected.observed_at,configurationHash:selected.configuration_hash,eventHash:selected.hash,sources:selected.body.sources.filter(s=>s.deviceCode===q.device&&(!q.edge||s.edgeId===q.edge))};
 }
 const imports=await historicalImportRecordsSql(client,ctx.tenantId,q.device,q.knownAt!,q.from,q.to,q.tag,25000,q.source==='UPLOADS');
 if(registry)telemetry=await telemetryInputs(client,ctx.tenantId,q,registry.sources.map(s=>s.edgeId),25000-imports.length);
 const timeline=await sqlCalendarTimeline(client,ctx.tenantId,q.device,q.from,q.to,q.knownAt!),bindings=new Map(timeline.segments.filter(s=>s.calendar).map(s=>[s.calendar!.source.templateId,s.calendar!]));
 const input:FrozenCoverageInputV2={format:'idms-coverage-input-v2',receiptVerificationVersion,tenantId:ctx.tenantId,deviceCode:q.device,source:q.source,query:{from:new Date(q.from).toISOString(),to:new Date(q.to).toISOString(),knownAt:new Date(q.knownAt!).toISOString(),tagCode:q.tag,edgeId:q.edge},imports,telemetry,registry,calendarContext:{schedule:timeline.schedule,calendars:[...bindings.values()],segments:timeline.segments.map(s=>({index:s.index,from:new Date(s.from).toISOString(),to:new Date(s.to).toISOString(),entryId:s.entryId,reason:s.reason,missing:s.missing,calendarId:s.calendar?.source.templateId||null}))}};accountValue(input);check();return input;
}
export async function coverageReplaySqlReadV2(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,verify:(c:pg.PoolClient)=>Promise<void>,now=Date.now()){
 requireAccess(ctx,'read');const q=replayQuery(params,now);
 return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verify(client);const input=await replayInputsSqlV2(client,ctx,q),payload=freezeCoveragePayloadV2(input);accountValue(payload);check();const result={...payload.result,items:payload.result.items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),page:q.page,pageSize:q.pageSize,inputDigest:payload.inputDigest,resultDigest:payload.resultDigest,inputRecordCount:input.imports.length+input.telemetry.length,calendarContext:{schedule:input.calendarContext.schedule,segments:input.calendarContext.segments,calendars:input.calendarContext.calendars.map(c=>c.source)},registryContext:input.registry?{revision:input.registry.revision,observedAt:input.registry.observedAt,configurationHash:input.registry.configurationHash,eventHash:input.registry.eventHash}:null,verificationScope:'FULL_VERIFIED_BUSINESS_AND_REGISTRY_AND_PERSISTED_RECORD_SNAPSHOT'};accountValue(result);check();await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});if(e instanceof DomainError)throw e;throw frozenCoverageIntegrity();}finally{client.release();}},true),requestSignal());
}
