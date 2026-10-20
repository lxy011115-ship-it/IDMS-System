import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatch,approveBatch,emptyImports} from './imports.ts';
import {seedStore} from './store.ts';
import {historicalImports,importHistoryIndex,batchHistory,historicalImportPlan} from './asof-imports.ts';
const start=Date.parse('2026-10-16T00:00:00.000Z'),ctx=(id:string,roles:string[])=>({tenantId:'acme',actorId:id,actorType:'USER',authMode:'oidc' as const,roles,correlationId:'asof'}),u=ctx('uploader',['data-uploader']),r=ctx('reviewer',['final-approver']);
function clock<T>(at:number,fn:()=>T){const Real=Date;globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?at:v);}static now(){return at;}} as DateConstructor;try{return fn();}finally{globalThis.Date=Real;}}
function fixture(){const store=seedStore(),data=emptyImports();const put=(type:any,rows:any[],at:number,extra={})=>clock(at,()=>{const b=createBatch(data,store,{dataType:type,rows,sourceSystem:'history',templateVersion:'1.0.0',original:Buffer.from(JSON.stringify(rows)),filename:'qa.json',mime:'application/json',sourceKind:'API_JSON',...extra},u);assert.equal(b.status,'AWAITING_APPROVAL',JSON.stringify(b.errors));approveBatch(data,store,b.batchId,{decision:'APPROVED',comment:'独立审核',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},r);return b;});
 const asset=put('DEVICE',[{source_record_id:'a',device_code:'H-A',device_name:'历史设备',site_code:'A',line_code:'L'}],start),def=put('POINT_DEFINITION',[{source_record_id:'p',device_code:'H-A',tag_code:'pressure',tag_name:'压力',unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:60}],start+1000),measurement=put('MEASUREMENT',[{source_record_id:'m',device_code:'H-A',tag_code:'pressure',measured_at:new Date(start).toISOString(),value:2,unit:'MPa',quality:'BAD'}],start+2000),read=(at:number)=>historicalImports(data,store.audits,'acme',at);
 return {store,data,put,asset,def,measurement,read};
}
test('historical imports exclude later approvals and late arrivals even when event time is old',()=>{
 const f=fixture();assert.deepEqual(f.read(start-1),[]);assert.equal(f.read(start).length,1);assert.equal(f.read(start+1000).length,2);assert.equal(f.read(start+1999).filter(r=>r.record.dataType==='MEASUREMENT').length,0);const x=f.read(start+2000).find(r=>r.record.dataType==='MEASUREMENT')!;assert.equal(x.record.value.quality,'BAD');assert.equal(x.source.recordVersion,1);assert.ok(x.source.approvalEventId);assert.ok(x.source.committedEventId);
});
test('definition and measurement corrections replay exact historical versions without rewriting roots',()=>{
 const f=fixture(),old=f.read(start+2000);const d=f.put('POINT_DEFINITION',[{...f.def.rows[0],expected_interval_seconds:120}],start+3000,{supersedesBatchId:f.def.batchId,correctionReason:'复核定义'}),m=f.put('MEASUREMENT',[{...f.measurement.rows[0],quality:'GOOD'}],start+4000,{supersedesBatchId:f.measurement.batchId,correctionReason:'复核原始记录'});
 assert.deepEqual(f.read(start+2000),old);assert.equal(f.read(start+2999).find(r=>r.record.dataType==='POINT_DEFINITION')!.record.value.expected_interval_seconds,60);assert.equal(f.read(start+3000).find(r=>r.record.dataType==='POINT_DEFINITION')!.record.value.expected_interval_seconds,120);assert.equal(f.read(start+3999).find(r=>r.record.dataType==='MEASUREMENT')!.record.value.quality,'BAD');const fixed=f.read(start+4000).find(r=>r.record.dataType==='MEASUREMENT')!;assert.equal(fixed.record.value.quality,'GOOD');assert.equal(fixed.revision,2);assert.equal(fixed.source.batchId,m.batchId);assert.equal(f.data.records.find(r=>r.batchId===f.measurement.batchId)!.value.quality,'BAD');assert.equal(d.status,'COMMITTED');
});
test('independent approval commit counts source hashes identity clocks and audit order are mandatory',()=>{
 const f=fixture(),e=importHistoryIndex(f.store.audits,'acme').get(f.def.batchId)!;assert.ok(batchHistory(f.def,e));
 for(const mutate of [(v:any)=>v.approvalCount=2,(v:any)=>v.commitCount=0,(v:any)=>v.approval.actorId='uploader',(v:any)=>v.commit.actorType='USER',(v:any)=>v.commit.tenantId='sandbox',(v:any)=>v.commit.metadata.committed++,(v:any)=>v.approval.metadata.snapshotDigest='0'.repeat(64),(v:any)=>v.commit.businessTime=new Date(start-1).toISOString(),(v:any)=>v.commitSequence=v.approvalSequence]){const x=structuredClone(e);mutate(x);assert.throws(()=>batchHistory(f.def,x),/不可验证/);}
 const x=structuredClone(f.def);x.approval!.comment='changed';assert.throws(()=>batchHistory(x,e));
});
test('correction commit clock reversal cannot fabricate a version missing its historical predecessor',()=>{
 const f=fixture(),m=f.put('MEASUREMENT',[{...f.measurement.rows[0],quality:'GOOD'}],start+3000,{supersedesBatchId:f.measurement.batchId,correctionReason:'复核原始记录'}),index=importHistoryIndex(f.store.audits,'acme'),e=index.get(m.batchId)!;const bad=structuredClone(e);bad.commit!.businessTime=new Date(start+1500).toISOString();assert.throws(()=>historicalImportPlan(f.data.batches,'acme',start+2500,id=>id===m.batchId?bad:index.get(id)),/不可验证/);
 const empty=structuredClone(f.def);empty.status='REJECTED';assert.throws(()=>batchHistory(empty,index.get(f.def.batchId)));let allocated=0;historicalImports(f.data,f.store.audits,'acme',start+4000,()=>{allocated++;});assert.equal(allocated,1);
});
