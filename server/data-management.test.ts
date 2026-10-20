import test from 'node:test';
import assert from 'node:assert/strict';
import {seedStore} from './store.ts';
import {createBatch,approveBatch,emptyImports,canonical} from './imports.ts';
import {dataOverview,dataMeasurements,overviewQuery,measurementQuery} from './data-management.ts';
import {scopeAllows} from './access.ts';
import {assetCsv,measurementCsv,exportFilters} from './data-export.ts';

const uploader={tenantId:'acme',actorId:'human-uploader',actorType:'USER',authMode:'oidc' as const,roles:['data-uploader'],correlationId:'test'},approver={...uploader,actorId:'human-approver',roles:['final-approver']},auditor={...uploader,actorId:'human-auditor',roles:['auditor']};
function fixture(){const data=emptyImports(),store=seedStore();return {data,store,create(type:string,rows:any[],ctx=uploader){return createBatch(data,store,{dataType:type,rows,original:Buffer.from(JSON.stringify(rows)),filename:'test.json',mime:'application/json',templateVersion:'1.0.0',sourceSystem:'multi-device-qa',sourceKind:'API_JSON'},ctx);},approve(batch:any,ctx=approver){return approveBatch(data,store,batch.batchId,{decision:'APPROVED',comment:'独立核查数据',snapshotDigest:batch.snapshotDigest,expectedVersion:batch.version},ctx);}};}
const assets=[{source_record_id:'pump-1',device_code:'PUMP-01',device_name:'循环泵',site_code:'FACTORY-02',line_code:'UTILITY-01',equipment_type:'泵组',brand:'示例品牌',model:'P-100',criticality:'HIGH'},{source_record_id:'comp-1',device_code:'COMP-01',device_name:'空压机',site_code:'FACTORY-03',line_code:'UTILITY-02',equipment_type:'空压机'}];
const definitions=[{source_record_id:'pump-pressure',device_code:'PUMP-01',tag_code:'pressure',tag_name:'出口压力',unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:3600},{source_record_id:'comp-pressure',device_code:'COMP-01',tag_code:'pressure',tag_name:'排气压力',unit:'bar',min_value:0,max_value:16}];
const measurement=(device='PUMP-01',unit='MPa')=>({source_record_id:'reading-'+device,device_code:device,tag_code:'pressure',measured_at:'2026-10-14T08:00:00+08:00',value:1.2,unit,quality:'GOOD'});
test('multiple equipment families and sites use declared device-specific points with independent approval',()=>{
  const f=fixture();const asset=f.create('DEVICE',assets);assert.equal(asset.status,'AWAITING_APPROVAL');
  assert.equal(f.create('POINT_DEFINITION',definitions).status,'VALIDATION_FAILED');f.approve(asset);
  const points=f.create('POINT_DEFINITION',definitions);assert.equal(points.status,'AWAITING_APPROVAL');
  assert.equal(f.create('MEASUREMENT',[measurement()]).status,'VALIDATION_FAILED');f.approve(points);
  const data=f.create('MEASUREMENT',[measurement(),measurement('COMP-01','bar')]);assert.equal(data.status,'AWAITING_APPROVAL');assert.throws(()=>f.approve(data,{...uploader,roles:['data-uploader','final-approver']}),/上传者/);f.approve(data);
  const overview=dataOverview(f.data,auditor);assert.equal(overview.summary.devices,2);assert.equal(overview.summary.definedPoints,2);assert.deepEqual(overview.equipmentTypes,['泵组','空压机'].sort());
  const result=dataMeasurements(f.data,auditor,new URLSearchParams({deviceCode:'PUMP-01'}));assert.equal(result.total,1);assert.equal(result.items[0].definition?.unit,'MPa');assert.equal(result.items[0].definition?.definitionBatchId,points.batchId);assert.equal(result.items[0].source.batchId,data.batchId);assert.equal(result.items[0].source.sourceRow,2);
  assert.ok(f.create('MEASUREMENT',[{...measurement(),source_record_id:'bad-unit',unit:'bar'}]).errors.some(e=>e.code==='UNIT_MISMATCH'));
});
test('unapproved or foreign point definitions cannot authorize measurements and conflicts recheck before approval',()=>{
  const f=fixture();f.approve(f.create('DEVICE',assets));
  const original=f.create('POINT_DEFINITION',[definitions[0]]),racing=f.create('POINT_DEFINITION',[{...definitions[0],source_record_id:'other-definition'}]);f.approve(original);
  assert.throws(()=>f.approve(racing),/并发冲突/);assert.equal(racing.status,'AWAITING_APPROVAL');
  const before=canonical(f.data);assert.equal(dataMeasurements(f.data,{...auditor,tenantId:'sandbox'}).total,0);assert.equal(dataOverview(f.data,{...auditor,tenantId:'sandbox'}).summary.devices,0);assert.equal(canonical(f.data),before);
  assert.equal(f.create('MEASUREMENT',[measurement('COMP-01','bar')]).status,'VALIDATION_FAILED');
});
test('metadata rejects invalid ranges, reserved codes and changed engineering sample semantics',()=>{
  const f=fixture();f.approve(f.create('DEVICE',assets));
  for(const patch of [{min_value:20},{tag_code:'constructor'},{tag_code:'vibration_rms'},{expected_interval_seconds:0},{unit:'x'.repeat(33)}])assert.equal(f.create('POINT_DEFINITION',[{...definitions[0],...patch}]).status,'VALIDATION_FAILED');
  assert.equal(f.create('DEVICE',[{...assets[0],source_record_id:'other',device_code:'OTHER',criticality:'invented'}]).status,'VALIDATION_FAILED');
});
test('legacy asset uploads remain compatible; filtering is bounded and quality is not a health claim',()=>{
  const f=fixture();const legacy={source_record_id:'old',device_code:'LEGACY',device_name:'旧设备',site_code:'FACTORY-01',line_code:'LINE-01'};f.approve(f.create('DEVICE',[legacy]));
  f.approve(f.create('MEASUREMENT',[{...measurement('LEGACY','mm/s'),tag_code:'vibration_rms',quality:'BAD'}]));
  const before=canonical(f.data);assert.equal(dataOverview(f.data,auditor,new URLSearchParams({q:'旧设备'})).total,1);assert.equal(dataMeasurements(f.data,auditor,new URLSearchParams({quality:'BAD'})).items[0].measurement.quality,'BAD');
  for(const query of [{pageSize:'101'},{page:'0'},{tenant_id:'sandbox'},{from:'2026-10-14'}])assert.throws(()=>dataMeasurements(f.data,auditor,new URLSearchParams(query)));
  assert.equal(canonical(f.data),before);
});

test('data queries reject impossible dates, ambiguous filters and excessive pagination',()=>{
  for(const from of ['2026-02-30T00:00:00Z','2026-10-15T24:00:00Z','2026-10-15T01:00Z','2026-10-15T01:00:00','invalid'])assert.throws(()=>measurementQuery(new URLSearchParams({from})));
  assert.throws(()=>measurementQuery(new URLSearchParams({from:'2026-10-16T00:00:00Z',to:'2026-10-15T00:00:00Z'})));
  assert.throws(()=>overviewQuery(new URLSearchParams('q=one&q=two')));
  assert.throws(()=>overviewQuery(new URLSearchParams({siteCode:'x'.repeat(129)})));
  assert.equal(measurementQuery(new URLSearchParams({from:'2026-10-15T08:00:00+08:00'})).from,Date.parse('2026-10-15T00:00:00Z'));
});
test('scoped OIDC roles only see and upload within administrator-assigned site or line scope',()=>{
  const f=fixture();f.approve(f.create('DEVICE',assets));f.approve(f.create('POINT_DEFINITION',[...definitions]));f.approve(f.create('MEASUREMENT',[measurement()]));
  const scoped={...auditor,roles:['equipment-admin'],scope:{provided:true,sites:['FACTORY-02'],lines:[],devices:[]}};
  const overview=dataOverview(f.data,scoped);assert.equal(overview.summary.devices,1);assert.equal(overview.items[0].asset.device_code,'PUMP-01');
  assert.equal(dataMeasurements(f.data,scoped).total,1);assert.equal(scopeAllows(scoped,{site_code:'FACTORY-02',line_code:'UTILITY-01',device_code:'PUMP-01'}),true);assert.equal(scopeAllows(scoped,{site_code:'FACTORY-03',line_code:'UTILITY-02',device_code:'COMP-01'}),false);
  const uploader={...scoped,roles:['data-uploader']};const blocked=f.create('DEVICE',[{...assets[1],source_record_id:'out-of-scope'}],uploader);assert.equal(blocked.status,'VALIDATION_FAILED');assert.ok(blocked.errors.some(e=>e.code==='OUT_OF_SCOPE'));
});

test('full filtered exports preserve lineage, tenant and scope while exceeding page size',()=>{
  const f=fixture();f.approve(f.create('DEVICE',assets));f.approve(f.create('POINT_DEFINITION',definitions));
  f.approve(f.create('MEASUREMENT',Array.from({length:120},(_,i)=>({...measurement(),source_record_id:'export-'+i,measured_at:new Date(Date.parse('2026-10-13T00:00:00Z')+i*60000).toISOString(),quality:i%2?'BAD':'GOOD'}))));
  assert.equal(dataMeasurements(f.data,auditor).items.length,50);
  const result=dataMeasurements(f.data,auditor,new URLSearchParams({deviceCode:'PUMP-01',quality:'GOOD'}),true);
  assert.equal(result.items.length,60);assert.equal(result.total,60);
  const text=measurementCsv(result);assert.ok(text.startsWith('\uFEFF'));assert.equal(text.split('\r\n').length,62);assert.ok(text.includes(result.items[0].source.snapshotDigest!));
  const scoped={...auditor,roles:['equipment-admin'],scope:{provided:true,sites:['FACTORY-02'],lines:[],devices:[]}};
  const csv=assetCsv(dataOverview(f.data,scoped,new URLSearchParams(),true));assert.ok(csv.includes('PUMP-01'));assert.ok(!csv.includes('COMP-01'));
  assert.equal(dataMeasurements(f.data,{...auditor,tenantId:'sandbox'},new URLSearchParams(),true).items.length,0);
  assert.equal(measurementCsv(dataMeasurements(emptyImports(),auditor)).split('\r\n').length,2);
  assert.throws(()=>dataMeasurements(f.data,{...auditor,roles:[]},new URLSearchParams(),true),/权限/);
  for(const params of ['page=1','pageSize=50'])assert.throws(()=>exportFilters(new URLSearchParams(params)),/分页/);
});

test('CSV neutralizes formula text and correctly quotes multiline source fields without changing numbers',()=>{
  const result={items:[{asset:{device_code:'SAFE',device_name:' \t=1+1',brand:'a,"b"\nc',model:'@SUM(1)',serial_number:'-123',criticality:'+cmd'},source:{batchId:'batch',sourceSystem:'\tformula',sourceRow:2,sourceRecordId:'record',snapshotDigest:'digest'},definedPoints:1,measurements:-2}]} as ReturnType<typeof dataOverview>;
  const csv=assetCsv(result);assert.ok(csv.includes('"\' \t=1+1"'));assert.ok(csv.includes('"a,""b""\nc"'));assert.ok(csv.includes('"\'@SUM(1)"'));assert.ok(csv.includes('"\'-123"'));assert.ok(csv.includes('"\'+cmd"'));assert.ok(csv.includes('"\'\tformula"'));assert.ok(csv.includes('"-2"'));
});

test('export cap rejects rather than truncating approved results',()=>{
  const f=fixture();f.approve(f.create('DEVICE',assets));f.approve(f.create('POINT_DEFINITION',definitions));f.approve(f.create('MEASUREMENT',[measurement()]));
  const row=f.data.records.find(r=>r.dataType==='MEASUREMENT')!;
  f.data.records.push(...Array.from({length:10000},(_,i)=>({...row,row:i+3,value:{...row.value,source_record_id:'large-'+i}})));
  assert.throws(()=>dataMeasurements(f.data,auditor,new URLSearchParams(),true),/超过10000行/);
  f.data.records.pop();assert.equal(dataMeasurements(f.data,auditor,new URLSearchParams(),true).items.length,10000);
});
