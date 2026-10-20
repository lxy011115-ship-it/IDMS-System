import {DomainError} from './service.ts';
import {object,keys,text} from './schema-primitives.ts';
import {calendarIdentity,calendarTime} from './calendar-schema.ts';

export function calendarScheduleSchema(raw:unknown){
 const s=object(raw,'生效安排');keys(s,['deviceCode','changeIntent','changeReason','entries']);const deviceCode=calendarIdentity(s),changeReason=text(s.changeReason,'生效安排变更依据',2000);
 if(typeof s.changeIntent!=='string'||!['INITIAL','PROSPECTIVE','RETROSPECTIVE_CORRECTION'].includes(s.changeIntent))throw new DomainError(400,'安排意图须为INITIAL/PROSPECTIVE/RETROSPECTIVE_CORRECTION');
 if(!Array.isArray(s.entries)||!s.entries.length||s.entries.length>128)throw new DomainError(400,'生效安排须有1至128个明确条目');
 const seen=new Set<string>();let previous=-Infinity;
 const entries=s.entries.map(v=>{const e=object(v,'生效条目');keys(e,['id','effectiveFrom','calendarRef','reason']);const id=text(e.id,'生效条目编码',64),time=calendarTime(e.effectiveFrom),reason=text(e.reason,'生效条目依据',500);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)||seen.has(id)||time<=previous)throw new DomainError(400,'生效条目编码须唯一，时间须严格递增');seen.add(id);previous=time;
  let calendarRef:null|{templateId:string;templateKey:string;version:string;contentDigest:string}=null;
  if(e.calendarRef!==null){const r=object(e.calendarRef,'日历版本引用');keys(r,['templateId','templateKey','version','contentDigest']);const templateId=text(r.templateId,'日历版本ID',100),templateKey=text(r.templateKey,'日历编码',80),version=text(r.version,'日历版本',30),contentDigest=text(r.contentDigest,'日历摘要',64);if(!/^[a-z][a-z0-9-]*$/.test(templateKey)||!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)||!/^[a-f0-9]{64}$/.test(contentDigest))throw new DomainError(400,'日历精确版本引用无效');calendarRef={templateId,templateKey,version,contentDigest};}
  return {id,effectiveFrom:new Date(time).toISOString(),calendarRef,reason};
 });
 return {deviceCode,changeIntent:s.changeIntent as 'INITIAL'|'PROSPECTIVE'|'RETROSPECTIVE_CORRECTION',changeReason,entries};
}
export type CalendarSchedule=ReturnType<typeof calendarScheduleSchema>;
