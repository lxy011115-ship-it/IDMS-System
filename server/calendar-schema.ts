import {DomainError} from './service.ts';
import {object,keys,text} from './schema-primitives.ts';
import {recurrenceSchema,compileRecurrence,frozenExpansion,recurrenceDigest} from './calendar-recurrence.ts';

export function calendarTime(raw:unknown){
 if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(raw)||!Number.isFinite(Date.parse(raw))||new Date(raw.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==raw.slice(0,10))throw new DomainError(400,'日历时间须为有效日期且明确时区偏移');
 return Date.parse(raw);
}
export function calendarIdentity(raw:unknown){const v=object(raw,'运行日历');const deviceCode=text(v.deviceCode,'设备编码',128);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deviceCode))throw new DomainError(400,'日历设备编码无效');return deviceCode;}
export function operationCalendarSchema(raw:unknown,materialize=false,account?:(value:unknown)=>void){
 const v=object(raw,'运行日历');keys(v,['deviceCode','timeZone','from','to','periods','recurrence','expansion']);
 const deviceCode=text(v.deviceCode,'设备编码',128);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deviceCode))throw new DomainError(400,'日历设备编码无效');
 const timeZone=text(v.timeZone,'展示时区',80);try{if(/^[+-]/.test(timeZone))throw Error();new Intl.DateTimeFormat('en',{timeZone});}catch{throw new DomainError(400,'日历展示时区须为有效命名时区');}
 const start=calendarTime(v.from),end=calendarTime(v.to);if(start>=end||end-start>366*86400000)throw new DomainError(400,'日历范围须大于零且不超过366天');
 const recurrence=v.recurrence===undefined?undefined:recurrenceSchema(v.recurrence),from=new Date(start).toISOString(),to=new Date(end).toISOString(),compiled=recurrence&&materialize?compileRecurrence(deviceCode,timeZone,from,to,recurrence,account):undefined;
 if(!recurrence&&v.expansion!==undefined)throw new DomainError(400,'显式日历不能混入循环展开依据');
 const input=v.periods??compiled?.periods,limit=recurrence?8192:512;
 if(!Array.isArray(input)||!input.length||input.length>limit)throw new DomainError(400,`日历须含1至${limit}个冻结连续区间；循环作者声明仅可在草稿保存时展开`);
 let previous=start;
 const periods=input.map(raw=>{const p=object(raw,'日历区间');keys(p,['from','to','state','reason']);const a=calendarTime(p.from),b=calendarTime(p.to),reason=text(p.reason,'运行/停产依据',500);
  if(a!==previous||b<=a||b>end||typeof p.state!=='string'||!['RUN','STOP'].includes(p.state))throw new DomainError(400,'日历区间须按时间连续、无重叠且覆盖声明范围，状态仅RUN/STOP');previous=b;
  return {from:new Date(a).toISOString(),to:new Date(b).toISOString(),state:p.state as 'RUN'|'STOP',reason};
 });
 if(previous!==end)throw new DomainError(400,'日历区间未完整覆盖声明范围');
 const expansion=recurrence?frozenExpansion(v.expansion??compiled?.expansion,deviceCode,timeZone,from,to,recurrence,periods):undefined;
 if(compiled&&recurrenceDigest({periods,expansion})!==recurrenceDigest(compiled))throw new DomainError(409,'冻结循环配置与当前编译器/时区展开不同，请在新草稿中显式重建');
 return {deviceCode,timeZone,from,to,periods,...(recurrence?{recurrence,expansion:expansion!}:{})};
}
export type OperationCalendar=ReturnType<typeof operationCalendarSchema>;
