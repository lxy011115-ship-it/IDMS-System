import {requireAccess,type AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {calendarTime,type OperationCalendar} from './calendar-schema.ts';
import {calendarFor} from './operation-calendar.ts';
import {dataScope} from './data-scope.ts';
import type {ImportView,StoredRow} from './imports.ts';
import type {StoreView} from './read-model.ts';
import type {AuditEvent} from './domain.ts';
import {qualityQuery} from './data-quality.ts';
import {calendarTimeline,type CalendarTimeline,type CalendarTimelineSegment} from './calendar-schedule.ts';
import {publicationIndex} from './template-history.ts';

export function coverageQuery(params:URLSearchParams,now:number){
 const allowed=['deviceCode','tagCode','edgeId','from','to','page','pageSize','planMode','knownAt'];
 if([...params.keys()].some(k=>!allowed.includes(k))||new Set(params.keys()).size!==[...params.keys()].length)throw new DomainError(400,'计划覆盖查询含未知或重复参数');
 const device=params.get('deviceCode');if(!device||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(device))throw new DomainError(400,'计划覆盖查询须明确设备编码');
 const edge=params.get('edgeId');if(edge!==null&&!/^[A-Za-z0-9_-]{1,80}$/.test(edge))throw new DomainError(400,'采集源编码无效');
 const planMode=params.has('planMode')?params.get('planMode')!:'CURRENT';if(!['CURRENT','EFFECTIVE'].includes(planMode)||planMode==='CURRENT'&&params.has('knownAt'))throw new DomainError(400,'审批截止时间仅用于EFFECTIVE生效计划复核');
 const knownAt=planMode==='EFFECTIVE'?(params.has('knownAt')?calendarTime(params.get('knownAt')):now):null;if(knownAt!==null&&knownAt>now)throw new DomainError(400,'审批记录截止时间不能在未来');
 const base=new URLSearchParams(params);for(const key of ['edgeId','planMode','knownAt'])base.delete(key);const q=qualityQuery(base,now);if(q.from===q.to)throw new DomainError(400,'计划覆盖窗口须大于零');return {...q,device,edge,planMode:planMode as 'CURRENT'|'EFFECTIVE',knownAt};
}
export type CoverageQuery=ReturnType<typeof coverageQuery>;
export type CalendarBinding=NonNullable<ReturnType<typeof calendarFor>>;
export interface RunPlan {index:number;from:number;to:number;anchor:number;firstSlot:number;slots:number}
export function coveragePlan(binding:CalendarBinding|null,from:number,to:number,interval:number|null){
 const full=to-from,calendar=binding?.calendar,runs:RunPlan[]=[];
 let declaredMs=0,runMs=0,stopMs=0,expected=0,partialSlots=0;
 if(calendar)for(const [index,p]of calendar.periods.entries()){
  const anchor=calendarTime(p.from),end=calendarTime(p.to),a=Math.max(from,anchor),b=Math.min(to,end);if(a>=b)continue;declaredMs+=b-a;
  if(p.state==='STOP'){stopMs+=b-a;continue;}runMs+=b-a;
  if(interval){const step=interval*1000,first=Math.floor((a-anchor)/step),last=Math.ceil((b-anchor)/step)-1,slots=last-first+1;expected+=slots;partialSlots+=first===last?(a>anchor+first*step||b<anchor+(last+1)*step?1:0):(a>anchor+first*step?1:0)+(b<anchor+(last+1)*step?1:0);runs.push({index,from:a,to:b,anchor,firstSlot:first,slots});}
 }
 const conditions=[];if(!calendar)conditions.push('CALENDAR_UNDECLARED');if(!interval)conditions.push('INTERVAL_UNDECLARED');if(calendar&&declaredMs!==full)conditions.push('WINDOW_OUTSIDE_DECLARED_CALENDAR');if(calendar&&runMs===0&&declaredMs===full)conditions.push('NO_PLANNED_SLOTS');
 return {from,to,interval,runs,conditions,declaredSeconds:declaredMs/1000,runSeconds:runMs/1000,stopSeconds:stopMs/1000,unknownSeconds:(full-declaredMs)/1000,expectedSlots:interval&&calendar?expected:null,partialSlots:interval&&calendar?partialSlots:null};
}
export type CoveragePlan=ReturnType<typeof coveragePlan>;
export interface CoverageCounts {records:number;plannedRecords:number;receivedSlots:number;goodValidSlots:number}
export const emptyCoverageCounts=():CoverageCounts=>({records:0,plannedRecords:0,receivedSlots:0,goodValidSlots:0});
export function coverageCount(raw:unknown){if(typeof raw!=='number'&&typeof raw!=='string'||!/^(0|[1-9][0-9]*)$/.test(String(raw))||!Number.isSafeInteger(Number(raw)))throw new DomainError(503,'计划覆盖统计不可验证');return Number(raw);}
export function coverageResult(plan:CoveragePlan,counts:CoverageCounts,definitionPresent:boolean){
 const c=Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,coverageCount(v)])) as unknown as CoverageCounts;
 if(Object.keys(c).length!==4||c.plannedRecords>c.records||c.receivedSlots>c.plannedRecords||c.goodValidSlots>c.receivedSlots||plan.expectedSlots!==null&&c.receivedSlots>plan.expectedSlots)throw new DomainError(503,'计划覆盖统计与分母不一致');
 const conditions=[...plan.conditions];if(!definitionPresent)conditions.unshift('MISSING_APPROVED_DEFINITION');const complete=conditions.length===0&&!!plan.expectedSlots;
 return {status:complete?'EVALUATED':conditions.length===1&&conditions[0]==='NO_PLANNED_SLOTS'?'NOT_APPLICABLE':'UNKNOWN',conditions,plannedSeconds:plan.runSeconds,stoppedSeconds:plan.stopSeconds,undeclaredSeconds:plan.unknownSeconds,expectedSlots:plan.expectedSlots,partialSlots:plan.partialSlots,recordsInWindow:c.records,recordsInPlannedSlots:c.plannedRecords,recordsOutsidePlannedSlots:c.records-c.plannedRecords,receivedSlots:c.receivedSlots,goodValidSlots:c.goodValidSlots,duplicateRecordsInPlannedSlots:c.plannedRecords-c.receivedSlots,missingSlots:plan.expectedSlots===null?null:plan.expectedSlots-c.receivedSlots,receivedCoveragePercent:complete?c.receivedSlots/plan.expectedSlots!*100:null,goodValidCoveragePercent:complete?c.goodValidSlots/plan.expectedSlots!*100:null};
}
export function countCoverage(plan:CoveragePlan,records:readonly {time:number;goodValid:boolean}[]):CoverageCounts{
 const result=emptyCoverageCounts(),received=new Set<string>(),good=new Set<string>();
 for(const r of records){if(!Number.isFinite(r.time)||r.time<plan.from||r.time>=plan.to)continue;result.records++;const run=plan.runs.find(p=>r.time>=p.from&&r.time<p.to);if(!run||!plan.interval)continue;
  const slot=run.index+':'+Math.floor((r.time-run.anchor)/(plan.interval*1000));result.plannedRecords++;received.add(slot);if(r.goodValid)good.add(slot);
 }
 result.receivedSlots=received.size;result.goodValidSlots=good.size;return result;
}
export function coverageResponse(items:unknown[],q:CoverageQuery,source:'UPLOADS'|'TELEMETRY',binding:CalendarBinding|null,now:number){
 return {source,items:items.slice((q.page-1)*q.pageSize,q.page*q.pageSize),total:items.length,page:q.page,pageSize:q.pageSize,deviceCode:q.device,calendar:binding?{...binding.source,timeZone:binding.calendar.timeZone,from:binding.calendar.from,to:binding.calendar.to}:null,window:{from:new Date(q.from).toISOString(),to:new Date(q.to).toISOString(),boundary:'FROM_INCLUSIVE_TO_EXCLUSIVE'},evaluatedAt:new Date(now).toISOString(),ruleVersion:'planned-sample-coverage-1.0.0',readOnly:true,fieldCommissioned:false,notice:'计划覆盖使用当前批准测点定义和当前独立发布日历；不是历史当时配置重放、设备健康或实时在线结论。RUN起点固定分槽，与窗口相交的部分槽计一个；STOP和未声明时段不填槽，重复记录每槽只计一次。缺定义/间隔/日历或超出日历时段不输出完整覆盖率。原观测缺口不被覆盖指标改写。'};
}
export function segmentCoverage(segment:CalendarTimelineSegment,plan:CoveragePlan,counts:CoverageCounts,definitionPresent:boolean){
 const result=coverageResult(plan,counts,definitionPresent);if(segment.missing){result.status='UNKNOWN';result.conditions=[...result.conditions,segment.missing];result.receivedCoveragePercent=null;result.goodValidCoveragePercent=null;}
 return {...result,segmentIndex:segment.index,segmentFrom:new Date(segment.from).toISOString(),segmentTo:new Date(segment.to).toISOString(),entryId:segment.entryId,entryReason:segment.reason,calendarSource:segment.calendar?.source||null};
}
export function timelineCoverageResponse(items:unknown[],q:CoverageQuery,source:'UPLOADS'|'TELEMETRY',timeline:CalendarTimeline|null,now:number){
 return {...coverageResponse(items,q,source,null,now),ruleVersion:'effective-calendar-coverage-1.0.0',timeline:timeline?{...timeline,segments:timeline.segments.map(s=>({index:s.index,from:new Date(s.from).toISOString(),to:new Date(s.to).toISOString(),entryId:s.entryId,reason:s.reason,missing:s.missing,calendarSource:s.calendar?.source||null}))}:null,notice:'日历按明确生效时间和所选审批记录截止时间分段复核；这仅重放日历，测点定义、有效记录和接入点表仍是当前授权结果，不是完整的当时报告。审批记录时间是持久事件逻辑时间，不是物理提交瞬间。各段独立计算部分槽，不跨版本平均百分比；未知不表示停产或健康。'};
}
function uploadTimelineCoverage(data:ImportView,store:StoreView,audits:readonly AuditEvent[],ctx:AccessContext,q:CoverageQuery,now:number,records:readonly StoredRow[]){
 const index=publicationIndex(audits,ctx.tenantId),timeline=calendarTimeline(store.templates,ctx.tenantId,q.device,q.from,q.to,q.knownAt!,id=>index.get(id)),defs=records.filter(r=>r.dataType==='POINT_DEFINITION'),measurements=records.filter(r=>r.dataType==='MEASUREMENT'),tags=[...new Set([...defs,...measurements].map(r=>String(r.value.tag_code)))].filter(tag=>!q.tag||q.tag===tag).sort();
 if(tags.length*timeline.segments.length>2048)throw new DomainError(422,'覆盖分段超过2048项，请缩小测点或时间范围');
 const items=timeline.segments.flatMap(segment=>tags.map(tag=>{const d=defs.find(d=>d.value.tag_code===tag),raw=d?.value.expected_interval_seconds,interval=raw!==undefined&&raw!==''&&Number.isSafeInteger(Number(raw))&&Number(raw)>0?Number(raw):null,plan=coveragePlan(segment.calendar,segment.from,segment.to,interval),b=d?data.batches.find(b=>b.batchId===d.batchId&&b.tenantId===ctx.tenantId):undefined;
  const values=measurements.filter(r=>r.value.tag_code===tag).map(r=>({time:Date.parse(String(r.value.measured_at)),goodValid:!!d&&r.value.quality==='GOOD'&&r.value.value!==null&&r.value.value!==''&&r.value.value!==undefined&&Number.isFinite(Number(r.value.value))&&r.value.unit===String(d.value.unit)&&Number(r.value.value)>=Number(d.value.min_value)&&Number(r.value.value)<=Number(d.value.max_value)}));
  return {deviceCode:q.device,tagCode:tag,tagName:d?String(d.value.tag_name):null,expectedIntervalSeconds:interval,definitionSource:d?{batchId:d.batchId,sourceRow:d.row,snapshotDigest:b!.snapshotDigest,recordVersion:b?.correction?.baseRows.find(x=>x.sourceRecordId===String(d.value.source_record_id))?.revision||1}:null,...segmentCoverage(segment,plan,countCoverage(plan,values),!!d)};
 }));return timelineCoverageResponse(items,q,'UPLOADS',timeline,now);
}
export function uploadCoverage(data:ImportView,store:StoreView,audits:readonly AuditEvent[],ctx:AccessContext,params:URLSearchParams,now=Date.now()){
 requireAccess(ctx,'read');if(params.has('edgeId'))throw new DomainError(400,'上传覆盖不接受采集源');const q=coverageQuery(params,now),view=dataScope(data,ctx,store),asset=view.assets.get(q.device);
 if(!asset||!view.device(q.device))return q.planMode==='EFFECTIVE'?timelineCoverageResponse([],q,'UPLOADS',null,now):coverageResponse([],q,'UPLOADS',null,now);
 if(q.planMode==='EFFECTIVE')return uploadTimelineCoverage(data,store,audits,ctx,q,now,view.records.filter(r=>r.tenantId===ctx.tenantId&&r.value.device_code===q.device));
 const anchors=new Map<string,AuditEvent>();for(const a of audits)if(a.tenantId===ctx.tenantId&&a.objectType==='TEMPLATE')anchors.set(a.objectId,a);
 const binding=calendarFor(store.templates,ctx.tenantId,q.device,id=>anchors.get(id)),records=view.records.filter(r=>r.tenantId===ctx.tenantId&&r.value.device_code===q.device),defs=records.filter(r=>r.dataType==='POINT_DEFINITION'),measurements=records.filter(r=>r.dataType==='MEASUREMENT'),tags=[...new Set([...defs,...measurements].map(r=>String(r.value.tag_code)))].filter(t=>!q.tag||q.tag===t).sort();
 const source=(r:StoredRow)=>{const b=data.batches.find(b=>b.batchId===r.batchId&&b.tenantId===ctx.tenantId)!;return {batchId:r.batchId,sourceRow:r.row,snapshotDigest:b.snapshotDigest,recordVersion:b.correction?.baseRows.find(x=>x.sourceRecordId===String(r.value.source_record_id))?.revision||1};};
 const items=tags.map(tag=>{const d=defs.find(d=>d.value.tag_code===tag),raw=d?.value.expected_interval_seconds,interval=raw!==undefined&&raw!==''&&Number.isSafeInteger(Number(raw))&&Number(raw)>0?Number(raw):null,plan=coveragePlan(binding,q.from,q.to,interval),values=measurements.filter(r=>r.value.tag_code===tag).map(r=>({time:Date.parse(String(r.value.measured_at)),goodValid:!!d&&r.value.quality==='GOOD'&&r.value.value!==null&&r.value.value!==''&&r.value.value!==undefined&&Number.isFinite(Number(r.value.value))&&r.value.unit===String(d.value.unit)&&Number(r.value.value)>=Number(d.value.min_value)&&Number(r.value.value)<=Number(d.value.max_value)}));return {deviceCode:q.device,tagCode:tag,tagName:d?String(d.value.tag_name):null,expectedIntervalSeconds:interval,definitionSource:d?source(d):null,...coverageResult(plan,countCoverage(plan,values),!!d)};});
 return coverageResponse(items,q,'UPLOADS',binding,now);
}
