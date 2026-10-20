import {defaultOperationCalendar} from './plan-coverage-ui.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function calendarAuthoringManifest(manifest){
 if(manifest?.purpose!=='operation-calendar'||!manifest.operationCalendar?.recurrence)return manifest;
 const copy=structuredClone(manifest);delete copy.operationCalendar.periods;delete copy.operationCalendar.expansion;return copy;
}
export function defaultWeeklyCalendar(now=Date.now()){
 const value=defaultOperationCalendar(now),day=new Date(now+8*3600000);day.setUTCHours(0,0,0,0);const start=day.getTime()-8*3600000;
 value.templateKey='weekly-calendar-device';const c=value.manifest.operationCalendar;c.from=new Date(start).toISOString();c.to=new Date(start+7*86400000).toISOString();delete c.periods;
 c.recurrence={version:1,outsideShifts:'STOP',outsideReason:'明确计划：非班次时段停产',ambiguousTime:'REJECT',nonexistentTime:'REJECT',weekly:[{id:'weekday-day',isoWeekdays:[1,2,3,4,5],start:'08:00',end:'16:00',endDayOffset:0,reason:'工作日白班'}],exceptions:[]};return value;
}
export function weeklyCalendarEvidence(t){const c=t.manifest?.operationCalendar;if(!c?.recurrence)return '';const r=c.recurrence,e=c.expansion;
 return `<p>循环周班次 ${esc(r.weekly.length)} 条 · 日期例外 ${esc(r.exceptions.length)} 日；未列时段已声明STOP。重复钟点策略 ${esc(r.ambiguousTime)}，不存在钟点拒绝。</p><p>冻结展开 ${esc(e?.periodCount)} 段 · 时区数据 ${esc(e?.timeZoneDataVersion)} · 编译器 ${esc(e?.engine)} / Temporal ${esc(e?.polyfillVersion)}</p><p>编辑或复制此循环配置后保存草稿会按当前时区版本重建全部区间，再由独立人员终审。旧发布版的区间与摘要不改写。</p>${e?.skippedDates?.length?`<p>范围内没有实际时间长度的当地日期：${e.skippedDates.map(esc).join('、')}，未伪造24小时。</p>`:''}`;
}
