import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {telemetryQualityFixture} from '../scripts/fixtures/telemetry-quality-model.mjs';
import {historicalImports} from './asof-imports.ts';
import {publicRegistry} from './registry-history.ts';
import {operationCalendarSchema} from './calendar-schema.ts';
import {computeFrozenCoverageV1,freezeCoveragePayload,verifyCoveragePayload,validateFrozenCoverageInput,type FrozenCoverageInput} from './frozen-coverage-v1.ts';
import {canonical,digest} from './imports.ts';
function fixture(source:'UPLOADS'|'TELEMETRY'='UPLOADS'){
 const f=telemetryQualityFixture({count:20}),from=f.now-600000,to=f.now,iso=(n:number)=>new Date(n).toISOString();
 f.approve('MEASUREMENT',[0,1,61,299,300,599].map((s,i)=>({source_record_id:'frozen-'+i,device_code:'QUALITY-A',tag_code:'vibration_rms',measured_at:iso(from+s*1000),value:2,unit:'mm/s',quality:i===0?'BAD':'GOOD'})));
 const knownAt=Date.now()+1000,calendar=operationCalendarSchema({deviceCode:'QUALITY-A',timeZone:'UTC',from:iso(from),to:iso(to),periods:[{from:iso(from),to:iso(from+300000),state:'RUN',reason:'运行'},{from:iso(from+300000),to:iso(to),state:'STOP',reason:'停产'}]}),provenance={templateId:'calendar-1',templateKey:'calendar-a',version:'1.0.0',contentDigest:'a'.repeat(64),publishedAt:iso(from-1000),governanceEventId:'calendar-approved'};
 const imports=historicalImports(f.imports,f.store.audits,'acme',knownAt).filter(x=>x.record.value.device_code==='QUALITY-A'&&(source==='UPLOADS'||x.record.dataType!=='MEASUREMENT'));
 const telemetry=f.points.filter(p=>p.tenant_id==='acme'&&p.device_code==='QUALITY-A').map(p=>({pointId:p.id,edgeId:p.edge_id,deviceCode:p.device_code,tagCode:p.tag_code,eventTime:p.event_time,receivedAt:p.received_at,inputDigest:p.input_digest,origin:p.origin,mapVersion:p.map_version,nodeId:p.node_id,sequenceNo:String(p.sequence_no),value:p.value,unit:p.unit,quality:p.quality,receiptValid:true}));
 const input:FrozenCoverageInput={format:'idms-coverage-input-v1',tenantId:'acme',deviceCode:'QUALITY-A',source,query:{from:iso(from),to:iso(to),knownAt:iso(knownAt),tagCode:null,edgeId:null},imports,telemetry:source==='TELEMETRY'?telemetry:[],registry:source==='TELEMETRY'?{revision:'1',observedAt:iso(from-1000),configurationHash:'b'.repeat(64),eventHash:'c'.repeat(64),sources:publicRegistry(f.sources,'acme').sources.filter(s=>s.deviceCode==='QUALITY-A')}:null,calendarContext:{schedule:{templateId:'schedule-1',templateKey:'schedule-a',version:'1.0.0',contentDigest:'d'.repeat(64),recordedAt:iso(from),governanceEventId:'schedule-approved',changeIntent:'INITIAL',changeReason:'明确运行安排'},calendars:[{calendar,source:provenance}],segments:[{index:0,from:iso(from),to:iso(from+300000),entryId:'initial',reason:'生效安排',missing:null,calendarId:provenance.templateId},{index:1,from:iso(from+300000),to:iso(to),entryId:'initial',reason:'生效安排',missing:null,calendarId:provenance.templateId}]}};
 return {f,input};
}
test('frozen upload calculator independently reproduces slots, duplicates, stop and bad quality',()=>{
 const {input}=fixture(),r=computeFrozenCoverageV1(input),run=r.items.find(i=>i.tagCode==='vibration_rms'&&i.segmentIndex===0)!,stop=r.items.find(i=>i.tagCode==='vibration_rms'&&i.segmentIndex===1)!;
 assert.equal(run.expectedSlots,300);assert.equal(run.receivedSlots,4);assert.equal(run.goodValidSlots,3);assert.equal(run.recordsInWindow,4);assert.equal(stop.expectedSlots,0);assert.equal(stop.status,'NOT_APPLICABLE');assert.equal(stop.recordsInWindow,2);assert.equal(stop.receivedCoveragePercent,null);assert.equal(r.definitionMode,'AS_OF_APPROVED');assert.equal(r.dataMode,'AS_OF_COMMITTED');assert.equal(r.replayScope,'FROZEN_ALL_INPUTS');
});
test('frozen telemetry uses historical map, exact receipt binding and current independent point units',()=>{
 const {input}=fixture('TELEMETRY'),r=computeFrozenCoverageV1(input),temperature=r.items.find(i=>i.tagCode==='bearing_temperature'&&i.segmentIndex===0)!;assert.equal(temperature.expectedSlots,5);assert.equal(temperature.receivedSlots,1);assert.equal(temperature.goodValidSlots,1);assert.equal(r.items.find(i=>i.tagCode==='vibration_rms'&&i.segmentIndex===1)!.recordsInWindow,20);
 for(const mutate of [(x:any)=>x.registry.sources[0].mapVersion='map-2',(x:any)=>x.telemetry.find((t:any)=>t.tagCode==='bearing_temperature').receiptValid=false,(x:any)=>x.registry.sources[0].points.find((p:any)=>p.tagCode==='bearing_temperature').unit='K']){const x=structuredClone(input);mutate(x);assert.equal(computeFrozenCoverageV1(x).items.find(i=>i.tagCode==='bearing_temperature'&&i.segmentIndex===0)!.goodValidSlots,0);}
});
test('frozen payload is detached and recursively immutable and later database changes cannot alter it',()=>{
 const {input,f}=fixture(),payload=freezeCoveragePayload(input),saved=JSON.stringify(payload);input.imports.find(r=>r.record.dataType==='MEASUREMENT')!.record.value.quality='GOOD';f.sources[0].mapVersion='changed';assert.equal(JSON.stringify(payload),saved);assert.throws(()=>payload.input.imports.push(input.imports[0]));assert.deepEqual(verifyCoveragePayload(JSON.parse(saved)),payload);
 const forged=JSON.parse(saved);forged.result.items[0].expectedSlots++;forged.resultDigest=digest(canonical(forged.result));assert.throws(()=>verifyCoveragePayload(forged));
 const wrong=JSON.parse(saved);wrong.input.imports.find((r:any)=>r.record.dataType==='POINT_DEFINITION').record.value.expected_interval_seconds=999;assert.throws(()=>verifyCoveragePayload(wrong));
});
test('unknown calendar, unassigned plan and missing historical asset never create a complete rate',()=>{
 const {input}=fixture();input.calendarContext.schedule=null;input.calendarContext.calendars=[];input.calendarContext.segments=[{index:0,from:input.query.from,to:input.query.to,entryId:null,reason:'未声明',missing:'SCHEDULE_UNDECLARED',calendarId:null}];const r=computeFrozenCoverageV1(input);assert.ok(r.items.every(i=>i.status==='UNKNOWN'&&i.receivedCoveragePercent===null));assert.equal(r.items.find(i=>i.tagCode==='vibration_rms')!.recordsInWindow,6);
 const x=fixture().input;x.imports=x.imports.filter(i=>i.record.dataType!=='DEVICE');const noAsset=computeFrozenCoverageV1(x);assert.ok(noAsset.conditions.includes('HISTORICAL_ASSET_UNDECLARED'));assert.ok(noAsset.items.every(i=>i.receivedCoveragePercent===null));
});
test('frozen input rejects late arrivals, wrong identity, duplicate source records, mutable credentials and malformed segments',()=>{
 for(const mutate of [(x:any)=>x.imports[0].record.tenantId='sandbox',(x:any)=>x.imports.push(x.imports[0]),(x:any)=>x.query.knownAt='2026-02-30T00:00:00Z',(x:any)=>x.calendarContext.segments[0].to=x.query.from,(x:any)=>x.calendarContext.segments[1].from=x.query.from,(x:any)=>x.calendarContext.calendars[0].calendar.periods[0].to=x.query.to,(x:any)=>x.calendarContext.schedule.changeIntent=['INITIAL']]){const x=fixture().input;mutate(x);assert.throws(()=>validateFrozenCoverageInput(x));}
 for(const mutate of [(x:any)=>x.registry.sources[0].signingKey='SECRET',(x:any)=>x.telemetry[0].receivedAt='2999-01-01T00:00:00Z',(x:any)=>x.telemetry[0].value=Infinity,(x:any)=>x.telemetry[0].quality=['GOOD'],(x:any)=>x.telemetry[0].deviceCode='OTHER',(x:any)=>x.telemetry.push(x.telemetry[0]),(x:any)=>x.registry=null]){const x=fixture('TELEMETRY').input;mutate(x);assert.throws(()=>validateFrozenCoverageInput(x));}
});
test('unmapped telemetry remains explicit and serialized nonfinite values cannot fill valid slots',()=>{
 const {input}=fixture('TELEMETRY');input.telemetry[0].tagCode='historical-unmapped';input.telemetry.find(r=>r.tagCode==='bearing_temperature')!.value='NaN';const r=computeFrozenCoverageV1(input);assert.equal(r.unmappedReceivedRecords,1);assert.equal(r.items.find(i=>i.tagCode==='bearing_temperature'&&i.segmentIndex===0)!.goodValidSlots,0);assert.ok(!canonical(freezeCoveragePayload(input)).includes('signingKey'));
});
test('version-one golden payload from actual minimum-role PostgreSQL retains exact frozen inputs and results',()=>{
 const golden=JSON.parse(readFileSync(new URL('../scripts/fixtures/frozen-coverage-v1-golden.json',import.meta.url),'utf8'));assert.deepEqual(verifyCoveragePayload(golden),golden);assert.deepEqual(computeFrozenCoverageV1(golden.input),golden.result);assert.equal(golden.result.items.find((i:any)=>i.tagCode==='vibration_rms').expectedSlots,120);
});
