import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {calendarScheduleSchema} from './calendar-schedule-schema.ts';
import {calendarTimeline} from './calendar-schedule.ts';
import {publicationIndex} from './template-history.ts';
import {coverageQuery,uploadCoverage} from './plan-coverage.ts';
import {createTemplate,submitTemplate,approveTemplate,exportTemplate,importTemplate} from './catalog.ts';
import {seedStore} from './store.ts';
import {createBatch,approveBatch,emptyImports} from './imports.ts';
import {calendarTemplateVisible} from './operation-calendar.ts';
import {commandAccess} from './command-access.ts';
import {QualityPanel} from '../public/telemetry-quality-ui.js';
import {planCoverageView} from '../public/plan-coverage-ui.js';
import {scheduleFromCalendar} from '../public/calendar-schedule-ui.js';

const start=Date.parse('2026-10-15T00:00:00Z'),end=start+600000,now=Date.parse('2026-10-16T00:00:00Z'),iso=(n:number)=>new Date(n).toISOString();
const context=(actorId='designer',roles=['tenant-admin'],site='A')=>({tenantId:'acme',actorId,actorType:'USER',authMode:'oidc' as const,correlationId:randomUUID(),roles,scope:{provided:true,sites:[site],lines:[],devices:[]}}),designer=context(),reviewer=context('independent',['final-approver']),expected=(t:any)=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});
const policy={finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},manifest=(purpose:string,field:string,value:unknown)=>({schemaVersion:1,minPlatformVersion:'0.1.0',purpose,modules:['equipment','quality'],policy,[field]:value});
function clock<T>(at:number,fn:()=>T){const Real=Date;globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?at:v);}static now(){return at;}} as DateConstructor;try{return fn();}finally{globalThis.Date=Real;}}
function fixture(){const store=seedStore(),data=emptyImports();const batch=(type:any,rows:any[])=>{const b=createBatch(data,store,{dataType:type,rows,sourceSystem:'schedule-unit',templateVersion:'1.0.0',original:Buffer.from(JSON.stringify(rows)),filename:'qa.json',mime:'application/json',sourceKind:'API_JSON'},context('uploader',['data-uploader'],'*'));assert.equal(b.status,'AWAITING_APPROVAL',JSON.stringify(b.errors));approveBatch(data,store,b.batchId,{decision:'APPROVED',comment:'独立核对',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},context('data-reviewer',['final-approver'],'*'));return b;};
 batch('DEVICE',[{source_record_id:'a',device_code:'SCH-A',device_name:'安排设备',site_code:'A',line_code:'L'},{source_record_id:'b',device_code:'SCH-B',device_name:'隐藏设备',site_code:'B',line_code:'B'}]);
 const publish=(t:any,at=now)=>clock(at,()=>{if(t.status==='DRAFT')submitTemplate(store,t.id,expected(t),designer,data);return approveTemplate(store,t.id,{...expected(t),decision:'APPROVED',comment:'独立确认生效安排'},reviewer,data);});
 const cal=(version:string,state='RUN')=>{const t=createTemplate(store,{templateKey:'calendar-sch-a',version,industry:'测试',manifest:manifest('operation-calendar','operationCalendar',{deviceCode:'SCH-A',timeZone:'UTC',from:iso(start),to:iso(end+86400000),periods:[{from:iso(start),to:iso(end+86400000),state,reason:'明确安排'}]})},designer,data);publish(t,now-4000+Number(version.split('.')[1])*1000);return t;};
 const a=cal('1.0.0'),b=cal('1.1.0','STOP'),ref=(t:any)=>({templateId:t.id,templateKey:t.templateKey,version:t.version,contentDigest:t.contentDigest}),entry=(id:string,at:number,t:any)=>({id,effectiveFrom:iso(at),calendarRef:t?ref(t):null,reason:'生产审批依据'});
 const value=(entries:any[],intent='INITIAL')=>({deviceCode:'SCH-A',changeIntent:intent,changeReason:'明确变更依据',entries});
 const schedule=(version:string,entries:any[],intent='INITIAL')=>createTemplate(store,{templateKey:'schedule-sch-a',version,industry:'测试',manifest:manifest('calendar-schedule','calendarSchedule',value(entries,intent))},designer,data);
 const read=(at=now)=>{const idx=publicationIndex(store.audits,'acme');return calendarTimeline(store.templates,'acme','SCH-A',start,end,at,id=>idx.get(id));};
 return {store,data,batch,publish,a,b,ref,entry,value,schedule,read};
}
test('schedule schema requires exact finite ordered offset entries, explicit null and bounded identities',()=>{
 const f=fixture(),v=f.value([f.entry('one',start,f.a)]);assert.equal(calendarScheduleSchema(v).entries[0].effectiveFrom,iso(start));
 for(const mutate of [(s:any)=>s.changeIntent=['INITIAL'],(s:any)=>s.changeReason='',(s:any)=>s.entries=[],(s:any)=>s.entries=Array(129).fill(s.entries[0]),(s:any)=>s.entries.push(s.entries[0]),(s:any)=>s.entries[0].effectiveFrom='2026-02-30T00:00:00Z',(s:any)=>s.entries[0].effectiveFrom='2026-10-15T00:00:00',(s:any)=>delete s.entries[0].calendarRef,(s:any)=>s.entries[0].calendarRef.version='01.0.0',(s:any)=>s.entries[0].calendarRef.contentDigest='A'.repeat(64),(s:any)=>s.script='run']){const x=structuredClone(v);mutate(x);assert.throws(()=>calendarScheduleSchema(x));}
 assert.equal(calendarScheduleSchema(f.value([f.entry('unset',start,null)])).entries[0].calendarRef,null);
});
test('schedule binds exact independently approved historical calendar, never drafts or foreign references',()=>{
 const f=fixture();assert.equal(f.a.status,'RETIRED');const t=f.schedule('1.0.0',[f.entry('a',start,f.a)]);f.publish(t,now-1000);assert.equal(f.read().segments[0].calendar?.source.version,'1.0.0');
 for(const mutate of [(e:any)=>e.calendarRef.contentDigest='0'.repeat(64),(e:any)=>e.calendarRef.templateId='missing',(e:any)=>e.calendarRef.version='9.0.0',(e:any)=>e.effectiveFrom=iso(start-1),(e:any)=>e.effectiveFrom=iso(end+86400000)]){const e=f.entry('x',start,f.a);mutate(e);assert.throws(()=>f.schedule('1.1.0',[e],'PROSPECTIVE'),/精确日历/);}
});
test('schedule has independent approval, separate family, immutable device and no inheritance',()=>{
 const f=fixture(),t=f.schedule('1.0.0',[f.entry('a',start,f.a)]);submitTemplate(f.store,t.id,expected(t),designer,f.data);assert.throws(()=>approveTemplate(f.store,t.id,{...expected(t),decision:'APPROVED',comment:'self'},context('designer',['tenant-admin','final-approver']),f.data),/不得终审/);
 assert.throws(()=>createTemplate(f.store,{templateKey:'other-schedule',version:'1.0.0',industry:'测试',manifest:t.manifest},designer,f.data),/编码族/);assert.throws(()=>createTemplate(f.store,{templateKey:t.templateKey,version:'1.1.0',industry:'测试',parent:f.a.templateKey+'@'+f.a.version,manifest:t.manifest},designer,f.data),/不能继承/);
});
test('future changes preserve every effective entry at approval including exact boundary',()=>{
 const f=fixture(),a=f.entry('past',start,f.a),future=f.entry('future',now+1000,f.b),t=f.schedule('1.0.0',[a,future]);f.publish(t,now-1000);
 const wrong=f.schedule('1.1.0',[{...a,reason:'altered'}],'PROSPECTIVE');submitTemplate(f.store,wrong.id,expected(wrong),designer,f.data);assert.throws(()=>clock(now,()=>approveTemplate(f.store,wrong.id,{...expected(wrong),decision:'APPROVED',comment:'wrong'},reviewer,f.data)),/未来调整不能/);assert.equal(t.status,'PUBLISHED');
 const valid=f.schedule('1.2.0',[a,f.entry('new-future',now+500,f.b)],'PROSPECTIVE');f.publish(valid,now);assert.equal(t.status,'RETIRED');assert.equal(f.read(now-1).schedule?.version,'1.0.0');assert.equal(f.read(now).schedule?.version,'1.2.0');
 const edge=f.schedule('1.3.0',[a,f.entry('edge',now,f.b)],'PROSPECTIVE');assert.throws(()=>f.publish(edge,now),/未来调整不能/);
});
test('retrospective correction changes present calendar replay while old approval cutoff preserves old result',()=>{
 const f=fixture(),t=f.schedule('1.0.0',[f.entry('run',start,f.a)]);f.publish(t,now-1000);const old=f.read(now-1000);
 const next=f.schedule('1.1.0',[f.entry('stop',start,f.b)],'RETROSPECTIVE_CORRECTION');f.publish(next,now);assert.equal(f.read(now).segments[0].calendar?.calendar.periods[0].state,'STOP');assert.equal(f.read(now-1).segments[0].calendar?.calendar.periods[0].state,'RUN');assert.deepEqual(f.read(now-1000),old);assert.equal(f.read().replayScope,'CALENDAR_ONLY');assert.equal(f.read().definitionMode,'CURRENT_APPROVED');assert.equal(f.read().dataMode,'CURRENT_AUTHORIZED_RECORDS');
});
test('initial intent, nondecreasing persisted clock and semver tie ordering are enforced',()=>{
 const f=fixture(),bad=f.schedule('1.0.0',[f.entry('a',start,f.a)],'PROSPECTIVE');assert.throws(()=>f.publish(bad),/首个/);
 const t=f.schedule('1.1.0',[f.entry('a',start,f.a)]);f.publish(t,now-1000);const back=f.schedule('1.2.0',[f.entry('b',start,f.b)],'RETROSPECTIVE_CORRECTION');assert.throws(()=>f.publish(back,now-1001),/时间倒退/);f.publish(back,now-1000);assert.equal(f.read(now-1000).schedule?.version,'1.2.0');assert.equal(f.read(now-1001).schedule,null);
});
test('current permissions fence historical listing export command replay and knownAt coverage',()=>{
 const f=fixture(),t=f.schedule('1.0.0',[f.entry('a',start,f.a)]);f.publish(t);const hidden=context('independent',['final-approver'],'B');assert.equal(calendarTemplateVisible(t,f.store,f.data,hidden),false);assert.throws(()=>exportTemplate(f.store,t.id,hidden,f.data),/不存在/);assert.throws(()=>commandAccess('/api/v1/templates/'+t.id+'/approval','POST',expected(t),hidden,f.data,f.store),/不存在/);assert.throws(()=>importTemplate(seedStore(),exportTemplate(f.store,t.id,reviewer,f.data),{...hidden,roles:['tenant-admin']},emptyImports()),/未批准/);
 const q=new URLSearchParams({deviceCode:'SCH-A',from:iso(start),to:iso(end),planMode:'EFFECTIVE',knownAt:iso(now)});assert.deepEqual(uploadCoverage(f.data,f.store,f.store.audits,hidden,q,now).items,[]);assert.equal((uploadCoverage(f.data,f.store,f.store.audits,hidden,q,now) as any).timeline,null);
});
test('retirement approval count, snapshots, digest, actor and clock corruption fail closed',()=>{
 const f=fixture(),t=f.schedule('1.0.0',[f.entry('a',start,f.a)]);f.publish(t,now-1000);const next=f.schedule('1.1.0',[f.entry('b',start,f.b)],'RETROSPECTIVE_CORRECTION');f.publish(next,now);
 const idx=publicationIndex(f.store.audits,'acme'),e=idx.get(t.id)!;for(const change of [(x:any)=>x.approvalCount=2,(x:any)=>delete x.approval,(x:any)=>x.approval.actorId='designer',(x:any)=>x.anchor.before.status='DRAFT',(x:any)=>x.anchor.businessTime=iso(now-2000)]){const x=structuredClone(e);change(x);assert.throws(()=>calendarTimeline(f.store.templates,'acme','SCH-A',start,end,now,id=>id===t.id?x:idx.get(id)),/不可验证/);}
 const saved=f.a.contentDigest;f.a.contentDigest='0'.repeat(64);assert.throws(()=>f.read(now-1),/不可验证/);f.a.contentDigest=saved;next.status='RETIRED';assert.throws(()=>f.read(),/不可验证/);
});
test('effective half-open segments retain stop records, explicit unassigned and partial-slot denominators',()=>{
 const f=fixture();f.batch('POINT_DEFINITION',[{source_record_id:'p',device_code:'SCH-A',tag_code:'pressure',tag_name:'压力',unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:60}]);f.batch('MEASUREMENT',[0,30,60,299,300,599].map((s,i)=>({source_record_id:'m'+i,device_code:'SCH-A',tag_code:'pressure',measured_at:iso(start+s*1000),value:2,unit:'MPa',quality:'GOOD'})));
 const t=f.schedule('1.0.0',[f.entry('run',start+30000,f.a),f.entry('stop',start+300000,f.b),f.entry('unset',start+500000,null)]);f.publish(t,now-1000);const q=new URLSearchParams({deviceCode:'SCH-A',from:iso(start),to:iso(end),planMode:'EFFECTIVE'}),r:any=uploadCoverage(f.data,f.store,f.store.audits,reviewer,q,now);assert.equal(r.total,4);assert.equal(r.items.reduce((n:number,i:any)=>n+i.recordsInWindow,0),6);assert.equal(r.items[0].status,'UNKNOWN');assert.ok(r.items[0].conditions.includes('NO_EFFECTIVE_ENTRY'));assert.equal(r.items[1].expectedSlots,5);assert.equal(r.items[1].partialSlots,1);assert.equal(r.items[1].receivedSlots,3);assert.equal(r.items[2].status,'NOT_APPLICABLE');assert.equal(r.items[2].recordsInWindow,1);assert.ok(r.items[3].conditions.includes('CALENDAR_UNASSIGNED'));assert.equal(r.items[3].receivedCoveragePercent,null);
 q.delete('planMode');const legacy:any=uploadCoverage(f.data,f.store,f.store.audits,reviewer,q,now);assert.equal(legacy.calendar.version,'1.1.0');assert.equal(legacy.items[0].status,'NOT_APPLICABLE');assert.equal('timeline' in legacy,false);
});
test('coverage rejects malformed, repeated, current cutoff and future cutoff without silently defaulting',()=>{
 for(const extra of ['planMode=','planMode=OLD','knownAt='+iso(now),'planMode=EFFECTIVE&knownAt=','planMode=EFFECTIVE&knownAt='+iso(now+1),'planMode=EFFECTIVE&knownAt=2026-10-15T00:00:00','planMode=EFFECTIVE&planMode=CURRENT'])assert.throws(()=>coverageQuery(new URLSearchParams('deviceCode=SCH-A&'+extra),now),extra);
 const q=coverageQuery(new URLSearchParams('deviceCode=SCH-A&planMode=EFFECTIVE'),now);assert.equal(q.knownAt,now);
});
test('persisted approval millisecond boundary recheck rolls back approval and retirement atomically',()=>{
 const f=fixture(),a=f.entry('past',start,f.a),future=f.entry('boundary',now+1,f.b),old=f.schedule('1.0.0',[a,future]);f.publish(old,now-1000);
 const next=f.schedule('1.1.0',[a,{...future,reason:'changed while publishing'}],'PROSPECTIVE');submitTemplate(f.store,next.id,expected(next),designer,f.data);const before=JSON.stringify(f.store),Real=Date;let tick=now;
 globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?tick++:v);}static now(){return tick;}} as DateConstructor;
 try{assert.throws(()=>approveTemplate(f.store,next.id,{...expected(next),decision:'APPROVED',comment:'批准间跨过生效时刻'},reviewer,f.data),/未来调整不能/);}finally{globalThis.Date=Real;}
 assert.equal(JSON.stringify(f.store),before);assert.equal(old.status,'PUBLISHED');assert.equal(next.status,'AWAITING_APPROVAL');
});
test('excess point-segment product is rejected before calculating partial effective results',()=>{
 const f=fixture();f.batch('POINT_DEFINITION',Array.from({length:17},(_,i)=>({source_record_id:'p'+i,device_code:'SCH-A',tag_code:'p'+i,tag_name:'测点'+i,unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:60})));
 const t=f.schedule('1.0.0',Array.from({length:128},(_,i)=>f.entry('e'+i,start+i*1000,f.a)));f.publish(t,now);
 assert.throws(()=>uploadCoverage(f.data,f.store,f.store.audits,reviewer,new URLSearchParams({deviceCode:'SCH-A',from:iso(start),to:iso(end),planMode:'EFFECTIVE'}),now),(e:any)=>e.status===422);
 const result:any=uploadCoverage(f.data,f.store,f.store.audits,reviewer,new URLSearchParams({deviceCode:'SCH-A',tagCode:'p0',from:iso(start),to:iso(end),planMode:'EFFECTIVE'}),now);assert.equal(result.total,128);
});
test('schedule UI and segmented coverage display provenance safely with current scopes',async()=>{
 const f=fixture(),value=scheduleFromCalendar(f.a,[],()=> '1.0.0',start);assert.equal(value.manifest.calendarSchedule.entries[0].calendarRef.templateId,f.a.id);assert.equal(value.manifest.calendarSchedule.changeIntent,'INITIAL');
 const html=planCoverageView(null,{deviceCode:'<img>',planMode:'EFFECTIVE',knownAt:'<script>'},false,'UPLOADS');assert.ok(html.includes('审批记录截止'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img>'));
 const p=new QualityPanel();p.switchMetric('COVERAGE');p.filters={deviceCode:'SCH-A',planMode:'EFFECTIVE',knownAt:iso(now)};let release!:(v:unknown)=>void;const pending=p.load(()=>new Promise(ok=>release=ok),()=> 'actor');p.revision++;p.filters={deviceCode:'SCH-A',planMode:'CURRENT'};release({source:'UPLOADS',items:['old']});await pending;assert.equal(p.result,null);
});

