import type pg from 'pg';
import type {TemplateVersion} from './domain.ts';
import type {PublicationEvidence} from './template-history.ts';
import {operationalPolicyHistory,operationalIntegrity} from './operational-policy-history.ts';
import {operationalRecordsSql} from './operational-imports-sql.ts';
import {replayQuery,replayDeviceAccessSql} from './coverage-replay-sql.ts';
import {sqlCalendarTimeline} from './calendar-history-sql.ts';
import type {OperationalInput} from './frozen-operational-input.ts';
import {freezeOperationalPayload} from './frozen-operational-v1.ts';
import {coverageCount} from './plan-coverage.ts';
import {streamRows} from './pg-row-stream.ts';
import {requireAccess,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {accountValue,requestSignal,CapacityError,sqlScheduler,memoryTask} from './capacity.ts';
const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
export function operationalQuery(params:URLSearchParams,now=Date.now()){
 const allowed=['source','deviceCode','from','to','knownAt','page','pageSize','section'];if([...params.keys()].some(k=>!allowed.includes(k))||new Set(params.keys()).size!==[...params.keys()].length)throw new DomainError(400,'运营指标查询含未知或重复参数');
 const section=params.get('section')||'PRODUCTION';if(!['PRODUCTION','MAINTENANCE','INSPECTION','STATES'].includes(section))throw new DomainError(400,'运营指标明细类别无效');const base=new URLSearchParams(params);base.delete('section');const q=replayQuery(base,now);if(q.source!=='UPLOADS'||q.to>q.knownAt!)throw new DomainError(400,'运营指标仅接受已批准上传数据且窗口结束不得晚于资料截止');return {...q,section:section as 'PRODUCTION'|'MAINTENANCE'|'INSPECTION'|'STATES'};
}
export type OperationalQuery=ReturnType<typeof operationalQuery>;
export async function sqlOperationalPolicy(client:pg.PoolClient,tenant:string,device:string,knownAt:number){
 const where="t.tenant_id=$1 AND t.body->'manifest'->>'purpose'='operational-metric-policy' AND t.body->>'status' IN ('PUBLISHED','RETIRED') AND t.body->'manifest'->'operationalMetricPolicy'->>'deviceCode'=$2",values=[tenant,device],templates:TemplateVersion[]=[],evidence=new Map<string,PublicationEvidence>();
 const head=(await client.query(`/* IDMS_OPERATIONAL_POLICY_HEAD */ SELECT count(*)::text AS count FROM business_templates t WHERE ${where}`,values)).rows;check();if(head.length!==1)throw operationalIntegrity();const expected=coverageCount(head[0].count);
 await streamRows<any>(client,`/* IDMS_OPERATIONAL_POLICY_ROWS */ SELECT t.tenant_id,t.id,t.body,a.event AS anchor,p.event AS approval,p.count AS approval_count FROM business_templates t LEFT JOIN LATERAL(SELECT event FROM audit_ledger WHERE tenant_id=t.tenant_id AND event->>'objectType'='TEMPLATE' AND event->>'objectId'=t.id ORDER BY sequence_no DESC LIMIT 1)a ON true LEFT JOIN LATERAL(SELECT count(*)::text AS count,(jsonb_agg(event ORDER BY sequence_no)->0) AS event FROM audit_ledger WHERE tenant_id=t.tenant_id AND event->>'objectType'='TEMPLATE' AND event->>'objectId'=t.id AND event->>'action'='TEMPLATE_APPROVED')p ON true WHERE ${where} ORDER BY t.ordinal`,row=>{
  check();accountValue(row);if(row.tenant_id!==tenant||row.id!==row.body?.id||row.body.tenantId!==tenant||row.body.manifest?.purpose!=='operational-metric-policy'||row.body.manifest.operationalMetricPolicy?.deviceCode!==device||evidence.has(row.id))throw operationalIntegrity();templates.push(row.body);evidence.set(row.id,{anchor:row.anchor||undefined,approval:row.approval||undefined,approvalCount:coverageCount(row.approval_count)});
 },()=>{templates.length=0;evidence.clear();},values);check();if(templates.length!==expected)throw operationalIntegrity();return operationalPolicyHistory(templates,tenant,device,knownAt,id=>evidence.get(id));
}
// The caller verifies the canonical business root in this same RR transaction.
export async function operationalInputsSql(client:pg.PoolClient,ctx:AccessContext,q:OperationalQuery):Promise<OperationalInput>{
 await replayDeviceAccessSql(client,ctx,q.device);const imports=await operationalRecordsSql(client,ctx.tenantId,q.device,q.from,q.to,q.knownAt!),metricPolicy=await sqlOperationalPolicy(client,ctx.tenantId,q.device,q.knownAt!),timeline=await sqlCalendarTimeline(client,ctx.tenantId,q.device,q.from,q.to,q.knownAt!),bindings=new Map(timeline.segments.filter(s=>s.calendar).map(s=>[s.calendar!.source.templateId,s.calendar!]));
 const input:OperationalInput={format:'idms-operational-input-v1',tenantId:ctx.tenantId,deviceCode:q.device,source:'UPLOADS',query:{from:new Date(q.from).toISOString(),to:new Date(q.to).toISOString(),knownAt:new Date(q.knownAt!).toISOString(),tagCode:null,edgeId:null},imports,metricPolicy,calendarContext:{schedule:timeline.schedule,calendars:[...bindings.values()],segments:timeline.segments.map(s=>({index:s.index,from:new Date(s.from).toISOString(),to:new Date(s.to).toISOString(),entryId:s.entryId,reason:s.reason,missing:s.missing,calendarId:s.calendar?.source.templateId||null}))}};accountValue(input);check();return input;
}
export async function operationalMetricsSqlRead(pool:pg.Pool,ctx:AccessContext,params:URLSearchParams,verify:(c:pg.PoolClient)=>Promise<void>,now=Date.now()){
 requireAccess(ctx,'read');const q=operationalQuery(params,now);return sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verify(client);const input=await operationalInputsSql(client,ctx,q),payload=freezeOperationalPayload(input);accountValue(payload);check();const {production,maintenance,inspection,states,...summary}=payload.result,items=q.section==='PRODUCTION'?production:q.section==='MAINTENANCE'?maintenance:q.section==='INSPECTION'?inspection:states,result={...summary,section:q.section,items:items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:items.length,page:q.page,pageSize:q.pageSize,inputDigest:payload.inputDigest,resultDigest:payload.resultDigest,inputRecordCount:input.imports.length,metricPolicy:input.metricPolicy,calendarContext:{schedule:input.calendarContext.schedule,segments:input.calendarContext.segments,calendars:input.calendarContext.calendars.map(c=>c.source)},verificationScope:'FULL_VERIFIED_FIVE_TYPE_HISTORY_AND_APPROVED_POLICY',persistentApprovalReport:false};accountValue(result);check();await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});if(e instanceof DomainError)throw e;throw operationalIntegrity();}finally{client.release();}},true),requestSignal());
}
