import test from 'node:test';
import assert from 'node:assert/strict';
import {Temporal} from '@js-temporal/polyfill';
import {operationCalendarSchema} from './calendar-schema.ts';
import {recurrenceSchema,recurrenceDigest} from './calendar-recurrence.ts';
import {operationCalendarSchema as previousExplicit} from '../scripts/fixtures/explicit-calendar-baseline.ts';
import {calendarAuthoringManifest,defaultWeeklyCalendar,weeklyCalendarEvidence} from '../public/weekly-calendar-ui.js';
import {coveragePlan} from './plan-coverage.ts';
import {createTemplate,submitTemplate,approveTemplate,exportTemplate,importTemplate,editTemplate} from './catalog.ts';
import {seedStore} from './store.ts';
import {createBatch,approveBatch,emptyImports,canonical} from './imports.ts';
import {calendarFor} from './operation-calendar.ts';
import {MemoryLedger} from './capacity.ts';

const rec=()=>({version:1,outsideShifts:'STOP',outsideReason:'明确非班次停产',ambiguousTime:'REJECT',nonexistentTime:'REJECT',weekly:[{id:'day',isoWeekdays:[1,2,3,4,5],start:'08:00',end:'16:00',endDayOffset:0,reason:'工作日白班'}],exceptions:[]}) as any;
const raw=(timeZone='Asia/Shanghai',from='2026-10-11T16:00:00Z',to='2026-10-18T16:00:00Z',recurrence=rec())=>({deviceCode:'WEEK-A',timeZone,from,to,recurrence});
const compile=(v=raw())=>operationCalendarSchema(v,true),runs=(c:ReturnType<typeof compile>)=>c.periods.filter(p=>p.state==='RUN'),hours=(c:ReturnType<typeof compile>)=>runs(c).reduce((n,p)=>n+(Date.parse(p.to)-Date.parse(p.from))/3600000,0);
const allDays=(start='00:00',end='04:00')=>({...rec(),weekly:[{id:'all',isoWeekdays:[1,2,3,4,5,6,7],start,end,endDayOffset:0,reason:'明确班次'}]});
const ctx=(actorId:string,roles:string[])=>({tenantId:'acme',actorId,actorType:'USER',correlationId:'weekly-unit',authMode:'oidc' as const,roles}),designer=ctx('designer',['tenant-admin']),reviewer=ctx('reviewer',['final-approver']);
function fixture(){const store=seedStore(),data=emptyImports(),row={source_record_id:'wa',device_code:'WEEK-A',device_name:'周计划设备',site_code:'A',line_code:'L1'},batch=createBatch(data,store,{dataType:'DEVICE',sourceSystem:'weekly-unit',templateVersion:'1.0.0',rows:[row],original:Buffer.from(JSON.stringify([row])),filename:'wa.json',mime:'application/json',sourceKind:'API_JSON'},ctx('uploader',['data-uploader']));assert.equal(batch.status,'AWAITING_APPROVAL');approveBatch(data,store,batch.batchId,{decision:'APPROVED',comment:'独立批准',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},reviewer);return {store,data};}
const manifest=(c:any)=>({schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'operation-calendar',modules:['equipment','quality'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},operationCalendar:c});
const expected=(t:any)=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});

test('weekly workweek compiles complete UTC periods with explicit STOP and deterministic frozen digests',()=>{
 const c=compile();assert.equal(hours(c),40);assert.equal(runs(c).length,5);assert.equal(c.periods.length,11);assert.equal(c.periods[0].from,c.from);assert.equal(c.periods.at(-1)?.to,c.to);assert.equal(c.expansion?.periodCount,11);assert.equal(c.expansion?.periodsDigest,recurrenceDigest(c.periods));assert.deepEqual(compile(),c);assert.deepEqual(operationCalendarSchema(c),c);
 const r=allDays();r.weekly=[];assert.equal(hours(compile(raw('UTC','2026-10-12T00:00:00Z','2026-10-13T00:00:00Z',r))),0);
});
test('weekly overnight covers Sunday to Monday and rejects civil overlap across the week boundary',()=>{
 const r={...rec(),weekly:[{id:'night',isoWeekdays:[7],start:'22:00',end:'06:00',endDayOffset:1,reason:'周日夜班'}]},c=compile(raw('Asia/Shanghai','2026-10-10T16:00:00Z','2026-10-12T16:00:00Z',r));assert.equal(hours(c),8);assert.equal(runs(c)[0].from,'2026-10-11T14:00:00.000Z');assert.equal(runs(c)[0].to,'2026-10-11T22:00:00.000Z');
 r.weekly.push({id:'conflict',isoWeekdays:[1],start:'01:00',end:'07:00',endDayOffset:0,reason:'重叠'});assert.throws(()=>compile(raw('UTC',undefined,undefined,r)),/周界/);
});
test('local-date exception replaces incoming and outgoing night portions, and explicit overtime replaces the whole date',()=>{
 const r={...rec(),weekly:[{id:'night',isoWeekdays:[7,1],start:'22:00',end:'06:00',endDayOffset:1,reason:'夜班'}],exceptions:[{date:'2026-10-12',reason:'整日节假日',shifts:[]}]},v=raw('Asia/Shanghai','2026-10-10T16:00:00Z','2026-10-13T16:00:00Z',r),c=compile(v);assert.equal(hours(c),8);assert.equal(runs(c).length,2);assert.ok(c.periods.some(p=>p.state==='STOP'&&p.reason.includes('整日节假日')&&Date.parse(p.to)-Date.parse(p.from)===86400000));
 r.exceptions.push({date:'2026-10-13',reason:'只安排加班',shifts:[{start:'10:00',end:'12:00',endDayOffset:0,reason:'临时加班'}]});const replaced=compile(v);assert.equal(hours(replaced),4);assert.ok(runs(replaced).some(p=>p.reason.includes('日期例外 2026-10-13')));
});
test('spring and fall shifts use real elapsed time, including non-hour transitions',()=>{
 for(const [zone,from,to,expectedHours]of [['America/New_York','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z',3],['America/New_York','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z',5],['Australia/Lord_Howe','2026-10-03T13:30:00Z','2026-10-04T13:00:00Z',3.5],['Australia/Lord_Howe','2026-04-04T13:00:00Z','2026-04-05T13:30:00Z',4.5]] as const){assert.equal(hours(compile(raw(zone,from,to,allDays()))),expectedHours,zone+' '+from);}
});
test('nonexistent shift clocks reject for every ambiguity policy, while an explicit date override can correct the plan',()=>{
 const r=allDays('02:30','04:00'),v=raw('America/New_York','2026-03-08T05:00:00Z','2026-03-09T04:00:00Z',r);for(const p of ['EARLIER','LATER','REJECT']){r.ambiguousTime=p;assert.throws(()=>compile(v),/钟点不存在/);}
 r.exceptions=[{date:'2026-03-08',reason:'夏令时调整',shifts:[{start:'03:00',end:'04:00',endDayOffset:0,reason:'调整班次'}]}];assert.equal(hours(compile(v)),1);
});
test('ambiguous clocks require explicit earlier or later selection and preserve the chosen UTC occurrence',()=>{
 const r=allDays('01:15','01:45'),v=raw('America/New_York','2026-11-01T04:00:00Z','2026-11-02T05:00:00Z',r);assert.throws(()=>compile(v),/钟点重复/);r.ambiguousTime='EARLIER';assert.equal(runs(compile(v))[0].from,'2026-11-01T05:15:00.000Z');r.ambiguousTime='LATER';assert.equal(runs(compile(v))[0].from,'2026-11-01T06:15:00.000Z');
});
test('midnight DST and an entirely skipped local date cannot manufacture 24 hours',()=>{
 const r={...allDays(),weekly:[],exceptions:[{date:'2018-11-04',reason:'午夜跳变整日停产',shifts:[]}]},c=compile(raw('America/Sao_Paulo','2018-11-04T03:00:00Z','2018-11-05T02:00:00Z',r));assert.equal(c.periods.length,1);assert.equal(Date.parse(c.to)-Date.parse(c.from),23*3600000);
 const a=compile(raw('Pacific/Apia','2011-12-29T10:00:00Z','2011-12-31T10:00:00Z',allDays('08:00','16:00')));assert.equal(hours(a),16);assert.deepEqual(a.expansion?.skippedDates,['2011-12-30']);const e={...allDays(),exceptions:[{date:'2011-12-30',reason:'不存在日',shifts:[]}]};assert.throws(()=>compile(raw('Pacific/Apia','2011-12-29T10:00:00Z','2011-12-31T10:00:00Z',e)),/整日不存在/);
});
test('recurrence grammar rejects coercion, duplicates, unknown fields, overlap and invalid dates or clock lengths',()=>{
 for(const mutate of [(r:any)=>r.version='1',(r:any)=>r.outsideShifts='UNKNOWN',(r:any)=>r.ambiguousTime=['EARLIER'],(r:any)=>r.nonexistentTime='LATER',(r:any)=>r.weekly[0].isoWeekdays=[1,1],(r:any)=>r.weekly[0].isoWeekdays=['1'],(r:any)=>r.weekly[0].start='24:00',(r:any)=>r.weekly[0].endDayOffset='0',(r:any)=>r.weekly[0].endDayOffset=1,(r:any)=>r.weekly[0].script='bypass',(r:any)=>r.weekly.push({...r.weekly[0]}),(r:any)=>r.exceptions=[{date:'2026-02-30',reason:'bad',shifts:[]}],(r:any)=>r.exceptions=[{date:'2026-10-12',reason:'bad',shifts:[{start:'22:00',end:'06:00',endDayOffset:1,reason:'bad'}]}]]){const r=rec();mutate(r);assert.throws(()=>recurrenceSchema(r));}
 const r=rec();r.exceptions=[{date:'2026-10-12',reason:'a',shifts:[]},{date:'2026-10-12',reason:'b',shifts:[]}];assert.throws(()=>recurrenceSchema(r),/重复/);r.exceptions=[{date:'2027-01-01',reason:'范围之外',shifts:[]}];assert.throws(()=>compile(raw(undefined,undefined,undefined,r)),/声明范围/);
});
test('frozen reads do not re-expand or depend on the current tzdb; stale imports require an explicit rebuild',()=>{
 const c=compile();c.expansion!.timeZoneDataVersion='old-tzdb';c.expansion!.polyfillVersion='0.4.0';const original=Temporal.PlainDate.prototype.toZonedDateTime;Temporal.PlainDate.prototype.toZonedDateTime=function(){throw Error('must not compile');};try{assert.deepEqual(operationCalendarSchema(c),c);}finally{Temporal.PlainDate.prototype.toZonedDateTime=original;}
 assert.throws(()=>operationCalendarSchema(c,true),/显式重建/);assert.throws(()=>operationCalendarSchema(raw()),/草稿保存/);assert.deepEqual(compile({...c,periods:undefined,expansion:undefined}),compile());
});
test('forged periods and independently recomputed digests cannot enter through authoring or published-pack import',()=>{
 const c=compile();c.periods[0].state='RUN';assert.throws(()=>operationCalendarSchema(c),/冻结展开/);c.expansion!.periodsDigest=recurrenceDigest(c.periods);assert.throws(()=>operationCalendarSchema(c,true),/显式重建/);
});
test('independent publication freezes recurrence and expanded periods, and explicit edit rebuild preserves prior publication',()=>{
 const {store,data}=fixture(),t=createTemplate(store,{templateKey:'weekly-a',version:'1.0.0',industry:'制造',manifest:manifest(raw())},designer,data);const original=structuredClone(t.manifest);assert.ok((t.manifest.operationCalendar as any).periods.length);submitTemplate(store,t.id,expected(t),designer,data);assert.throws(()=>approveTemplate(store,t.id,{...expected(t),decision:'APPROVED',comment:'自审'},ctx('designer',['tenant-admin','final-approver']),data),/不得终审/);approveTemplate(store,t.id,{...expected(t),decision:'APPROVED',comment:'独立复核展开及例外'},reviewer,data);
 const binding=calendarFor(store.templates,'acme','WEEK-A',id=>[...store.audits].reverse().find(a=>a.objectId===id))!;assert.equal(binding.source.recurrence?.weeklyRules,1);const plan=coveragePlan(binding,Date.parse(raw().from),Date.parse(raw().to),60);assert.equal(plan.expectedSlots,40*60);
 const pack=exportTemplate(store,t.id,reviewer,data);const other=fixture(),imported=importTemplate(other.store,pack,designer,other.data);assert.deepEqual(imported.manifest,original);assert.equal(imported.status,'DRAFT');const next=createTemplate(store,{templateKey:'weekly-a',version:'1.1.0',industry:'制造',manifest:calendarAuthoringManifest(t.manifest)},designer,data);const draft=calendarAuthoringManifest(next.manifest);draft.operationCalendar.recurrence.exceptions=[{date:'2026-10-12',reason:'节假日',shifts:[]}];editTemplate(store,next.id,{...expected(next),manifest:draft},designer,data);assert.equal((next.manifest.operationCalendar as any).recurrence.exceptions.length,1);assert.deepEqual(t.manifest,original);
});
test('legacy explicit calendar output is exactly equal to the independent prior-release schema',()=>{
 for(const zone of ['UTC','Asia/Shanghai','America/New_York']){const c={deviceCode:'A',timeZone:zone,from:'2026-10-12T00:00:00+08:00',to:'2026-10-13T00:00:00+08:00',periods:[{from:'2026-10-12T00:00:00+08:00',to:'2026-10-12T08:00:00+08:00',state:'RUN',reason:'班次'},{from:'2026-10-12T08:00:00+08:00',to:'2026-10-13T00:00:00+08:00',state:'STOP',reason:'停产'}]};assert.equal(canonical(operationCalendarSchema(c)),canonical(previousExplicit(c)));}
});
test('annual recurring calendar may exceed the old explicit limit but keeps bounded complete expansion',()=>{
 const r=allDays();r.weekly.push({id:'second',isoWeekdays:[1,2,3,4,5,6,7],start:'12:00',end:'16:00',endDayOffset:0,reason:'第二班'});const c=compile(raw('Asia/Shanghai','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',r));assert.ok(c.periods.length>512);assert.ok(c.periods.length<=8192);assert.equal(c.expansion?.periodCount,c.periods.length);assert.deepEqual(operationCalendarSchema(c),c);
});
test('recurrence browser helpers explicitly rebuild derived fields and escape frozen metadata',()=>{
 const t={manifest:manifest(compile())},draft=calendarAuthoringManifest(t.manifest);assert.equal(draft.operationCalendar.periods,undefined);assert.equal(draft.operationCalendar.expansion,undefined);assert.ok((t.manifest.operationCalendar as any).periods.length);assert.ok(defaultWeeklyCalendar().manifest.operationCalendar.recurrence);(t.manifest.operationCalendar as any).expansion.timeZoneDataVersion='<img src=x onerror=bad>';const html=weeklyCalendarEvidence(t);assert.ok(!html.includes('<img'));assert.ok(html.includes('冻结展开'));assert.ok(html.includes('显式')||html.includes('重建'));
});
test('overlarge expansions reject completely and compilation admission runs before draft or audit mutation',()=>{
 const r=allDays();r.weekly=Array.from({length:32},(_,i)=>({id:'r'+i,isoWeekdays:[1,2,3,4,5,6,7],start:'00:'+String(i).padStart(2,'0'),end:'00:'+String(i+1).padStart(2,'0'),endDayOffset:0,reason:'短班'}));assert.throws(()=>compile(raw('UTC','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',r)),/8192段/);
 const f=fixture(),before=canonical({templates:f.store.templates,audits:f.store.audits}),ledger=new MemoryLedger(4096,{task:4096}),a=ledger.account('task');try{assert.throws(()=>createTemplate(f.store,{templateKey:'weekly-budget',version:'1.0.0',industry:'制造',manifest:manifest(raw())},designer,f.data,()=>a.grow(1000)),/容量|预算/);assert.equal(canonical({templates:f.store.templates,audits:f.store.audits}),before);}finally{a.release();}assert.equal(ledger.snapshot().total,0);
});
