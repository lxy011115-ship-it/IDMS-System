import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {operationCalendarSchema} from './calendar-schema.ts';
import {coveragePlan,countCoverage,coverageResult,coverageQuery,uploadCoverage} from './plan-coverage.ts';
import {calendarFor,calendarTemplateVisible} from './operation-calendar.ts';
import {createTemplate,submitTemplate,approveTemplate,editTemplate,exportTemplate,importTemplate} from './catalog.ts';
import {validateManifest} from './template-schema.ts';
import {commandAccess} from './command-access.ts';
import {emptyImports,createBatch,approveBatch,canonical} from './imports.ts';
import {seedStore} from './store.ts';
import {QualityPanel} from '../public/telemetry-quality-ui.js';
import {planCoverageView,defaultOperationCalendar} from '../public/plan-coverage-ui.js';
import {resident} from './capacity.ts';
import {telemetryCoverageSqlRead} from './plan-coverage-sql.ts';

const start=Date.parse('2026-10-15T00:00:00Z'),end=start+600000,stamp=(s:number)=>new Date(start+s*1000).toISOString();
const context=(actorId='designer',roles=['tenant-admin'],site='A')=>({tenantId:'acme',actorId,actorType:'USER',authMode:'oidc' as const,correlationId:randomUUID(),roles,scope:{provided:true,sites:[site],lines:[],devices:[]}}),designer=context(),reviewer=context('reviewer',['final-approver']);
const calendar=()=>({deviceCode:'CAL-A',timeZone:'Asia/Shanghai',from:stamp(0),to:stamp(600),periods:[{from:stamp(0),to:stamp(180),state:'RUN',reason:'正常生产'},{from:stamp(180),to:stamp(420),state:'STOP',reason:'批准停产'},{from:stamp(420),to:stamp(600),state:'RUN',reason:'恢复运行'}]});
const manifest=(c:unknown=calendar())=>({schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'operation-calendar',modules:['equipment','quality'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},operationCalendar:c});
const expected=(t:any)=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});
function fixture(){const store=seedStore(),data=emptyImports();const approve=(type:any,rows:any[],extra={})=>{const b=createBatch(data,store,{dataType:type,rows,sourceSystem:'calendar-unit',templateVersion:'1.0.0',original:Buffer.from(JSON.stringify(rows)),filename:'qa.json',mime:'application/json',sourceKind:'API_JSON',...extra},context('uploader',['data-uploader'],'*'));assert.equal(b.status,'AWAITING_APPROVAL',JSON.stringify(b.errors));approveBatch(data,store,b.batchId,{decision:'APPROVED',comment:'独立核对',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},context('upload-reviewer',['final-approver'],'*'));return b;};
 approve('DEVICE',[{source_record_id:'a',device_code:'CAL-A',device_name:'设备A',site_code:'A',line_code:'L1'},{source_record_id:'b',device_code:'CAL-B',device_name:'不可见设备',site_code:'B',line_code:'L2'}]);
 const t=createTemplate(store,{templateKey:'calendar-a',version:'1.0.0',industry:'制造',manifest:manifest()},designer,data);
 const publish=()=>{submitTemplate(store,t.id,expected(t),designer,data);approveTemplate(store,t.id,{...expected(t),decision:'APPROVED',comment:'独立复核运行计划'},reviewer,data);};
 return {store,data,t,approve,publish};
}
function binding(){const f=fixture();f.publish();return calendarFor(f.store.templates,'acme','CAL-A',id=>[...f.store.audits].reverse().find(a=>a.objectId===id))!;}

test('operation calendar requires explicit zones, real dates and complete finite contiguous RUN STOP periods',()=>{
 const valid=operationCalendarSchema(calendar());assert.equal(valid.periods.length,3);assert.equal(valid.from,stamp(0));
 for(const mutate of [(c:any)=>c.from='2026-02-30T00:00:00Z',(c:any)=>c.to='2026-10-15T00:10:00',(c:any)=>c.timeZone='Bad/Zone',(c:any)=>c.timeZone='+08:00',(c:any)=>c.periods[0].state=['RUN'],(c:any)=>c.periods[1].from=stamp(181),(c:any)=>c.periods[1].from=stamp(179),(c:any)=>c.periods[2].to=stamp(599),(c:any)=>c.periods[0].state='AUTO',(c:any)=>c.periods[0].script='ignore',(c:any)=>c.deviceCode='../A',(c:any)=>c.periods=Array(513).fill(c.periods[0])]){const c=calendar();mutate(c);assert.throws(()=>operationCalendarSchema(c));}
 for(const m of [{...manifest(),maintenance:{fields:[]}},{...manifest(),policy:{finalApproval:'AI',deviceAccess:'READ_ONLY'}},{...manifest(),modules:['maintenance']}])assert.throws(()=>validateManifest(m));
 const offset=calendar();offset.from='2026-10-15T08:00:00+08:00';offset.periods[0].from=offset.from;assert.equal(operationCalendarSchema(offset).from,stamp(0));
});
test('calendar retains independent human governance and rejects another family, changed device and inheritance',()=>{
 const f=fixture();submitTemplate(f.store,f.t.id,expected(f.t),designer,f.data);assert.throws(()=>approveTemplate(f.store,f.t.id,{...expected(f.t),decision:'APPROVED',comment:'自审'},context('designer',['tenant-admin','final-approver']),f.data),/不得终审/);approveTemplate(f.store,f.t.id,{...expected(f.t),decision:'APPROVED',comment:'独立批准'},reviewer,f.data);
 assert.throws(()=>createTemplate(f.store,{templateKey:'different-family',version:'1.0.0',industry:'制造',manifest:manifest()},designer,f.data),/日历编码族/);
 assert.throws(()=>createTemplate(f.store,{templateKey:'calendar-a',version:'1.1.0',industry:'制造',manifest:manifest({...calendar(),deviceCode:'CAL-B'})},designer,f.data),/日历编码族/);
 assert.throws(()=>createTemplate(f.store,{templateKey:'calendar-a',version:'1.1.0',industry:'制造',parent:'calendar-a@1.0.0',manifest:manifest()},designer,f.data),/不能继承/);
 const n=createTemplate(f.store,{templateKey:'calendar-a',version:'1.1.0',industry:'制造',manifest:manifest()},designer,f.data);assert.throws(()=>editTemplate(f.store,n.id,{...expected(n),manifest:manifest({...calendar(),deviceCode:'CAL-B'})},designer,f.data),/日历编码族/);
});
test('calendar current scope blocks list export import approval and command receipt replay after scope change',()=>{
 const f=fixture();f.publish();const hidden=context('reviewer',['final-approver'],'B');assert.equal(calendarTemplateVisible(f.t,f.store,f.data,hidden),false);assert.throws(()=>exportTemplate(f.store,f.t.id,hidden,f.data),/不存在/);assert.equal(calendarTemplateVisible(f.t,f.store,f.data,{...reviewer,tenantId:'sandbox'}),false);
 assert.throws(()=>commandAccess('/api/v1/templates/'+f.t.id+'/approval','POST',expected(f.t),hidden,f.data,f.store),/不存在/);
 assert.throws(()=>commandAccess('/api/v1/templates','POST',{templateKey:'calendar-a',manifest:manifest({...calendar(),deviceCode:'NOT-APPROVED'})},designer,f.data,f.store),/未批准/);
 const pack=exportTemplate(f.store,f.t.id,reviewer,f.data);assert.throws(()=>importTemplate(seedStore(),pack,context('admin',['tenant-admin'],'B'),emptyImports()),/未批准/);
});
test('calendar binding requires latest governance event equal to published content and original independent actor',()=>{
 const f=fixture();f.publish();const get=(id:string)=>[...f.store.audits].reverse().find(a=>a.objectId===id);assert.equal(calendarFor(f.store.templates,'acme','CAL-A',get)?.source.version,'1.0.0');assert.throws(()=>calendarFor(f.store.templates,'acme','CAL-A',()=>undefined),/治理依据/);
 const a=get(f.t.id)!;assert.throws(()=>calendarFor(f.store.templates,'acme','CAL-A',()=>({...a,actorId:'designer'})),/治理依据/);f.t.manifest.operationCalendar={...calendar(),timeZone:'UTC'};assert.throws(()=>calendarFor(f.store.templates,'acme','CAL-A',get),/治理依据/);
});
test('plan slots exclude declared stop, preserve per-run anchor and deduplicate valid observations',()=>{
 const plan=coveragePlan(binding(),start,end,60),counts=countCoverage(plan,[0,2,61,119,180,300,420,479,540,599,600].map((s,i)=>({time:start+s*1000,goodValid:i!==2}))),result=coverageResult(plan,counts,true);
 assert.equal(plan.expectedSlots,6);assert.equal(plan.runSeconds,360);assert.equal(plan.stopSeconds,240);assert.equal(result.recordsInWindow,10);assert.equal(result.recordsInPlannedSlots,8);assert.equal(result.receivedSlots,4);assert.equal(result.goodValidSlots,4);assert.equal(result.duplicateRecordsInPlannedSlots,4);assert.equal(result.recordsOutsidePlannedSlots,2);assert.equal(result.missingSlots,2);assert.equal(result.receivedCoveragePercent,4/6*100);
});
test('partial windows count intersecting fixed-anchor slots including one partial slot exactly once',()=>{
 const b=binding(),single=coveragePlan(b,start+10000,start+20000,60);assert.equal(single.expectedSlots,1);assert.equal(single.partialSlots,1);const clipped=coveragePlan(b,start+30000,start+150000,60);assert.equal(clipped.expectedSlots,3);assert.equal(clipped.partialSlots,2);
 const counts=countCoverage(clipped,[{time:start+29000,goodValid:true},{time:start+30000,goodValid:true},{time:start+149999,goodValid:true},{time:start+150000,goodValid:true}]);assert.equal(counts.receivedSlots,2);assert.equal(counts.records,2);
});
test('missing calendar interval definition or undeclared window never invent complete rates; stop is not 100 percent',()=>{
 for(const [b,from,to,interval,declared]of [[null,start,end,60,true],[binding(),start,end,null,true],[binding(),start-1,end,60,true],[binding(),start,end,60,false]] as const){const p=coveragePlan(b,from,to,interval),r=coverageResult(p,countCoverage(p,[]),declared);assert.equal(r.status,'UNKNOWN');assert.equal(r.receivedCoveragePercent,null);assert.equal(r.goodValidCoveragePercent,null);}
 const stop=coveragePlan(binding(),start+180000,start+420000,60),r=coverageResult(stop,countCoverage(stop,[{time:start+200000,goodValid:true}]),true);assert.equal(r.status,'NOT_APPLICABLE');assert.equal(r.expectedSlots,0);assert.equal(r.receivedCoveragePercent,null);assert.equal(r.recordsOutsidePlannedSlots,1);
 assert.throws(()=>coverageResult(coveragePlan(binding(),start,end,60),{records:1,plannedRecords:1,receivedSlots:2,goodValidSlots:0},true),/分母/);
});
test('strict coverage contract requires device and no tenant status or equal-window override',()=>{
 const now=end;for(const q of ['','deviceCode=CAL-A&tenantId=sandbox','deviceCode=CAL-A&status=ALL','deviceCode=CAL-A&deviceCode=CAL-B','deviceCode=CAL-A&pageSize=101','deviceCode=CAL-A&from=2026-02-30T00:00:00Z','deviceCode=CAL-A&from='+stamp(0)+'&to='+stamp(0)])assert.throws(()=>coverageQuery(new URLSearchParams(q),now),q);
 assert.equal(coverageQuery(new URLSearchParams({deviceCode:'CAL-A',from:stamp(0),to:stamp(600)}),now).device,'CAL-A');
});
test('approved upload coverage follows effective correction and current published calendar without erasing observed data',()=>{
 const f=fixture();f.publish();const d=f.approve('POINT_DEFINITION',[{source_record_id:'point',device_code:'CAL-A',tag_code:'pressure',tag_name:'压力',unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:60}]);
 const m=f.approve('MEASUREMENT',[0,60,120,180,300,420,480,540].map((s,i)=>({source_record_id:'m'+i,device_code:'CAL-A',tag_code:'pressure',measured_at:stamp(s),value:2,unit:'MPa',quality:i===0?'BAD':'GOOD'})));
 const q=new URLSearchParams({deviceCode:'CAL-A',from:stamp(0),to:stamp(600)}),read=()=>uploadCoverage(f.data,f.store,f.store.audits,reviewer,q,end),a=read().items[0] as any;assert.equal(a.expectedSlots,6);assert.equal(a.receivedSlots,6);assert.equal(a.goodValidSlots,5);assert.equal(a.receivedCoveragePercent,100);assert.equal(a.recordsOutsidePlannedSlots,2);assert.equal(a.definitionSource.batchId,d.batchId);
 f.approve('MEASUREMENT',[{...m.rows[0],quality:'GOOD'}],{supersedesBatchId:m.batchId,correctionReason:'原始凭证复核'});assert.equal((read().items[0] as any).goodValidSlots,6);
 const legacy=f.data.records.find(r=>r.dataType==='MEASUREMENT'&&r.value.source_record_id==='m1')!;const saved=legacy.value.value;(legacy.value as any).value=null;assert.equal((read().items[0] as any).goodValidSlots,5,'legacy null must not become numeric zero and fill a GOOD slot');legacy.value.value=saved;
 f.approve('POINT_DEFINITION',[{source_record_id:'numeric-unit-point',device_code:'CAL-A',tag_code:'raw_counter',tag_name:123,unit:7,min_value:0,max_value:10,expected_interval_seconds:60}]);f.approve('MEASUREMENT',[{source_record_id:'numeric-unit-value',device_code:'CAL-A',tag_code:'raw_counter',measured_at:stamp(0),value:2,unit:'7',quality:'GOOD'}]);const numeric=read().items.find((i:any)=>i.tagCode==='raw_counter') as any;assert.equal(numeric.goodValidSlots,1);assert.equal(numeric.tagName,'123');
 assert.deepEqual(uploadCoverage(f.data,f.store,f.store.audits,context('hidden',['quality-engineer'],'B'),q,end).items,[]);
 const n=createTemplate(f.store,{templateKey:'calendar-a',version:'1.1.0',industry:'制造',manifest:manifest({...calendar(),periods:[{from:stamp(0),to:stamp(600),state:'STOP',reason:'全部停产'}]})},designer,f.data);submitTemplate(f.store,n.id,expected(n),designer,f.data);approveTemplate(f.store,n.id,{...expected(n),decision:'APPROVED',comment:'复核计划'},reviewer,f.data);assert.equal(f.t.status,'RETIRED');assert.equal(read().calendar?.version,'1.1.0');assert.equal((read().items[0] as any).status,'NOT_APPLICABLE');assert.equal((read().items[0] as any).recordsInWindow,8);
});
test('coverage UI request generation prevents late metric/source/identity reuse and keeps safe retry input',async()=>{
 const p=new QualityPanel();p.switchMetric('COVERAGE');assert.equal(p.metric,'COVERAGE');let called=false;await p.load(async()=>{called=true;},()=> 'a');assert.equal(called,false);p.filters={deviceCode:'CAL-A'};
 let release!:(v:unknown)=>void;const pending=p.load(()=>new Promise(ok=>release=ok),()=> 'a');p.switchMetric('QUALITY');release({source:'UPLOADS',items:['late']});await pending;assert.equal(p.result,null);
 p.switchMetric('COVERAGE');p.filters={deviceCode:'CAL-A'};await assert.rejects(p.load(async()=>{throw Error('snapshot unavailable');},()=> 'a'));assert.equal(p.filters.deviceCode,'CAL-A');assert.equal(p.result,null);assert.equal(p.error,'snapshot unavailable');
 const html=planCoverageView(null,{deviceCode:'<img onerror=bad>'},false,'UPLOADS','<script>bad</script>');assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('计划采样覆盖'));assert.equal(defaultOperationCalendar(start).manifest.operationCalendar.deviceCode,'');
});
test('coverage SQL failure hides raw driver details and releases budget for subsequent requests',async()=>{
 const before=resident.snapshot().total,query=new URLSearchParams({deviceCode:'CAL-A',from:stamp(0),to:stamp(600)});let released=0;
 const pool={connect:async()=>({query:async(text:string)=>{if(text.startsWith('BEGIN'))return {rows:[]};if(text==='ROLLBACK')return {rows:[]};throw Error('PRIVATE-SQL-PASSWORD');},release:()=>released++})};
 await assert.rejects(telemetryCoverageSqlRead(pool as any,reviewer,query,[],async()=>{throw Error('PRIVATE-SQL-PASSWORD');},end),(e:any)=>e.status===503&&!e.message.includes('PRIVATE'));assert.equal(released,1);assert.equal(resident.snapshot().total,before);
});
