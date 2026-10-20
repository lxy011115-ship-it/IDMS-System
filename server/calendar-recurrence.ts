import {Temporal} from '@js-temporal/polyfill';
import {createHash} from 'node:crypto';
import {object,keys,text} from './schema-primitives.ts';
import {DomainError} from './service.ts';

export const recurrenceEngine='weekly-calendar-temporal-v1';
export const recurrencePolyfill='0.5.1';
const stable=(v:any):string=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
export const recurrenceDigest=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
export interface CalendarPeriod {from:string;to:string;state:'RUN'|'STOP';reason:string}
const date=(v:unknown)=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))throw new DomainError(400,'例外日期须为YYYY-MM-DD');try{return Temporal.PlainDate.from(v,{overflow:'reject'});}catch{throw new DomainError(400,'例外日期不存在');}};
const minutes=(v:unknown,end=false)=>{if(typeof v!=='string'||!(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)||end&&v==='24:00'))throw new DomainError(400,'班次钟点须为HH:mm，结束可用24:00');return Number(v.slice(0,2))*60+Number(v.slice(3));};
function shift(raw:unknown,exception=false){const s=object(raw,'班次');keys(s,exception?['start','end','endDayOffset','reason']:['id','isoWeekdays','start','end','endDayOffset','reason']);
 const a=minutes(s.start),b=minutes(s.end,true);if(s.endDayOffset!==0&&s.endDayOffset!==1||exception&&s.endDayOffset!==0||b+s.endDayOffset*1440<=a||b+s.endDayOffset*1440-a>1440)throw new DomainError(400,'班次须大于零且不超过24小时；日期例外须在当日内');
 return {start:s.start as string,end:s.end as string,endDayOffset:s.endDayOffset as 0|1,reason:text(s.reason,'班次依据',300)};
}
export function recurrenceSchema(raw:unknown){
 const r=object(raw,'循环班次');keys(r,['version','outsideShifts','outsideReason','ambiguousTime','nonexistentTime','weekly','exceptions']);
 if(r.version!==1||r.outsideShifts!=='STOP'||!['EARLIER','LATER','REJECT'].includes(r.ambiguousTime as string)||r.nonexistentTime!=='REJECT')throw new DomainError(400,'循环计划须显式声明STOP、重复钟点策略及不存在钟点REJECT');
 if(!Array.isArray(r.weekly)||r.weekly.length>32||!Array.isArray(r.exceptions)||r.exceptions.length>128)throw new DomainError(400,'循环计划最多32条周班次和128个日期例外');
 const ids=new Set<string>(),occupied:{a:number;b:number}[]=[];
 const weekly=r.weekly.map(v=>{const s=object(v,'周班次'),base=shift(s),id=text(s.id,'班次编码',40);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)||ids.has(id))throw new DomainError(400,'班次编码无效或重复');ids.add(id);
  if(!Array.isArray(s.isoWeekdays)||!s.isoWeekdays.length||s.isoWeekdays.length>7||s.isoWeekdays.some(d=>!Number.isInteger(d)||d<1||d>7)||new Set(s.isoWeekdays).size!==s.isoWeekdays.length)throw new DomainError(400,'ISO星期须为不重复的1至7');
  const days=[...s.isoWeekdays].sort((a,b)=>a-b);for(const d of days){const a=(d-1)*1440+minutes(base.start),b=(d-1)*1440+minutes(base.end,true)+base.endDayOffset*1440;occupied.push({a,b:Math.min(b,10080)});if(b>10080)occupied.push({a:0,b:b-10080});}
  return {id,isoWeekdays:days,...base};
 });
 occupied.sort((a,b)=>a.a-b.a);if(occupied.some((p,i)=>i>0&&p.a<occupied[i-1].b))throw new DomainError(400,'周班次存在重叠，包括跨夜或周界');
 const dates=new Set<string>(),exceptions=r.exceptions.map(v=>{const e=object(v,'日期例外');keys(e,['date','reason','shifts']);const d=date(e.date).toString();if(dates.has(d))throw new DomainError(400,'例外日期重复');dates.add(d);
  if(!Array.isArray(e.shifts)||e.shifts.length>32)throw new DomainError(400,'每日期例外最多32个当日班次');const shifts=e.shifts.map(s=>shift(s,true)).sort((a,b)=>minutes(a.start)-minutes(b.start));if(shifts.some((s,i)=>i>0&&minutes(s.start)<minutes(shifts[i-1].end,true)))throw new DomainError(400,'日期例外班次重叠');return {date:d,reason:text(e.reason,'日期例外依据',300),shifts};
 }).sort((a,b)=>a.date.localeCompare(b.date));
 return {version:1 as const,outsideShifts:'STOP' as const,outsideReason:text(r.outsideReason,'非班次停产依据',300),ambiguousTime:r.ambiguousTime as 'EARLIER'|'LATER'|'REJECT',nonexistentTime:'REJECT' as const,weekly,exceptions};
}
export type CalendarRecurrence=ReturnType<typeof recurrenceSchema>;
export function compileRecurrence(deviceCode:string,timeZone:string,from:string,to:string,r:CalendarRecurrence,accountValue:(value:unknown)=>void=()=>{}){
 const start=Date.parse(from),end=Date.parse(to),first=Temporal.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(timeZone).toPlainDate(),last=Temporal.Instant.fromEpochMilliseconds(end-1).toZonedDateTimeISO(timeZone).toPlainDate();
 const masks=r.exceptions.map(e=>{const d=date(e.date),a=d.toZonedDateTime(timeZone),b=d.add({days:1}).toZonedDateTime(timeZone);if(!a.toPlainDate().equals(d)||a.epochMilliseconds>=end||b.epochMilliseconds<=start)throw new DomainError(400,'日期例外不在声明范围内，或当地整日不存在');return {...e,a:a.epochMilliseconds,b:b.epochMilliseconds};});
 const exceptionDates=new Set(masks.map(m=>m.date)),runs:{a:number;b:number;reason:string}[]=[],skippedDates:string[]=[];
 const at=(d:Temporal.PlainDate,time:string,offset=0)=>{const m=minutes(time,true),p=d.add({days:offset+(m===1440?1:0)}).toPlainDateTime({hour:m===1440?0:Math.floor(m/60),minute:m%60});let a,b;try{a=p.toZonedDateTime(timeZone,{disambiguation:'earlier'});b=p.toZonedDateTime(timeZone,{disambiguation:'later'});}catch{throw new DomainError(400,'班次时区转换失败');}
  if(!a.toPlainDateTime().equals(p)||!b.toPlainDateTime().equals(p))throw new DomainError(400,`班次钟点不存在：${p.toString()} ${timeZone}`);if(a.epochMilliseconds!==b.epochMilliseconds&&r.ambiguousTime==='REJECT')throw new DomainError(400,`班次钟点重复，须选择EARLIER/LATER：${p.toString()} ${timeZone}`);return r.ambiguousTime==='LATER'?b.epochMilliseconds:a.epochMilliseconds;
 };
 const add=(a:number,b:number,reason:string)=>{a=Math.max(start,a);b=Math.min(end,b);if(a>=b)return;const run={a,b,reason};accountValue(run);runs.push(run);if(runs.length>8192)throw new DomainError(400,'循环日历展开超过8192段，请缩短声明范围或减少班次');};
 for(let d=first.subtract({days:1});Temporal.PlainDate.compare(d,last)<=0;d=d.add({days:1})){
  if(!d.toZonedDateTime(timeZone).toPlainDate().equals(d)){if(Temporal.PlainDate.compare(d,first)>=0)skippedDates.push(d.toString());continue;}
  for(const s of r.weekly){if(!s.isoWeekdays.includes(d.dayOfWeek)||Temporal.PlainDate.compare(d,first)<0&&s.endDayOffset===0)continue;
   const next=d.add({days:s.endDayOffset+(s.end==='24:00'?1:0)}),coversNext=s.endDayOffset===1&&s.end!=='00:00',startMasked=exceptionDates.has(d.toString()),endMasked=coversNext&&exceptionDates.has(next.toString());if(startMasked&&(!coversNext||endMasked))continue;
   const a=startMasked?next.toZonedDateTime(timeZone).epochMilliseconds:at(d,s.start),b=endMasked?next.toZonedDateTime(timeZone).epochMilliseconds:at(d,s.end,s.endDayOffset);add(a,b,`周班次 ${s.id} / ${d.toString()} · ${s.reason}`);
  }
 }
 for(const m of masks)for(const s of m.shifts)add(at(date(m.date),s.start),at(date(m.date),s.end),`日期例外 ${m.date} · ${s.reason}`);
 runs.sort((a,b)=>a.a-b.a||a.b-b.b);if(runs.some((p,i)=>i>0&&p.a<runs[i-1].b))throw new DomainError(400,'时区转换后班次重叠，不能推断优先级');
 const cuts=[...new Set([start,end,...runs.flatMap(p=>[p.a,p.b]),...masks.flatMap(p=>[Math.max(start,p.a),Math.min(end,p.b)])])].sort((a,b)=>a-b),periods:CalendarPeriod[]=[];let cursor=0;
 for(let i=1;i<cuts.length;i++){const a=cuts[i-1],b=cuts[i];while(cursor<runs.length&&runs[cursor].b<=a)cursor++;const run=runs[cursor]?.a<=a&&runs[cursor].b>=b?runs[cursor]:undefined,mask=masks.find(m=>a>=m.a&&a<m.b),reason=run?.reason||(mask?`日期例外 ${mask.date} · ${mask.reason}`:`声明非班次停产 · ${r.outsideReason}`),state=run?'RUN':'STOP',prior=periods.at(-1);
  if(state==='STOP'&&prior?.state==='STOP'&&prior.reason===reason){prior.to=new Date(b).toISOString();continue;}const p={from:new Date(a).toISOString(),to:new Date(b).toISOString(),state,reason} as CalendarPeriod;accountValue(p);periods.push(p);if(periods.length>8192)throw new DomainError(400,'循环日历展开超过8192段，请缩短声明范围或减少班次');
 }
 const tz=process.versions.tz;if(!tz)throw new DomainError(503,'运行时缺少可记录的时区数据库版本');
 return {periods,expansion:{engine:recurrenceEngine,polyfillVersion:recurrencePolyfill,timeZoneDataVersion:tz,sourceDigest:recurrenceDigest({deviceCode,timeZone,from,to,recurrence:r}),periodsDigest:recurrenceDigest(periods),periodCount:periods.length,skippedDates}};
}
export function frozenExpansion(raw:unknown,deviceCode:string,timeZone:string,from:string,to:string,recurrence:CalendarRecurrence,periods:CalendarPeriod[]){
 const e=object(raw,'冻结展开依据');keys(e,['engine','polyfillVersion','timeZoneDataVersion','sourceDigest','periodsDigest','periodCount','skippedDates']);
 if(e.engine!==recurrenceEngine||typeof e.polyfillVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(e.polyfillVersion)||typeof e.timeZoneDataVersion!=='string'||!e.timeZoneDataVersion||e.timeZoneDataVersion.length>40||e.sourceDigest!==recurrenceDigest({deviceCode,timeZone,from,to,recurrence})||e.periodsDigest!==recurrenceDigest(periods)||e.periodCount!==periods.length||!Array.isArray(e.skippedDates)||e.skippedDates.length>366||e.skippedDates.some(d=>typeof d!=='string'||date(d).toString()!==d)||new Set(e.skippedDates).size!==e.skippedDates.length)throw new DomainError(400,'循环声明与冻结展开依据不一致');
 return {engine:recurrenceEngine,polyfillVersion:e.polyfillVersion as string,timeZoneDataVersion:e.timeZoneDataVersion,sourceDigest:e.sourceDigest as string,periodsDigest:e.periodsDigest as string,periodCount:periods.length,skippedDates:[...e.skippedDates] as string[]};
}
