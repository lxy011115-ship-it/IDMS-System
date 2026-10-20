import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyze } from '../services/predictor/model.ts';
import { emptyImports,createBatch,approveBatch,parseCsv } from './imports.ts';
import { seedStore } from './store.ts';
import { measurementSchema } from './measurement-schema.ts';
const csv=await readFile('docs/upload-templates/measurements.csv','utf8');
const points=parseCsv(csv).rows.map(r=>({tag_code:String(r.tag_code),measured_at:String(r.measured_at),value:Number(r.value),unit:String(r.unit),quality:String(r.quality)}));
const uploader={tenantId:'acme',actorId:'demo.uploader',actorType:'USER',correlationId:'test'},approver={...uploader,actorId:'demo.approver'};
function create(data:any,store:any,type:string,rows:any[]){return createBatch(data,store,{dataType:type,rows,original:Buffer.from(csv),filename:'test.csv',mime:'text/csv',templateVersion:'1.0.0',sourceSystem:'manual-excel',sourceKind:'MANUAL_FILE'},uploader);}
test('measurements require approved assets, correct units, finite ranges and independent approval',()=>{
  const data=emptyImports(),store=seedStore();
  const unknown=create(data,store,'MEASUREMENT',parseCsv(csv).rows);assert.equal(unknown.status,'VALIDATION_FAILED');
  const asset=create(data,store,'DEVICE',[{source_record_id:'asset-1',device_code:'D-001',device_name:'数控车床',site_code:'FACTORY-01',line_code:'LINE-01'}]);
  approveBatch(data,store,asset.batchId,{decision:'APPROVED',comment:'核查台账',expectedVersion:asset.version,snapshotDigest:asset.snapshotDigest},approver);
  const bad=create(data,store,'MEASUREMENT',[{...parseCsv(csv).rows[0],unit:'g'}]);assert.ok(bad.errors.some(e=>e.code==='UNIT_MISMATCH'));
  const batch=create(data,store,'MEASUREMENT',parseCsv(csv).rows);assert.equal(batch.status,'AWAITING_APPROVAL');
  assert.equal(data.records.filter(r=>r.dataType==='MEASUREMENT').length,0);
  approveBatch(data,store,batch.batchId,{decision:'APPROVED',comment:'核查测点',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},approver);
  assert.equal(data.records.filter(r=>r.dataType==='MEASUREMENT').length,18);
});
test('cold-start analysis gives explainable rules, not fabricated RUL or probabilities',()=>{
  const result=analyze(points);assert.ok(result.score<65);assert.equal(result.features.length,3);assert.equal(result.confidence,null);assert.equal(result.probability,null);assert.equal(result.rul,null);
  const ordered=analyze([...points].reverse());assert.deepEqual(ordered,result);
});
test('bad quality, missing tags, duplicate times, bad units and misaligned windows fail closed',()=>{
  assert.throws(()=>analyze(points.filter(p=>p.tag_code!=='vibration_rms')));
  assert.throws(()=>analyze(points.map(p=>p.tag_code==='vibration_rms'?{...p,quality:'BAD'}:p)));
  assert.throws(()=>analyze([...points,points[0]]),/重复/);
  assert.throws(()=>analyze(points.map((p,i)=>i===0?{...p,unit:'g'}:p)),/单位/);
  assert.throws(()=>analyze(points.map(p=>p.tag_code==='vibration_rms'?{...p,measured_at:new Date(Date.parse(p.measured_at)-3600000).toISOString()}:p)),/对齐/);
});
test('warning and critical features cannot contradict the overall health classification',()=>{
  const limits=(kind:'warning'|'critical'|'normal')=>points.map(p=>({...p,value:kind==='normal'?measurementSchema[p.tag_code as keyof typeof measurementSchema].warning-0.01:measurementSchema[p.tag_code as keyof typeof measurementSchema][kind]}));
  const warning=analyze(limits('warning'));assert.equal(warning.band,'WATCH');assert.equal(warning.score,79);assert.ok(warning.features.every(f=>f.status==='ELEVATED'));
  const critical=analyze(limits('normal').map(p=>p.tag_code==='vibration_rms'?{...p,value:measurementSchema.vibration_rms.critical}:p));assert.equal(critical.band,'CRITICAL');assert.ok(critical.score<=34);
  const normal=analyze(limits('normal'));assert.equal(normal.band,'HEALTHY');assert.ok(normal.features.every(f=>f.status==='NORMAL'));
});
