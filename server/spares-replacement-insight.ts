import type {AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {exactFact} from './spares-facts.ts';
import {validateSpareRow} from './spares-workset.ts';
import type {SpareQueryPlan,SparePageAnchor} from './spares-query-plan.ts';
import type {InsightQuery,InsightPage} from './spares-insights-db.ts';

const broken=()=>new DomainError(503,'更换登记依据暂无法核验');
/** Only full single-record replacements at the current configured position
 * quantity qualify. Distinct dates, not record count, define intervals. */
export async function readReplacementInsight(ctx:AccessContext,plan:SpareQueryPlan,query:InsightQuery,page:InsightPage,anchor:SparePageAnchor|null){
 const links=await query(`SELECT l.*,p.body AS part FROM spare_visible l JOIN spare_visible p ON p.kind='part' AND p.id::text=l.body->>'partId' WHERE l.kind='link' AND l.id::text=$7 LIMIT 2`,[plan.linkId]);
 if(!links.length)throw new DomainError(404,'适用备件位置不存在或不在当前范围');if(links.length!==1)throw broken();
 const link=validateSpareRow(links[0],ctx.tenantId),configuredMilli=exactFact(String(link.quantityMilli));if(!configuredMilli)throw broken();
 const cte=`,replacement_source AS MATERIALIZED (
 SELECT e.*,(e.body->>'quantityMilli')::numeric=(l.body->>'quantityMilli')::numeric AS qualifies
 FROM spare_visible e JOIN spare_visible l ON l.kind='link' AND l.id::text=$7
 WHERE e.kind='replacement' AND e.body->>'linkId'=l.id::text
 AND e.body->>'deviceCode'=l.body->>'deviceCode' AND e.body->>'partId'=l.body->>'partId'
 ),replacement_dates AS (SELECT DISTINCT (body->>'date')::date AS day FROM replacement_source WHERE qualifies),
 replacement_intervals AS (SELECT day,day-lag(day) OVER(ORDER BY day) AS days FROM replacement_dates) `;
 const stats=await query(cte+`SELECT count(*)::text AS records,count(*) FILTER(WHERE qualifies)::text AS full_records,
 count(*) FILTER(WHERE NOT qualifies)::text AS excluded_records,
 (SELECT count(*)::text FROM replacement_dates) AS dates,
 (SELECT min(day)::text FROM replacement_dates) AS first_date,(SELECT max(day)::text FROM replacement_dates) AS last_date,
 (SELECT count(*)::text FROM replacement_intervals WHERE days IS NOT NULL) AS intervals,
 (SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY days)::text FROM replacement_intervals WHERE days IS NOT NULL) AS median_days,
 (SELECT min(days)::text FROM replacement_intervals WHERE days IS NOT NULL) AS minimum_days,
 (SELECT count(*)::text FROM replacement_intervals WHERE days<$8::int AND $8::int>0) AS early_dates,
 EXISTS(SELECT 1 FROM replacement_source WHERE body->>'date'=$9) AS last_date_record_exists
 FROM replacement_source`,[plan.linkId,link.cycleDays,link.lastDate||'']);
 if(stats.length!==1)throw broken();const s=stats[0],dateCount=exactFact(s.dates),intervalCount=exactFact(s.intervals),enough=dateCount>=4;
 if(intervalCount!==Math.max(0,dateCount-1))throw broken();
 let medianDays:number|null=null,minimumDays:number|null=null;
 if(enough){medianDays=Number(s.median_days);minimumDays=exactFact(s.minimum_days);if(!Number.isFinite(medianDays)||medianDays<=0||medianDays*2!==Math.trunc(medianDays*2)||minimumDays<=0)throw broken();}
 const values:unknown[]=[plan.linkId],param=(v:unknown)=>{values.push(v);return '$'+(values.length+6);};
 const after=anchor?` AND (e.body->>'date',e.id::text)>(${param(anchor.first)}::text,${param(anchor.second)}::text)`:'';
 const limit=param(plan.limit+1),rows=await query(cte+`SELECT e.*,i.days::text AS interval_days,e.body->>'date' AS key_first,e.id::text AS key_second
 FROM replacement_source e LEFT JOIN replacement_intervals i ON i.day=(e.body->>'date')::date AND e.qualifies
 WHERE true ${after} ORDER BY e.body->>'date',e.id::text LIMIT ${limit}`,values);
 const cycleDays=exactFact(String(link.cycleDays)),part=links[0].part;
 return {link:{id:link.id,deviceCode:link.deviceCode,position:link.position,partId:link.partId,configuredMilli,cycleDays,lastDate:link.lastDate||'',lastDateRecordExists:s.last_date_record_exists},
  part:{id:part.id,code:part.code,name:part.name,unit:part.unit,precision:part.precision},
  evidence:{recordCount:exactFact(s.records),fullRecordCount:exactFact(s.full_records),excludedPartialRecordCount:exactFact(s.excluded_records),qualifyingDateCount:dateCount,intervalCount,firstDate:s.first_date,lastDate:s.last_date,enoughSamples:enough,medianDays,minimumDays,earlyRegistrationDateCount:exactFact(s.early_dates),minimumRequiredDates:4},
  ...page(rows,row=>{const e=validateSpareRow(row,ctx.tenantId),days=row.interval_days===null?null:exactFact(row.interval_days);return {id:e.id,date:e.date,quantityMilli:e.quantityMilli,qualifies:row.qualifies,exclusion:row.qualifies?null:'QUANTITY_DIFFERS_FROM_CONFIGURED_POSITION',previousIntervalDays:days,earlierThanConfiguredCycle:days!==null&&cycleDays>0&&days<cycleDays,issueId:e.issueId,workOrderId:e.workOrderId||'',createdBy:e.createdBy,reason:e.reason||''};}),
  missingConditions:[...(!enough?['INSUFFICIENT_FULL_DATES']:[]),...(!cycleDays?['NO_CYCLE_CONFIGURED']:[])],
  notice:'仅单条数量等于当前位置装机用量的登记参与统计，同一天去重。部分或分次登记不拼成全量样本；登记间隔不代表单件寿命、故障判定或供应商质量结论。'};
}
