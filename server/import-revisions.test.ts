import {correctionReviewCsv} from './correction-review.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {seedStore} from './store.ts';
import {emptyImports,createBatch,approveBatch,canonical,report} from './imports.ts';
import {effectiveRecords,recordHistory} from './import-revisions.ts';
import {verifyBatchMapping} from './catalog.ts';
import {dataMeasurements} from './data-management.ts';

const upload={tenantId:'acme',actorId:'upload',actorType:'USER',authMode:'oidc' as const,roles:['data-uploader'],correlationId:'qa'},approve={...upload,actorId:'reviewer',roles:['final-approver']};
function fixture(){const data=emptyImports(),store=seedStore();return {data,store,create(type:string,rows:any[],extra={}){return createBatch(data,store,{dataType:type,rows,sourceSystem:'qa',templateVersion:'1.0.0',original:Buffer.from(JSON.stringify(rows)),filename:'qa.json',mime:'application/json',sourceKind:'API_JSON',...extra},upload);},approve(b:any,ctx=approve){return approveBatch(data,store,b.batchId,{decision:'APPROVED',comment:'独立核验',reviewResolution:'确认来源',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},ctx);}};}
const asset={source_record_id:'asset',device_code:'PUMP',device_name:'泵',site_code:'A',line_code:'L'};
const definition={source_record_id:'def',device_code:'PUMP',tag_code:'pressure',tag_name:'压力',unit:'MPa',min_value:0,max_value:10};
const reading={source_record_id:'reading',device_code:'PUMP',tag_code:'pressure',measured_at:'2026-10-13T00:00:00Z',value:2,unit:'MPa',quality:'GOOD'};
function seeded(){const f=fixture();f.approve(f.create('DEVICE',[asset]));f.approve(f.create('POINT_DEFINITION',[definition]));const original=f.create('MEASUREMENT',[reading]);f.approve(original);return {...f,original,correct(value=3,parent=original){return f.create('MEASUREMENT',[{...reading,value}],{supersedesBatchId:parent.batchId,correctionReason:'传感器录入值复核'});}};}
test('independently approved corrections preserve history and only replace the effective record',()=>{
 const f=seeded(),before=canonical(f.data.records),b=f.correct();assert.equal(b.status,'AWAITING_APPROVAL');assert.equal(dataMeasurements(f.data,approve).items[0].measurement.value,2);
 assert.throws(()=>f.approve(b,{...upload,roles:['data-uploader','final-approver']}),/上传者/);f.approve(b);assert.equal(canonical(f.data.records),before);assert.equal(dataMeasurements(f.data,approve).items[0].measurement.value,3);assert.equal(dataMeasurements(f.data,approve).items[0].source.recordVersion,2);
 const second=f.correct(4,b);f.approve(second);const history=recordHistory(f.data,approve,new URLSearchParams({dataType:'MEASUREMENT',sourceSystem:'qa',sourceRecordId:'reading'}));assert.deepEqual(history.items.map(i=>i.record.value.value),[2,3,4]);assert.deepEqual(history.items.map(i=>i.effective),[false,false,true]);assert.equal(report(f.data,'acme').committedRows,3);assert.equal(effectiveRecords(f.data).length,3);
});
test('concurrent corrections conflict without modifying approval or partial records',()=>{
 const f=seeded(),a=f.correct(3),b=f.correct(4);f.approve(a);const before=canonical({data:f.data,store:f.store});assert.throws(()=>f.approve(b),/有效|变化/);assert.equal(canonical({data:f.data,store:f.store}),before);
 assert.throws(()=>f.correct(6),/有效/);
});
test('corrections reject new IDs, wrong identity, no-ops, dependencies and out of scope parents',()=>{
 const f=seeded(),extra={supersedesBatchId:f.original.batchId,correctionReason:'核验修正'};
 for(const patch of [{source_record_id:'new'},{device_code:'OTHER'},{value:2}])assert.throws(()=>f.create('MEASUREMENT',[{...reading,...patch}],extra));
 assert.throws(()=>f.create('MEASUREMENT',[{...reading,value:3},{...reading,value:4}],extra),/重复/);
 const p=f.data.batches.find(b=>b.dataType==='POINT_DEFINITION')!;assert.throws(()=>f.create('POINT_DEFINITION',[{...definition,max_value:1}],{supersedesBatchId:p.batchId,correctionReason:'收窄范围'}),/现有测点/);
 const denied={...upload,scope:{provided:true,sites:['OTHER'],lines:[],devices:[]}};assert.throws(()=>createBatch(f.data,f.store,{dataType:'MEASUREMENT',rows:[{...reading,value:4}],sourceSystem:'qa',templateVersion:'1.0.0',original:Buffer.from('x'),filename:'x.json',mime:'application/json',sourceKind:'API_JSON',...extra},denied),/授权/);
 assert.throws(()=>recordHistory(f.data,{...approve,scope:{provided:true,sites:['OTHER'],lines:[],devices:[]}},new URLSearchParams({dataType:'MEASUREMENT',sourceSystem:'qa',sourceRecordId:'reading'})),/不存在/);
});
test('frozen correction binding and input cannot be changed or deleted even before commit',()=>{
 for(const change of [(b:any)=>b.correction.reason='伪造理由',(b:any)=>delete b.correction,(b:any)=>b.rows[0].value=9,(b:any)=>b.lineNumbers[0]=99]){const f=seeded(),b=f.correct();change(b);assert.throws(()=>verifyBatchMapping(f.store,b),/更正/);assert.throws(()=>f.approve(b),/更正/);}
});
test('production corrections recompute aggregates without double counting',()=>{
 const f=fixture();f.approve(f.create('DEVICE',[asset]));const prod={source_record_id:'prod',device_code:'PUMP',shift_code:'DAY',period_start:'2026-10-13T00:00:00Z',period_end:'2026-10-13T08:00:00Z',planned_minutes:480,total_count:1000,good_count:980,ideal_cycle_seconds:20};const b=f.create('PRODUCTION',[prod]);f.approve(b);f.approve(f.create('PRODUCTION',[{...prod,good_count:950}],{supersedesBatchId:b.batchId,correctionReason:'复核良品数量'}));assert.equal(report(f.data,'acme').total,1000);assert.equal(report(f.data,'acme').good,950);
});

test('all seven types support correction, preserving their original facts and effective dependencies',()=>{
 const f=seeded();
 const cases:[string,any,any][]=[
 ['DEVICE',asset,{device_name:'循环水泵',equipment_type:'泵组'}],
 ['POINT_DEFINITION',definition,{tag_name:'出口压力'}],
 ['MEASUREMENT',reading,{quality:'BAD'}],
 ['STATE_INTERVAL',{source_record_id:'state',device_code:'PUMP',start_time:'2026-10-13T00:00:00Z',end_time:'2026-10-13T08:00:00Z',state:'RUNNING',reason_code:''},{state:'DOWN',reason_code:'FAILURE'}],
 ['MAINTENANCE',{source_record_id:'repair',device_code:'PUMP',failure_time:'2026-10-13T00:00:00Z',repair_start:'2026-10-13T00:00:00Z',repair_end:'2026-10-13T01:00:00Z',failure_code:'BEARING',cause:'磨损',action:'更换'},{repair_end:'2026-10-13T01:30:00Z'}],
 ['QUALITY',{source_record_id:'quality',device_code:'PUMP',batch_code:'B',characteristic_code:'X',measured_at:'2026-10-13T00:00:00Z',sample_no:1,measured_value:1,unit:'mm',lsl:0,usl:10},{measured_value:2}]
 ];
 for(const [type,row,patch] of cases){let parent=f.data.batches.find(b=>b.dataType===type&&b.status==='COMMITTED');if(!parent){parent=f.create(type,[row]);f.approve(parent);}const before=canonical(f.data.records);const b=f.create(type,[{...row,...patch}],{supersedesBatchId:parent!.batchId,correctionReason:'核查后修改'});assert.equal(b.status,'AWAITING_APPROVAL');f.approve(b);assert.equal(canonical(f.data.records),before);assert.equal(effectiveRecords(f.data).find(r=>r.dataType===type)!.value[Object.keys(patch)[0]],Object.values(patch)[0]);}
 assert.equal(report(f.data,'acme').downMinutes,480);assert.equal(report(f.data,'acme').mttr,90);
});

test('a new dependent record arriving before definition approval invalidates the entire correction',()=>{
 const f=seeded(),original=f.data.batches.find(b=>b.dataType==='POINT_DEFINITION')!;
 const b=f.create('POINT_DEFINITION',[{...definition,max_value:3}],{supersedesBatchId:original.batchId,correctionReason:'修订范围'});
 f.approve(f.create('MEASUREMENT',[{...reading,source_record_id:'later',measured_at:'2026-10-13T01:00:00Z',value:4}]));
 const before=canonical({data:f.data,store:f.store});assert.throws(()=>f.approve(b),/现有测点/);assert.equal(canonical({data:f.data,store:f.store}),before);
});

test('returned or rejected corrections never replace the approved effective record',()=>{
 for(const decision of ['RETURNED','REJECTED']){const f=seeded(),b=f.correct();approveBatch(f.data,f.store,b.batchId,{decision,comment:'需重新核验',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},approve);assert.equal(dataMeasurements(f.data,approve).items[0].measurement.value,2);assert.equal(recordHistory(f.data,approve,new URLSearchParams({dataType:'MEASUREMENT',sourceSystem:'qa',sourceRecordId:'reading'})).total,1);}
});

test('full correction review CSV contains every changed row beyond the preview window',()=>{
 const f=fixture();f.approve(f.create('DEVICE',[asset]));f.approve(f.create('POINT_DEFINITION',[definition]));
 const rows=Array.from({length:25},(_,i)=>({...reading,source_record_id:'r-'+i,measured_at:new Date(Date.parse(reading.measured_at)+i*60000).toISOString()}));const original=f.create('MEASUREMENT',rows);f.approve(original);
 const b=f.create('MEASUREMENT',rows.map(r=>({...r,value:3})),{supersedesBatchId:original.batchId,correctionReason:'逐行复核'});const csv=correctionReviewCsv(f.data,b,approve);assert.equal(csv.split('\r\n').length,27);assert.ok(csv.includes('"r-24"'));assert.ok(csv.includes(b.snapshotDigest));
});
