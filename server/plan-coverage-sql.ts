import type pg from 'pg';
import type {AccessContext} from './access.ts';
import {requireAccess} from './access.ts';
import type {EdgeSource} from '../integrations/telemetry.ts';
import {DomainError} from './service.ts';
import {sqlScheduler,memoryTask,accountValue,requestSignal,CapacityError} from './capacity.ts';
import {qualitySources} from './telemetry-quality.ts';
import {qualitySqlPlans,conditions} from './telemetry-quality-sql.ts';
import {calendarFor} from './operation-calendar.ts';
import {coverageQuery,coveragePlan,coverageResult,coverageResponse,coverageCount,segmentCoverage,timelineCoverageResponse,type CoverageQuery} from './plan-coverage.ts';
import {sqlCalendarTimeline} from './calendar-history-sql.ts';
import type {QualityPoint} from './telemetry-quality.ts';

const cancelled=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
const integrity=()=>new DomainError(503,'计划覆盖快照、日历或来源绑定不可验证');
export async function sqlCalendar(client:pg.PoolClient,tenant:string,device:string){
 const rows=(await client.query(`/* IDMS_COVERAGE_CALENDAR */ SELECT count(*)::text AS total,COALESCE(jsonb_agg(jsonb_build_object('tenantId',t.tenant_id,'id',t.id,'body',t.body,'anchor',a.event)),'[]'::jsonb) AS items FROM business_templates t LEFT JOIN LATERAL (SELECT event FROM audit_ledger WHERE tenant_id=t.tenant_id AND event->>'objectType'='TEMPLATE' AND event->>'objectId'=t.id ORDER BY sequence_no DESC LIMIT 1) a ON true WHERE t.tenant_id=$1 AND t.body->'manifest'->>'purpose'='operation-calendar' AND t.body->>'status'='PUBLISHED' AND t.body->'manifest'->'operationCalendar'->>'deviceCode'=$2`,[tenant,device])).rows;accountValue(rows);cancelled();
 if(rows.length!==1||!Array.isArray(rows[0].items)||coverageCount(rows[0].total)!==rows[0].items.length||rows[0].items.length>1)throw integrity();
 const items=rows[0].items;for(const r of items)if(r.tenantId!==tenant||r.id!==r.body?.id||r.body.tenantId!==tenant)throw integrity();
 return calendarFor(items.map((r:any)=>r.body),tenant,device,id=>items.find((r:any)=>r.id===id)?.anchor);
}
export const plannedTelemetrySql=`/* IDMS_COVERAGE_TELEMETRY */ WITH plan AS (
 SELECT * FROM jsonb_to_recordset($2::jsonb) AS p(idx integer,edge_id text,device_code text,tag_code text,node_id text,unit text,map_version text,origin text,definition_unit text,minimum float8,maximum float8,segment_from timestamptz,segment_to timestamptz)
),runs AS (
 SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(idx integer,run_idx integer,start_time timestamptz,end_time timestamptz,anchor timestamptz,step_millis bigint)
),window_rows AS MATERIALIZED (
 SELECT p.idx,t.* FROM plan p JOIN telemetry_points t ON t.tenant_id=$1 AND t.edge_id=p.edge_id AND t.device_code=p.device_code AND t.tag_code=p.tag_code WHERE t.event_time>=$4::timestamptz AND t.event_time<$5::timestamptz AND (p.segment_from IS NULL OR t.event_time>=p.segment_from) AND (p.segment_to IS NULL OR t.event_time<p.segment_to)
),slots AS MATERIALIZED (
 SELECT w.idx,r.run_idx,floor(extract(epoch FROM (w.event_time-r.anchor))*1000/r.step_millis)::bigint AS slot,
 (w.quality='GOOD' AND w.value IS NOT NULL AND w.value::text NOT IN ('NaN','Infinity','-Infinity') AND p.definition_unit IS NOT NULL AND w.unit=p.definition_unit AND w.value>=p.minimum AND w.value<=p.maximum AND NOT (${conditions.POINT_MAP_UNIT_MISMATCH}) AND NOT (${conditions.SOURCE_BINDING_MISMATCH}) AND NOT (${conditions.SOURCE_RECEIPT_MISMATCH})) AS good_valid
 FROM window_rows w JOIN plan p USING(idx) JOIN runs r ON r.idx=w.idx AND w.event_time>=r.start_time AND w.event_time<r.end_time
)
SELECT p.idx,p.edge_id,p.device_code,p.tag_code,(SELECT count(*)::text FROM window_rows w WHERE w.idx=p.idx) AS records,
 (SELECT count(*)::text FROM window_rows w WHERE w.idx=p.idx AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.idx=w.idx AND w.event_time>=r.start_time AND w.event_time<r.end_time)) AS outside_planned_records,
 (SELECT count(*)::text FROM slots s WHERE s.idx=p.idx) AS planned_records,
 (SELECT count(DISTINCT (s.run_idx,s.slot))::text FROM slots s WHERE s.idx=p.idx) AS received_slots,
 (SELECT count(DISTINCT (s.run_idx,s.slot)) FILTER (WHERE s.good_valid)::text FROM slots s WHERE s.idx=p.idx) AS good_valid_slots FROM plan p ORDER BY p.idx`;
export async function telemetryCoverageSqlRead(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,registry:readonly EdgeSource[],verify:(c:pg.PoolClient)=>Promise<void>,now=Date.now()){
 requireAccess(ctx,'read');const q=coverageQuery(params,now),sources=qualitySources(registry,ctx.tenantId);
 return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{
  const client=await pool.connect();try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verify(client);cancelled();
   const selected=(await qualitySqlPlans(client,ctx,sources,q)).points;accountValue(selected);if(!selected.length){await client.query('COMMIT');return q.planMode==='EFFECTIVE'?timelineCoverageResponse([],q,'TELEMETRY',null,now):coverageResponse([],q,'TELEMETRY',null,now);}
   if(q.planMode==='EFFECTIVE'){const result=await effectiveTelemetry(client,ctx,q,selected,now);cancelled();await client.query('COMMIT');return result;}
   const binding=await sqlCalendar(client,ctx.tenantId,q.device),plans=selected.map(p=>coveragePlan(binding,q.from,q.to,p.definition?.interval||null));accountValue(plans);
   const wire=selected.map(p=>({idx:p.index,edge_id:p.edgeId,device_code:p.deviceCode,tag_code:p.tagCode,node_id:p.nodeId,unit:p.unit,map_version:p.mapVersion,origin:p.origin,definition_unit:p.definition?.unit||null,minimum:p.definition?.min??null,maximum:p.definition?.max??null})),runs=plans.flatMap((p,idx)=>p.runs.map(r=>({idx,run_idx:r.index,start_time:new Date(r.from).toISOString(),end_time:new Date(r.to).toISOString(),anchor:new Date(r.anchor).toISOString(),step_millis:p.interval!*1000}))),wireText=JSON.stringify(wire),runsText=JSON.stringify(runs);accountValue(wire);accountValue(runs);accountValue(wireText);accountValue(runsText);
   const rows=(await client.query(plannedTelemetrySql,[ctx.tenantId,wireText,runsText,new Date(q.from).toISOString(),new Date(q.to).toISOString()])).rows;accountValue(rows);cancelled();
   if(rows.length!==selected.length||rows.some((r,i)=>r.idx!==i||r.edge_id!==selected[i].edgeId||r.device_code!==selected[i].deviceCode||r.tag_code!==selected[i].tagCode||coverageCount(r.records)!==coverageCount(r.planned_records)+coverageCount(r.outside_planned_records)))throw integrity();
   const items=selected.map((p,i)=>({deviceCode:p.deviceCode,edgeId:p.edgeId,tagCode:p.tagCode,tagName:p.definition?.name||null,configuredOrigin:p.origin,expectedIntervalSeconds:p.definition?.interval||null,definitionSource:p.definition?.source||null,...coverageResult(plans[i],{records:coverageCount(rows[i].records),plannedRecords:coverageCount(rows[i].planned_records),receivedSlots:coverageCount(rows[i].received_slots),goodValidSlots:coverageCount(rows[i].good_valid_slots)},!!p.definition)}));
   const result={...coverageResponse(items,q,'TELEMETRY',binding,now),verificationScope:'SERVER_FULL_BUSINESS_CANONICAL_AND_TELEMETRY_READ_SNAPSHOT',telemetryIntegrity:'INGEST_AUTHENTICATION_AND_PERSISTED_SOURCE_BINDING'};accountValue(result);cancelled();await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
 },true),requestSignal()).catch(error=>{if(error instanceof DomainError)throw error;throw integrity();});
}
async function effectiveTelemetry(client:pg.PoolClient,ctx:AccessContext,q:CoverageQuery,selected:QualityPoint[],now:number){
 const timeline=await sqlCalendarTimeline(client,ctx.tenantId,q.device,q.from,q.to,q.knownAt!);accountValue(timeline);
 if(selected.length*timeline.segments.length>2048)throw new DomainError(422,'覆盖分段超过2048项，请缩小采集源、测点或时间范围');
 const frames=timeline.segments.flatMap(segment=>selected.map(p=>({p,segment,plan:coveragePlan(segment.calendar,segment.from,segment.to,p.definition?.interval||null)})));accountValue(frames);
 const wire=frames.map(({p,segment},idx)=>({idx,edge_id:p.edgeId,device_code:p.deviceCode,tag_code:p.tagCode,node_id:p.nodeId,unit:p.unit,map_version:p.mapVersion,origin:p.origin,definition_unit:p.definition?.unit||null,minimum:p.definition?.min??null,maximum:p.definition?.max??null,segment_from:new Date(segment.from).toISOString(),segment_to:new Date(segment.to).toISOString()})),runs=frames.flatMap(({plan},idx)=>plan.runs.map(r=>({idx,run_idx:r.index,start_time:new Date(r.from).toISOString(),end_time:new Date(r.to).toISOString(),anchor:new Date(r.anchor).toISOString(),step_millis:plan.interval!*1000}))),wireText=JSON.stringify(wire),runsText=JSON.stringify(runs);accountValue(wire);accountValue(runs);accountValue(wireText);accountValue(runsText);
 const rows=(await client.query(plannedTelemetrySql,[ctx.tenantId,wireText,runsText,new Date(q.from).toISOString(),new Date(q.to).toISOString()])).rows;accountValue(rows);cancelled();
 if(rows.length!==frames.length||rows.some((r,i)=>r.idx!==i||r.edge_id!==frames[i].p.edgeId||r.device_code!==frames[i].p.deviceCode||r.tag_code!==frames[i].p.tagCode||coverageCount(r.records)!==coverageCount(r.planned_records)+coverageCount(r.outside_planned_records)))throw integrity();
 const items=frames.map(({p,plan,segment},i)=>({deviceCode:p.deviceCode,edgeId:p.edgeId,tagCode:p.tagCode,tagName:p.definition?.name||null,configuredOrigin:p.origin,expectedIntervalSeconds:p.definition?.interval||null,definitionSource:p.definition?.source||null,...segmentCoverage(segment,plan,{records:coverageCount(rows[i].records),plannedRecords:coverageCount(rows[i].planned_records),receivedSlots:coverageCount(rows[i].received_slots),goodValidSlots:coverageCount(rows[i].good_valid_slots)},!!p.definition)}));
 const result={...timelineCoverageResponse(items,q,'TELEMETRY',timeline,now),verificationScope:'SERVER_FULL_BUSINESS_CANONICAL_AND_TELEMETRY_READ_SNAPSHOT',telemetryIntegrity:'INGEST_AUTHENTICATION_AND_PERSISTED_SOURCE_BINDING'};accountValue(result);return result;
}
