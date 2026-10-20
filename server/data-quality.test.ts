import test from 'node:test';
import assert from 'node:assert/strict';
import {seedStore} from './store.ts';
import {emptyImports,createBatch,approveBatch,canonical,report,getBatch} from './imports.ts';
import {dataQuality} from './data-quality.ts';
import {dataScope} from './data-scope.ts';
import {predictiveOverview,approvePredictiveAlert} from './predictive.ts';
import {orderFor} from './maintenance.ts';
import {reviewAlarm} from './service.ts';
import {scopeClaimsFromPayload} from './access.ts';

const uploader={tenantId:'acme',actorId:'uploader',actorType:'USER',authMode:'oidc' as const,roles:['data-uploader'],correlationId:'qa'},approver={...uploader,actorId:'approver',roles:['final-approver']},reader={...uploader,actorId:'reader',roles:['quality-engineer'],scope:{provided:true,sites:['A'],lines:[],devices:[]}};
function fixture(){const data=emptyImports(),store=seedStore();return {data,store,create(type:string,rows:any[],extra={}){return createBatch(data,store,{dataType:type,rows,sourceSystem:'qa',templateVersion:'1.0.0',original:Buffer.from(JSON.stringify(rows)),filename:'qa.json',mime:'application/json',sourceKind:'API_JSON',...extra},uploader);},approve(b:any){return approveBatch(data,store,b.batchId,{decision:'APPROVED',comment:'独立核验',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},approver);}};}
const assets=['D-001','D-002','D-003'].map((device_code,i)=>({source_record_id:'asset-'+i,device_code,device_name:'设备'+i,site_code:i===1?'B':'A',line_code:i===1?'L2':'L1'}));
test('administrator-managed scope arrays and comma-separated claims normalize identically',()=>{
 assert.deepEqual(scopeClaimsFromPayload({idms_sites:[' * ','*',7],idms_lines:[' LINE-01 ']}),scopeClaimsFromPayload({idms_sites:' * ',idms_lines:'LINE-01'}));
 assert.equal(scopeClaimsFromPayload({idms_sites:['invalid scope','',null]}).provided,false);
});
test('quality rules explain non-GOOD data, observed gaps, stale records and unknown cadence without health claims',()=>{
 const f=fixture(),now=Date.now()-1000;f.approve(f.create('DEVICE',assets));f.approve(f.create('POINT_DEFINITION',assets.map((a,i)=>({source_record_id:'point-'+i,device_code:a.device_code,tag_code:'pressure',tag_name:'压力',unit:'MPa',min_value:0,max_value:10,...(i===1?{}:{expected_interval_seconds:60})}))));
 const reading=(device:string,minutes:number,quality='GOOD')=>({source_record_id:device+'-'+minutes,device_code:device,tag_code:'pressure',measured_at:new Date(now-minutes*60000).toISOString(),value:2,unit:'MPa',quality});
 f.approve(f.create('MEASUREMENT',[reading('D-001',20),reading('D-001',19,'BAD'),reading('D-001',15),reading('D-002',1),reading('D-003',2),reading('D-003',1),reading('D-003',0)]));
 f.create('MEASUREMENT',[{...reading('D-001',10),value:9}]);const failed=f.create('MEASUREMENT',[{...reading('D-001',5),value:11}]);assert.equal(failed.status,'VALIDATION_FAILED');
 const q=new URLSearchParams({from:new Date(now-20*60000).toISOString(),to:new Date(now).toISOString()}),before=canonical({data:f.data,store:f.store}),result=dataQuality(f.data,approver,q,now),pump=result.items.find(i=>i.deviceCode==='D-001')!;
 assert.equal(result.summary.approvedRecordsInWindow,7);assert.equal(pump.status,'ISSUE');assert.equal(pump.observedGapCount,1);assert.equal(pump.estimatedMissingWithinGaps,3);assert.equal(pump.bad,1);assert.ok(pump.findings.some(f=>f.code==='STALE_AT_WINDOW_END'));assert.equal(result.items.find(i=>i.deviceCode==='D-002')!.status,'UNKNOWN');assert.equal(result.items.find(i=>i.deviceCode==='D-003')!.status,'CLEAN');assert.equal(result.intake.items[0].batchId,failed.batchId);assert.equal(canonical({data:f.data,store:f.store}),before);
 const scoped=dataQuality(f.data,reader,q,now);assert.equal(scoped.summary.devices,2);assert.ok(scoped.items.every(i=>i.siteCode==='A'));
 const original=f.data.batches.find(b=>b.dataType==='MEASUREMENT'&&b.status==='COMMITTED')!,bad=original.rows.find(r=>r.quality==='BAD')!;f.approve(f.create('MEASUREMENT',[{...bad,quality:'GOOD'}],{supersedesBatchId:original.batchId,correctionReason:'原始凭证核查'}));assert.equal(dataQuality(f.data,reader,q,now).summary.nonGoodRecordsInWindow,0);
});
test('quality query rejects excessive windows, spoofed tenants and ambiguous filters; no data never means healthy',()=>{
 const f=fixture(),now=Date.now();f.approve(f.create('DEVICE',[assets[0]]));assert.equal(dataQuality(f.data,reader,new URLSearchParams(),now).items[0].status,'ISSUE');
 for(const query of ['tenant_id=sandbox','page=0','pageSize=101','status=HEALTHY','deviceCode=X&deviceCode=Y','from=2026-02-30T00%3A00%3A00Z'])assert.throws(()=>dataQuality(f.data,reader,new URLSearchParams(query),now));
 assert.throws(()=>dataQuality(f.data,reader,new URLSearchParams({from:new Date(now-32*86400000).toISOString(),to:new Date(now).toISOString()}),now));assert.equal(dataQuality(f.data,{...reader,tenantId:'sandbox'}).total,0);
});
test('scoped reports filter individual approved facts while mixed original files and audit evidence are hidden',()=>{
 const f=fixture(),batch=f.create('DEVICE',assets.slice(0,2));f.approve(batch);
 const production=(code:string,n:number)=>({source_record_id:code,device_code:code,shift_code:'DAY',period_start:'2026-10-13T00:00:00Z',period_end:'2026-10-13T08:00:00Z',planned_minutes:480,total_count:n,good_count:n-1,ideal_cycle_seconds:20});f.approve(f.create('PRODUCTION',[production('D-001',100),production('D-002',200)]));
 assert.equal(report(f.data,'acme',reader).total,100);assert.equal(report(f.data,'acme',reader).committedRows,2);assert.throws(()=>getBatch(f.data,batch.batchId,reader),/授权/);const view=dataScope(f.data,reader,f.store);assert.ok(!f.store.audits.filter(view.audit).some(a=>a.objectId===batch.batchId));
 assert.equal(predictiveOverview(f.store,'acme',reader,f.data).health.some(h=>h.deviceCode==='D-002'),false);assert.equal(predictiveOverview(f.store,'acme',reader,f.data).health.some(h=>h.deviceCode==='D-001'),true);
 assert.throws(()=>approvePredictiveAlert(f.store,'palert-001','APPROVED','核验通过',reader,f.data));assert.throws(()=>reviewAlarm(f.store,'alm-2408',reader,f.data),/授权/);
});
test('work-order details and mutations use the resolved factory; operators only see their assigned tasks',()=>{
 const f=fixture();f.approve(f.create('DEVICE',assets.slice(0,2)));approvePredictiveAlert(f.store,'palert-001','APPROVED','核验通过',approver,f.data);const order=f.store.workOrders[0];assert.throws(()=>orderFor(f.store,order.id,reader,f.data),/授权/);
 const factoryB={...approver,scope:{provided:true,sites:['B'],lines:[],devices:[]}};assert.equal(orderFor(f.store,order.id,factoryB,f.data).id,order.id);
 const operator={...uploader,actorId:'operator',roles:['operator'],scope:{provided:true,sites:['B'],lines:[],devices:[]}};assert.equal(dataScope(f.data,operator,f.store).order(order),false);order.assignee='operator';assert.equal(orderFor(f.store,order.id,operator,f.data).id,order.id);
});

test('out-of-scope uploads do not disclose another factory point units in validation errors',()=>{
 const f=fixture();f.approve(f.create('DEVICE',assets.slice(0,2)));f.approve(f.create('POINT_DEFINITION',[{source_record_id:'foreign-def',device_code:'D-002',tag_code:'pressure',tag_name:'专用压力',unit:'SECRET-UNIT',min_value:0,max_value:10}]));
 const b=createBatch(f.data,f.store,{dataType:'MEASUREMENT',rows:[{source_record_id:'probe',device_code:'D-002',tag_code:'pressure',measured_at:'2026-10-13T00:00:00Z',value:2,unit:'guess',quality:'GOOD'}],sourceSystem:'qa',templateVersion:'1.0.0',original:Buffer.from('probe'),filename:'probe.json',mime:'application/json',sourceKind:'API_JSON'},{...reader,roles:['data-uploader']});
 assert.equal(b.status,'VALIDATION_FAILED');assert.deepEqual(b.errors.map(e=>e.code),['OUT_OF_SCOPE']);assert.ok(!JSON.stringify(b.errors).includes('SECRET-UNIT'));
});
