import test from 'node:test';
import assert from 'node:assert/strict';
import {qualitySources,qualityPlans,qualityItem,qualityResponse,qualityIntake,telemetryQualityQuery,qualityCount,pointEvidence,qualityPolicy,metricKeys,type QualityPoint,type PointMetrics,type QualityDefinition} from './telemetry-quality.ts';
import {qualityMetrics,telemetryQualitySqlRead} from './telemetry-quality-sql.ts';
import {QualityPanel,telemetryQualityView} from '../public/telemetry-quality-ui.js';
import {dataQualityView} from '../public/data-quality-ui.js';
import {resident,CapacityError,sqlScheduler} from './capacity.ts';
const now=Date.parse('2026-10-16T05:00:00.000Z'),query=()=>telemetryQualityQuery(new URLSearchParams({from:new Date(now-3600000).toISOString(),to:new Date(now).toISOString()}),now);
const ctx={tenantId:'acme',actorId:'quality-reader',actorType:'USER',authMode:'oidc' as const,roles:['quality-engineer'],correlationId:'quality-unit',scope:{provided:true,sites:['A'],lines:['L1'],devices:[]}};
const definition:QualityDefinition={deviceCode:'A',tagCode:'vibration_rms',name:'振动',unit:'mm/s',min:0,max:200,interval:60,policy:{gapMultiplier:1.5,staleMultiplier:3,futureSkewSeconds:300},policyOrigin:'FROZEN_EQUIPMENT_PROFILE',templateKey:'pump',templateVersion:'1.0.0',source:{batchId:'batch',sourceRow:2,snapshotDigest:'a'.repeat(64),recordVersion:2}};
const plan=(declared=true):QualityPoint=>({index:0,tenantId:'acme',edgeId:'edge-a',deviceCode:'A',deviceName:'质量泵',siteCode:'A',tagCode:'vibration_rms',nodeId:'ns=1;s=vibration',unit:'mm/s',mapVersion:'map-1',origin:'SIMULATOR',definition:declared?structuredClone(definition):null});
const evidence=(time=now-1000)=>({pointId:'ea12cd34-abcd-1234-1234-123456789abc',edgeId:'edge-a',deviceCode:'A',tagCode:'vibration_rms',eventTime:new Date(time).toISOString(),receivedAt:new Date(time+500).toISOString(),inputDigest:'b'.repeat(64),origin:'SIMULATOR',mapVersion:'map-1',nodeId:'ns=1;s=vibration',sequenceNo:'9007199254740992',value:2,unit:'mm/s',quality:'GOOD'});
const metrics=(patch:Partial<PointMetrics>={}):PointMetrics=>({...Object.fromEntries(metricKeys.map(k=>[k,0])),records:1,good:1,latest:evidence(),examples:{},rejections:[],...patch}) as PointMetrics;
const registry=()=>({tenantId:'acme',edgeId:'edge-a',deviceCode:'A',mapVersion:'map-1',origin:'SIMULATOR' as const,points:[{tagCode:'vibration_rms',unit:'mm/s',nodeId:'ns=1;s=vibration'}],signingKey:'PRIVATE_SIGNING',acknowledgementKey:'PRIVATE_ACK',statusKey:'PRIVATE_STATUS',statusUrl:'http://private.invalid/status'});
test('quality query enforces exact parameters, zones, actual dates, window and pagination without tenant overrides',()=>{
 assert.equal(query().from,now-3600000);assert.equal(telemetryQualityQuery(new URLSearchParams({edgeId:'edge-a',pageSize:'100'}),now).edge,'edge-a');
 for(const text of ['edgeId=A&edgeId=B','tenantId=sandbox','source=UPLOADS','limit=100','edgeId=','edgeId=a%27OR1','page=0','pageSize=101','status=HEALTHY','from=2026-02-30T00:00:00Z','to=2026-10-16T08:00:00'])assert.throws(()=>telemetryQualityQuery(new URLSearchParams(text),now),text);
 for(const q of [{from:new Date(now-32*86400000).toISOString()},{to:new Date(now+300001).toISOString()}])assert.throws(()=>telemetryQualityQuery(new URLSearchParams(q),now));
});
test('source registry whitelists public bindings and rejects ambiguous point maps',()=>{
 const raw=registry(),sources=qualitySources([raw,{...raw,tenantId:'sandbox'}],'acme');assert.equal(sources.length,1);assert.deepEqual(Object.keys(sources[0]).sort(),['deviceCode','edgeId','mapVersion','origin','points','tenantId']);assert.ok(!JSON.stringify(sources).includes('PRIVATE'));
 for(const change of [(s:any)=>s.points.push({...s.points[0]}),(s:any)=>s.points[0].tagCode='__proto__',(s:any)=>s.points[0].unit='',(s:any)=>s.edgeId='x y']){const broken=registry();change(broken);assert.throws(()=>qualitySources([broken],'acme'));}assert.throws(()=>qualitySources([raw,raw],'acme'));
});
test('source planning uses current approved device scope before legacy line fallback and filters hidden sources to empty',()=>{
 const s=qualitySources([registry()],'acme'),assets=new Map([['A',{device_code:'A',site_code:'A',line_code:'L1',device_name:'泵'}]]),old=new Map([['A',{line:'L2',name:'旧名'}]]),defs=new Map([[JSON.stringify(['A','vibration_rms']),definition]]);
 assert.equal(qualityPlans(s,ctx,query(),assets,old,defs).length,1);assert.equal(qualityPlans(s,{...ctx,scope:{provided:true,sites:['B'],lines:[],devices:[]}},query(),assets,old,defs).length,0);
 assert.equal(qualityPlans(s,{...ctx,roles:['maintenance-engineer'],scope:{provided:true,sites:[],lines:['L2'],devices:[]}},query(),new Map(),old,defs).length,1);
 assert.equal(qualityPlans(s,{...ctx,scope:{provided:false,sites:[],lines:[],devices:[]}},query(),assets,old,defs).length,0);
 assert.equal(qualityPlans(s,ctx,{...query(),edge:'missing'},assets,old,defs).length,0);assert.throws(()=>qualityPlans(s,{...ctx,roles:[]},query(),assets,old,defs));
});
test('unknown definition or cadence never becomes CLEAN and an empty window never implies healthy',()=>{
 const unknown=qualityItem(plan(false),metrics(),query(),now);assert.equal(unknown.status,'UNKNOWN');assert.equal(unknown.observedGapCount,null);assert.equal(unknown.estimatedMissingWithinGaps,null);assert.equal(unknown.expectedIntervalSeconds,null);
 const empty=qualityItem(plan(false),metrics({records:0,good:0,latest:null}),query(),now);assert.equal(empty.status,'ISSUE');assert.equal(empty.goodRate,null);assert.ok(empty.findings.some(f=>f.code==='NO_RECORDS_IN_WINDOW'));
 const p=plan();p.definition!.interval=null;assert.equal(qualityItem(p,metrics(),query(),now).status,'UNKNOWN');assert.equal(qualityItem(plan(),metrics(),query(),now).status,'CLEAN');
});
test('cadence and frozen multipliers preserve historical end time, strict stale boundary and meaningful gap estimates',()=>{
 const q=query();assert.ok(!qualityItem(plan(),metrics({latest:evidence(now-180000)}),q,now).findings.some(f=>f.code==='STALE_AT_WINDOW_END'));
 assert.ok(qualityItem(plan(),metrics({latest:evidence(now-180001)}),q,now).findings.some(f=>f.code==='STALE_AT_WINDOW_END'));
 const history={...q,to:now-86400000,from:now-90000000},recent=qualityItem(plan(),metrics({latest:evidence(history.to-1000)}),history,now);assert.equal(recent.ageAtWindowEndSeconds,1);assert.ok(!recent.findings.some(f=>f.code==='STALE_AT_WINDOW_END'));
 const p=plan();p.definition!.policy.staleMultiplier=10;assert.ok(!qualityItem(p,metrics({latest:evidence(now-300000),gapCount:2,estimatedMissing:9}),q,now).findings.some(f=>f.code==='STALE_AT_WINDOW_END'));assert.equal(qualityItem(p,metrics({gapCount:2,estimatedMissing:9}),q,now).estimatedMissingWithinGaps,9);
});
test('quality findings explain every persisted data and binding problem without issuing a health score',()=>{
 const p=plan(),m=metrics({records:10,good:8,bad:1,uncertain:1,nullValues:1,invalidValues:1,unitMappingMismatch:1,unitDefinitionMismatch:1,outOfRange:1,mappingMismatch:1,receiptMismatch:1,futureCount:1,gapCount:1,estimatedMissing:2,rejected:2});
 const item=qualityItem(p,m,query(),now);assert.equal(item.status,'ISSUE');for(const code of ['NON_GOOD_QUALITY','NULL_SAMPLE_VALUE','INVALID_SAMPLE_VALUE','POINT_MAP_UNIT_MISMATCH','UNIT_DEFINITION_MISMATCH','OUT_OF_DECLARED_RANGE','SOURCE_BINDING_MISMATCH','SOURCE_RECEIPT_MISMATCH','FUTURE_SAMPLE_TIME','OBSERVED_INTERVAL_GAPS','REJECTED_INGESTION'])assert.ok(item.findings.some(f=>f.code===code),code);assert.equal(item.goodRate,80);assert.equal('healthScore' in item,false);assert.equal(item.provenance,'SIMULATED_TELEMETRY');
});
test('summary covers all selected source points independently of status and page and refuses numeric overflow',()=>{
 const first=qualityItem(plan(),metrics(),query(),now),second=qualityItem({...plan(),index:1,tagCode:'bearing_temperature'},metrics({records:3,good:2,bad:1}),query(),now),q={...query(),status:'ISSUE',pageSize:1};
 const response=qualityResponse([first,second],q,now,true,qualityIntake([{edgeId:'edge-a',deviceCode:'A',origin:'SIMULATOR',count:0,unmapped:0,unmappedReceived:0,unmappedExamples:[],examples:[]}],1,1));assert.equal(response.total,1);assert.equal(response.summary.points,2);assert.equal(response.summary.receivedRecordsInWindow,4);assert.equal(response.items[0].tagCode,'bearing_temperature');assert.equal(response.fieldCommissioned,false);assert.equal(response.readOnly,true);
 assert.throws(()=>qualityResponse([{...first,records:Number.MAX_SAFE_INTEGER},{...second,records:1}],q,now,true,qualityIntake([{edgeId:'edge-a',deviceCode:'A',origin:'SIMULATOR',count:0,unmapped:0,unmappedReceived:0,unmappedExamples:[],examples:[]}],1,1)));
});
test('source evidence validates int64 identity and strips arbitrary private fields',()=>{
 const p=plan(),raw={...evidence(),signature:'PRIVATE',envelope:{secret:'PRIVATE'},statusUrl:'PRIVATE'},out=pointEvidence(raw,p);assert.equal(out.sequenceNo,'9007199254740992');assert.ok(!JSON.stringify(out).includes('PRIVATE'));
 for(const patch of [{deviceCode:'hidden'},{edgeId:'hidden'},{tagCode:'hidden'},{sequenceNo:'9223372036854775808'},{sequenceNo:'1.5'},{inputDigest:'wrong'},{eventTime:'2026-10-16'},{origin:'UNKNOWN'}])assert.throws(()=>pointEvidence({...raw,...patch},p));
});
test('SQL metrics reject contradictory totals, missing rows, unbounded evidence and cross-source substitution',()=>{
 const p=plan(),base={...metrics(),idx:0,examples:Object.fromEntries(['NON_GOOD_QUALITY','NULL_SAMPLE_VALUE','INVALID_SAMPLE_VALUE','POINT_MAP_UNIT_MISMATCH','UNIT_DEFINITION_MISMATCH','OUT_OF_DECLARED_RANGE','SOURCE_BINDING_MISMATCH','SOURCE_RECEIPT_MISMATCH','FUTURE_SAMPLE_TIME','OBSERVED_INTERVAL_GAPS'].map(k=>[k,[]]))};assert.equal(qualityMetrics(base,p,query()).records,1);
 for(const change of [(m:any)=>m.good=0,(m:any)=>m.records='-1',(m:any)=>m.nullValues=2,(m:any)=>m.latest=null,(m:any)=>m.examples.NON_GOOD_QUALITY=Array(6).fill(evidence()),(m:any)=>m.examples.NON_GOOD_QUALITY=[{...evidence(),edgeId:'hidden'}],(m:any)=>m.rejections=[{eventId:'x',receivedAt:new Date(now).toISOString(),inputDigest:'a'.repeat(64),reason:'bad'}]]){const changed=structuredClone(base);change(changed);assert.throws(()=>qualityMetrics(changed,p,query()));}
 for(const bad of [NaN,Infinity,-1,'01','1e3',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>qualityCount(bad));assert.equal(qualityPolicy(definition.policy).gapMultiplier,1.5);
});
test('quality panel clears old data on failure and source switch and ignores late identity or source responses',async()=>{
 const panel=new QualityPanel();let who='A',complete:(v:any)=>void=()=>{};panel.result={old:'private'};const pending=panel.load(()=>new Promise(ok=>complete=ok),()=>who);assert.equal(panel.result,null);panel.switchMode('TELEMETRY');complete({source:'APPROVED_EFFECTIVE_UPLOADS',items:['old']});await pending;assert.equal(panel.result,null);
 await panel.load(async path=>{assert.ok(path.startsWith('/telemetry/quality?'));return {source:'TELEMETRY',items:[]};},()=>who);assert.equal(panel.result.source,'TELEMETRY');
 await assert.rejects(panel.load(async()=>{throw Error('denied');},()=>who));assert.equal(panel.result,null);assert.equal(panel.error,'denied');const late=panel.load(()=>new Promise(ok=>complete=ok),()=>who);who='B';panel.clear(who);complete({source:'TELEMETRY',items:['A private']});await late;assert.equal(panel.result,null);assert.deepEqual(panel.filters,{});
 await assert.rejects(panel.load(async()=>({source:'APPROVED_EFFECTIVE_UPLOADS'}),()=>who));assert.equal(panel.result,null);
});
test('telemetry renderer escapes source, device and receipt text and keeps simulator and unknown labels',()=>{
 const p=plan(false);p.deviceName='<img src=x onerror=alert(1)>';p.nodeId='<script>alert(1)</script>';const item=qualityItem(p,metrics({rejected:1,rejections:[{eventId:'<img>',receivedAt:new Date(now).toISOString(),inputDigest:'b'.repeat(64),reason:'<script>bad</script>'}]}),query(),now),data=qualityResponse([item],query(),now,true,qualityIntake([{edgeId:p.edgeId,deviceCode:p.deviceCode,origin:p.origin,count:1,unmapped:0,unmappedReceived:0,unmappedExamples:[],examples:item.rejectionExamples}],1,1)),html=telemetryQualityView(data,{},false);
 assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('模拟采集（当前注册）'));assert.ok(html.includes('批准记录间隔 未知'));assert.ok(html.includes('查看拒收例证'));assert.ok(!html.includes('PRIVATE'));
});
test('both quality sources keep editable filters after failure while removing previous result cards',()=>{
 for(const mode of ['UPLOADS','TELEMETRY']){const html=dataQualityView(null,{deviceCode:'A',from:'invalid date'},false,mode,'服务暂不可用');assert.ok(html.includes('id="quality-filter"'));assert.ok(html.includes('value="invalid date"'));assert.ok(html.includes('服务暂不可用'));assert.ok(!html.includes('telemetry-quality-card'));assert.ok(html.includes('quality-source'));}
});
test('connection and SQL failures are safe 503 responses while capacity errors retain their public code and all reservations return',async()=>{
 const before=resident.snapshot().total,identity={...ctx,roles:['auditor']};
 for(const error of [Error('PRIVATE SQL CREDENTIAL DETAIL'),new CapacityError(503,'预算不足','MEMORY_BUDGET')]){const pool={connect:async()=>{throw error;}};await assert.rejects(telemetryQualitySqlRead(pool as any,identity,new URLSearchParams(),[],async()=>{}),e=>(e as any).status===503&&!String((e as any).message).includes('PRIVATE')&&(error instanceof CapacityError?(e as any).code==='MEMORY_BUDGET':true));assert.equal(resident.snapshot().total,before);assert.equal(sqlScheduler.snapshot().active,0);}
});
test('source rejection intake keeps complete unmapped totals beyond twenty sources and whitelists every example',()=>{
 const rows=Array.from({length:23},(_,i)=>({edgeId:'edge-'+i,deviceCode:'device-'+i,origin:'SIMULATOR' as const,count:2,unmapped:1,unmappedReceived:0,unmappedExamples:[],signingKey:'PRIVATE',examples:[{eventId:'event',receivedAt:new Date(now).toISOString(),inputDigest:'a'.repeat(64),reason:'SCHEMA_INVALID',envelope:{private:'PRIVATE'}}]})),intake=qualityIntake(rows,23,23);
 assert.equal(intake.total,46);assert.equal(intake.unmapped,23);assert.equal(intake.totalSources,23);assert.equal(intake.items.length,20);assert.equal(intake.hasMore,true);assert.ok(!JSON.stringify(intake).includes('PRIVATE'));assert.throws(()=>qualityIntake(rows,22,23));assert.throws(()=>qualityIntake([{...rows[0],unmapped:3}],1,1));
});
test('received legacy tags remain counted and traceable without inventing current point definitions',()=>{
 const legacy={...evidence(),tagCode:'retired_pressure',unit:'MPa',value:0.5,privateUrl:'PRIVATE'},intake=qualityIntake([{edgeId:'edge-a',deviceCode:'A',origin:'SIMULATOR',count:0,unmapped:0,unmappedReceived:1,examples:[],unmappedExamples:[legacy]}],1,1),response=qualityResponse([],query(),now,true,intake);
 assert.equal(response.summary.receivedRecordsInWindow,1);assert.equal(response.summary.registeredPointRecordsInWindow,0);assert.equal(response.items.length,0);assert.equal(response.rejections.items[0].unmappedExamples[0].tagCode,'retired_pressure');assert.ok(!JSON.stringify(response).includes('PRIVATE'));assert.ok(telemetryQualityView(response,{},false).includes('当前点表外历史记录 1 条'));
});
