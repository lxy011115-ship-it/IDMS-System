import type pg from 'pg';
import type {TemplateVersion} from './domain.ts';
import {calendarTimeline} from './calendar-schedule.ts';
import {historyIntegrity,type PublicationEvidence} from './template-history.ts';
import {streamRows} from './pg-row-stream.ts';
import {accountValue,requestSignal,CapacityError} from './capacity.ts';
import {coverageCount} from './plan-coverage.ts';

const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
export async function sqlCalendarTimeline(client:pg.PoolClient,tenant:string,device:string,from:number,to:number,knownAt:number){
 const templates:TemplateVersion[]=[],evidence=new Map<string,PublicationEvidence>();
 async function read(kind:'calendar-schedule'|'operation-calendar',ids:string[]=[]){
  const field=kind==='calendar-schedule'?'calendarSchedule':'operationCalendar',where=`t.tenant_id=$1 AND t.body->'manifest'->>'purpose'=$2 AND t.body->>'status' IN ('PUBLISHED','RETIRED') AND t.body->'manifest'->'${field}'->>'deviceCode'=$3${ids.length?' AND t.id=ANY($4::text[])':''}`,values:unknown[]=[tenant,kind,device,...(ids.length?[ids]:[])];
  const head=(await client.query(`/* IDMS_CALENDAR_HISTORY_COUNT */ SELECT count(*)::text AS count FROM business_templates t WHERE ${where}`,values)).rows;check();if(head.length!==1)throw historyIntegrity();const expected=coverageCount(head[0].count);if(ids.length&&expected!==ids.length)throw historyIntegrity();let seen=0;
  await streamRows<any>(client,`/* IDMS_CALENDAR_HISTORY_ROWS */ SELECT t.tenant_id,t.id,t.body,a.event AS anchor,p.event AS approval,p.count AS approval_count FROM business_templates t LEFT JOIN LATERAL (SELECT event FROM audit_ledger WHERE tenant_id=t.tenant_id AND event->>'objectType'='TEMPLATE' AND event->>'objectId'=t.id ORDER BY sequence_no DESC LIMIT 1) a ON true LEFT JOIN LATERAL (SELECT count(*)::text AS count,(jsonb_agg(event ORDER BY sequence_no)->0) AS event FROM audit_ledger WHERE tenant_id=t.tenant_id AND event->>'objectType'='TEMPLATE' AND event->>'objectId'=t.id AND event->>'action'='TEMPLATE_APPROVED') p ON true WHERE ${where} ORDER BY t.ordinal`,row=>{
   check();accountValue(row);if(row.tenant_id!==tenant||row.id!==row.body?.id||row.body.tenantId!==tenant||row.body.manifest?.purpose!==kind||row.body.manifest?.[field]?.deviceCode!==device||evidence.has(row.id)||ids.length&&!ids.includes(row.id))throw historyIntegrity();templates.push(row.body);evidence.set(row.id,{anchor:row.anchor||undefined,approval:row.approval||undefined,approvalCount:coverageCount(row.approval_count)});seen++;
  },()=>{},values);check();if(seen!==expected)throw historyIntegrity();
 }
 await read('calendar-schedule');
 const refs=[...new Set(templates.flatMap(t=>{const e=(t.manifest.calendarSchedule as any)?.entries;if(!Array.isArray(e))throw historyIntegrity();return e.flatMap((v:any)=>v.calendarRef?[v.calendarRef.templateId]:[]);} ))];
 if(refs.some(id=>typeof id!=='string'||!id)||refs.length>16384)throw historyIntegrity();
 if(refs.length)await read('operation-calendar',refs);
 return calendarTimeline(templates,tenant,device,from,to,knownAt,id=>evidence.get(id));
}
