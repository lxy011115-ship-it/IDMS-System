import type {TemplateVersion} from './domain.ts';
import type {Store} from './store.ts';
import {canonical} from './imports.ts';
import {DomainError} from './service.ts';
import {calendarScheduleSchema,type CalendarSchedule} from './calendar-schedule-schema.ts';
import {verifiedCalendar} from './operation-calendar.ts';
import {publicationIndex,templatePublication,historyIntegrity,type PublicationEvidence} from './template-history.ts';

export const isCalendarSchedule=(t:Pick<TemplateVersion,'manifest'>)=>t.manifest?.purpose==='calendar-schedule';
const compare=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
type CalendarBinding=ReturnType<typeof verifiedCalendar>;
function referencedCalendar(templates:readonly TemplateVersion[],tenant:string,device:string,ref:NonNullable<CalendarSchedule['entries'][number]['calendarRef']>,get:(id:string)=>PublicationEvidence|undefined){
 const item=templates.find(t=>t.tenantId===tenant&&t.id===ref.templateId);if(!item||item.templateKey!==ref.templateKey||item.version!==ref.version||item.contentDigest!==ref.contentDigest||item.manifest.purpose!=='operation-calendar')throw historyIntegrity();
 const p=templatePublication(item,get(item.id)),binding=verifiedCalendar(p.approved,p.approval);if(binding.calendar.deviceCode!==device)throw historyIntegrity();return {binding,publication:p};
}
export function validateScheduleReferences(store:Pick<Store,'templates'|'audits'>,tenant:string,schedule:CalendarSchedule,recordedAt?:string){
 const index=publicationIndex(store.audits,tenant);try{for(const e of schedule.entries){if(!e.calendarRef)continue;const p=referencedCalendar(store.templates,tenant,schedule.deviceCode,e.calendarRef,id=>index.get(id));const at=Date.parse(e.effectiveFrom);if(recordedAt&&Date.parse(p.publication.recordedAt)>Date.parse(recordedAt))throw Error();if(at<Date.parse(p.binding.calendar.from)||at>=Date.parse(p.binding.calendar.to))throw Error();}}catch{throw new DomainError(409,'安排引用须为本设备已独立发布的精确日历版本，生效时刻须在其声明范围内');}
}
export function validateSchedulePublication(store:Pick<Store,'templates'|'audits'>,item:TemplateVersion,publishedAt:string){
 if(!isCalendarSchedule(item))return;const schedule=calendarScheduleSchema(item.manifest.calendarSchedule);validateScheduleReferences(store,item.tenantId,schedule,publishedAt);
 const current=store.templates.find(t=>t.tenantId===item.tenantId&&t.templateKey===item.templateKey&&t.status==='PUBLISHED'),index=publicationIndex(store.audits,item.tenantId);
 if(!current){if(schedule.changeIntent!=='INITIAL')throw new DomainError(409,'首个生效安排须明确选择INITIAL');return;}
 if(schedule.changeIntent==='INITIAL')throw new DomainError(409,'已有安排的新版本须选择未来调整或历史修订');
 const prior=templatePublication(current,index.get(current.id)),old=calendarScheduleSchema(prior.approved.manifest.calendarSchedule),now=Date.parse(publishedAt);if(now<Date.parse(prior.recordedAt))throw new DomainError(409,'审批记录时间倒退，不能确定计划版本顺序');
 if(schedule.changeIntent==='PROSPECTIVE'){
  const past=(s:CalendarSchedule)=>s.entries.filter(e=>Date.parse(e.effectiveFrom)<=now);
  if(canonical(past(old))!==canonical(past(schedule)))throw new DomainError(409,'未来调整不能改变已生效安排；历史变更须选择RETROSPECTIVE_CORRECTION并说明');
 }
}
export interface CalendarTimelineSegment {index:number;from:number;to:number;entryId:string|null;reason:string;missing:string|null;calendar:CalendarBinding|null}
export function calendarTimeline(templates:readonly TemplateVersion[],tenant:string,device:string,from:number,to:number,knownAt:number,get:(id:string)=>PublicationEvidence|undefined){
 const candidates=templates.filter(t=>t.tenantId===tenant&&isCalendarSchedule(t)&&['PUBLISHED','RETIRED'].includes(t.status)&&(t.manifest.calendarSchedule as {deviceCode?:unknown})?.deviceCode===device);
 if(new Set(candidates.map(t=>t.templateKey)).size>1)throw historyIntegrity();
 const versions=candidates.map(t=>({item:t,p:templatePublication(t,get(t.id))})).sort((a,b)=>compare(a.item.version,b.item.version));
 if(versions.length&&(versions.at(-1)!.item.status!=='PUBLISHED'||versions.filter(v=>v.item.status==='PUBLISHED').length!==1))throw historyIntegrity();
 for(let i=1;i<versions.length;i++)if(compare(versions[i-1].item.version,versions[i].item.version)>=0||Date.parse(versions[i].p.recordedAt)<Date.parse(versions[i-1].p.recordedAt))throw historyIntegrity();
 const eligible=versions.filter(v=>Date.parse(v.p.recordedAt)<=knownAt),selected=eligible.at(-1),schedule=selected?calendarScheduleSchema(selected.p.approved.manifest.calendarSchedule):null;
 const bindings=new Map<string,CalendarBinding>();if(schedule)for(const entry of schedule.entries){if(!entry.calendarRef)continue;const p=referencedCalendar(templates,tenant,device,entry.calendarRef,get);if(Date.parse(p.publication.recordedAt)>Date.parse(selected!.p.recordedAt))throw historyIntegrity();const at=Date.parse(entry.effectiveFrom);if(at<Date.parse(p.binding.calendar.from)||at>=Date.parse(p.binding.calendar.to))throw historyIntegrity();bindings.set(entry.id,p.binding);}
 const cuts=[...new Set([from,to,...(schedule?.entries.map(e=>Date.parse(e.effectiveFrom)).filter(at=>at>from&&at<to)||[])])].sort((a,b)=>a-b),segments:CalendarTimelineSegment[]=[];
 for(let i=1;i<cuts.length;i++){const a=cuts[i-1],b=cuts[i],entry=schedule?.entries.filter(e=>Date.parse(e.effectiveFrom)<=a).at(-1),calendar=entry?bindings.get(entry.id)||null:null;segments.push({index:i-1,from:a,to:b,entryId:entry?.id||null,reason:entry?.reason||'尚无明确生效安排',missing:!schedule?'SCHEDULE_UNDECLARED':!entry?'NO_EFFECTIVE_ENTRY':!calendar?'CALENDAR_UNASSIGNED':null,calendar});}
 return {knownAt:new Date(knownAt).toISOString(),knowledgeBasis:'PERSISTED_APPROVAL_EVENT_TIME',replayScope:'CALENDAR_ONLY',definitionMode:'CURRENT_APPROVED',dataMode:'CURRENT_AUTHORIZED_RECORDS',schedule:selected?{templateId:selected.item.id,templateKey:selected.item.templateKey,version:selected.item.version,contentDigest:selected.item.contentDigest!,recordedAt:selected.p.recordedAt,governanceEventId:selected.p.approval.eventId,changeIntent:schedule!.changeIntent,changeReason:schedule!.changeReason}:null,availableVersions:eligible.map(v=>({templateId:v.item.id,version:v.item.version,recordedAt:v.p.recordedAt,governanceEventId:v.p.approval.eventId})),segments};
}
export type CalendarTimeline=ReturnType<typeof calendarTimeline>;
