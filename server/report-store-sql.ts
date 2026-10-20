import type pg from 'pg';
import {canonical} from './imports.ts';
import type {AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {replayDeviceAccessSql} from './coverage-replay-sql.ts';
import {appendReportState,reportIntegrity,verifyReportPayload,reportFamily,type ReportFamily,type ReportEvent,type ReportState,type ReportPayload} from './report-events.ts';
import {accountValue,requestSignal,CapacityError} from './capacity.ts';

export const reportColumns=`tenant_id,report_id::text,revision,action,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,actor_type,actor_id,request_key,request_digest,payload_digest,metadata,previous_hash,hash`;
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
export function reportId(raw:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw))throw reportIntegrity();return raw;}
export async function readReportSql(client:pg.PoolClient,ctx:AccessContext,id:string,withPayload:boolean,family:ReportFamily='COVERAGE'){
 reportId(id);const refs=(await client.query("/* IDMS_REPORT_SCOPE_REF */ SELECT tenant_id,report_id::text,metadata->>'deviceCode' AS device_code,metadata->'kind' AS kind,metadata ? 'kind' AS has_kind FROM analysis_report_events WHERE tenant_id=$1 AND report_id=$2 AND action='GENERATED'",[ctx.tenantId,id])).rows;check();accountValue(refs);
 if(refs.length===0)throw new DomainError(404,'报告不存在或不在当前授权范围');
 if(refs.length!==1||refs[0].tenant_id!==ctx.tenantId||refs[0].report_id!==id||typeof refs[0].device_code!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(refs[0].device_code))throw reportIntegrity();
 await replayDeviceAccessSql(client,ctx,refs[0].device_code);
 if(refs[0].has_kind&&refs[0].kind===null)throw reportIntegrity();
 if(reportFamily(refs[0].kind)!==family)throw new DomainError(404,'报告不存在或不在当前授权范围');
 const heads=(await client.query("/* IDMS_REPORT_HEAD */ SELECT count(*)::integer AS count,COALESCE(max(revision),0) AS revision,(SELECT count(*)::text FROM analysis_report_events WHERE tenant_id<>$1) AS foreign_count FROM analysis_report_events WHERE tenant_id=$1 AND report_id=$2",[ctx.tenantId,id])).rows;check();if(heads.length!==1||heads[0].foreign_count!=='0'||!Number.isSafeInteger(heads[0].count)||heads[0].count<1||heads[0].count>3||heads[0].revision!==heads[0].count)throw reportIntegrity();
 const rows=(await client.query(`/* IDMS_REPORT_EVENT_ROWS */ SELECT ${reportColumns} FROM analysis_report_events WHERE tenant_id=$1 AND report_id=$2 ORDER BY revision`,[ctx.tenantId,id])).rows as ReportEvent[];check();accountValue(rows);if(rows.length!==heads[0].count)throw reportIntegrity();let state:ReportState|null=null;
 for(const event of rows){if(event.tenant_id!==ctx.tenantId||event.report_id!==id)throw reportIntegrity();state=appendReportState(state,event);}if(!state||state.summary.deviceCode!==refs[0].device_code||reportFamily(state.summary.kind)!==family)throw reportIntegrity();
 let payload:ReportPayload|undefined;
 if(withPayload){const bodies=(await client.query("/* IDMS_REPORT_PAYLOAD */ SELECT tenant_id,report_id::text,payload_digest,payload FROM analysis_report_events WHERE tenant_id=$1 AND report_id=$2 AND revision=1 AND action='GENERATED'",[ctx.tenantId,id])).rows;check();accountValue(bodies);if(bodies.length!==1||bodies[0].tenant_id!==ctx.tenantId||bodies[0].report_id!==id||bodies[0].payload_digest!==state.payloadDigest)throw reportIntegrity();payload=verifyReportPayload(state,bodies[0].payload);check();}
 return {state,events:rows,payload};
}
export async function insertReportEventSql(client:pg.PoolClient,event:ReportEvent,payload:ReportPayload|null){
 if((event.action==='GENERATED')!==!!payload)throw reportIntegrity();
 const metadata=JSON.stringify(event.metadata),body=payload?JSON.stringify(payload):null;accountValue(metadata);accountValue(body);
 const result=await client.query(`/* IDMS_REPORT_APPEND */ INSERT INTO analysis_report_events(tenant_id,report_id,revision,action,occurred_at,actor_type,actor_id,request_key,request_digest,payload_digest,metadata,payload,previous_hash,hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${reportColumns}`,[event.tenant_id,event.report_id,event.revision,event.action,event.occurred_at,event.actor_type,event.actor_id,event.request_key,event.request_digest,event.payload_digest,metadata,body,event.previous_hash,event.hash]);check();accountValue(result.rows);if(result.rowCount!==1||result.rows.length!==1||canonical(result.rows[0])!==canonical(event))throw reportIntegrity();
}
export async function reportClockSql(client:pg.PoolClient){const times=(await client.query(`/* IDMS_REPORT_CLOCK */ SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).rows;check();if(times.length!==1||typeof times[0].at!=='string')throw reportIntegrity();return times[0].at as string;}
