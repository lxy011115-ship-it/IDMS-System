import test from 'node:test';
import assert from 'node:assert/strict';
import {smallColdFixture} from '../scripts/fixtures/cold-proof-model.mjs';
import {coldImportModel} from '../scripts/fixtures/cold-import-model.mjs';
import {governedColdImports,rechainColdImports} from '../scripts/fixtures/cold-import-governance.ts';
import {verifyColdImports,readColdImportSnapshot} from './cold-import-proof.ts';
import {verifyColdImports as verifyBatchV1} from '../scripts/fixtures/cold-input-baseline-proof.ts';
import {batchInputDigest} from './import-revisions.ts';
import {memoryTask,resident,limits,requestResources} from './capacity.ts';
import {createBatch,approveBatch,emptyImports,definitions} from './imports.ts';
import {seedStore} from './store.ts';
import {tenantPayload} from './entity-repository.ts';
const u={tenantId:'acme',actorId:'dual-uploader',actorType:'USER',authMode:'oidc' as const,roles:['data-uploader'],correlationId:'dual-input-test'},reviewer={...u,actorId:'dual-reviewer',roles:['final-approver']};
function inputs(selected=[2,0]){const p=smallColdFixture(3),b=p.imports.batches[0],row=b.rows[0];b.rows=Array.from({length:3},(_,i)=>({...row,source_record_id:'input-'+i,device_name:'行'+i}));b.validRows=selected.map(i=>structuredClone(b.rows[i]));b.lineNumbers=[2,40000000000,6];b.snapshotDigest=batchInputDigest(b);return p;}
const prove=(p:any,options={})=>memoryTask(()=>verifyColdImports(coldImportModel(p,options).client as any,'acme'),true);
test('dual streams preserve legitimate input ordinal gaps, int64 ordinals and permuted valid selection',async()=>{
 const p=inputs(),options={fault:(kind:string,rows:any[])=>['inputs','validInputs'].includes(kind)?rows.map(row=>({...row,ordinal:String(BigInt(row.ordinal)*100n+9000000000000000n)})):rows};
 await prove(p,options);const out=await memoryTask(()=>readColdImportSnapshot(coldImportModel(p,options).client as any,'acme'),true);assert.deepEqual(out.data.imports.batches[0].rows,p.imports.batches[0].rows);assert.deepEqual(out.data.imports.batches[0].validRows,p.imports.batches[0].validRows);
});
test('zero selected, repeated equal inputs and empty batches retain the exact old canonical result',async()=>{
 for(const selected of [[],[0,1,2]]){const p=inputs(selected);if(selected.length){const b=p.imports.batches[0];b.rows=[b.rows[0],structuredClone(b.rows[0]),structuredClone(b.rows[0])];b.validRows=structuredClone(b.rows);b.snapshotDigest=batchInputDigest(b);}await prove(p);await memoryTask(()=>verifyBatchV1(coldImportModel(p).client as any,'acme'),true);}
 const p=inputs([]),b=p.imports.batches[0];b.rows=[];b.lineNumbers=[];b.snapshotDigest=batchInputDigest(b);await prove(p);
});
test('counts and valid-stream membership, bodies, identity, selection and ordering all fail closed and release',async()=>{
 const before=resident.snapshot().total,changes:[string,(rows:any[])=>any[]][]=[
 ['inputCounts',r=>[{...r[0],inputs:'4'}]],['inputCounts',r=>[{...r[0],selected:'3'}]],['inputCounts',r=>[{...r[0],selected:'-1'}]],['inputCounts',()=>[]],
 ['validInputs',r=>r.slice(1)],['validInputs',r=>[...r,structuredClone(r[0])]],['validInputs',r=>r.reverse()],['validInputs',r=>r.map((v,i)=>i?v:{...v,ordinal:'2'})],
 ['validInputs',r=>r.map((v,i)=>i?v:{...v,body:{...v.body,device_name:'forged'}})],['validInputs',r=>r.map((v,i)=>i?v:{...v,tenant_id:'sandbox'})],['validInputs',r=>r.map((v,i)=>i?v:{...v,batch_id:'other'})],['validInputs',r=>r.map((v,i)=>i?v:{...v,valid_ordinal:null})],
 ['inputs',r=>r.map(v=>({...v,valid_ordinal:1}))],['inputs',r=>r.map(v=>({...v,valid_ordinal:3}))],['inputs',r=>r.slice(1)],['inputs',r=>[...r,structuredClone(r[0])]]
 ];for(const [target,change] of changes){await assert.rejects(prove(inputs(),{fault:(kind:string,rows:any[])=>kind===target?change(rows):rows}),target);assert.equal(resident.snapshot().total,before,target);}await prove(inputs());
});
test('valid stream cannot substitute a canonically equal body from a different original SQL input',async()=>{
 const p=inputs([0,1]),b=p.imports.batches[0];b.rows[1]=structuredClone(b.rows[0]);b.validRows=structuredClone(b.rows.slice(0,2));b.snapshotDigest=batchInputDigest(b);
 await prove(p);await assert.rejects(prove(p,{fault:(kind:string,rows:any[])=>kind==='validInputs'?rows.map((r,i)=>({...r,ordinal:String(2-i)})):rows}));
});
test('failure and cancellation while the second actual stream runs never return a partial complete read',async()=>{
 for(const capture of [false,true]){const before=resident.snapshot().total,control=new AbortController(),model=coldImportModel(inputs(),{visit:(kind:string)=>{if(kind==='validInputs')control.abort();}});await requestResources.run({signal:control.signal} as any,()=>assert.rejects(memoryTask(()=>capture?readColdImportSnapshot(model.client as any,'acme'):verifyColdImports(model.client as any,'acme'),true),e=>(e as any).code==='REQUEST_CANCELLED'));assert.equal(resident.snapshot().total,before);}
});
test('fixed selected manifest is reserved before allocation and a refused proof drains and reuses the budget',async()=>{
 const before=resident.snapshot().total,block=resident.account('task');let reserved=false;const model=coldImportModel(inputs(),{visit:(kind:string)=>{if(kind==='inputCounts'){block.grow(limits.taskTotalBytes-resident.snapshot().categories.task-1);reserved=true;}}});
 try{await assert.rejects(memoryTask(()=>verifyColdImports(model.client as any,'acme'),true),e=>(e as any).code==='MEMORY_BUDGET');assert.equal(reserved,true);}finally{block.release();}assert.equal(resident.snapshot().total,before);await prove(inputs());
});
test('governed profile rows remain bound to the declared reference even after all root and input digests are recomputed',async()=>{
 const p=governedColdImports(),b=p.imports.batches.find((b:any)=>b.equipmentProfileBinding&&!b.correction)!;b.rows[0].source_profile_ref='wrong';b.validRows=structuredClone(b.rows);b.snapshotDigest=batchInputDigest(b);p.audits.find((a:any)=>a.objectId===b.batchId&&a.action==='IMPORT_RECEIVED')!.metadata.snapshotDigest=b.snapshotDigest;
 rechainColdImports(p);await assert.rejects(prove(p),/记录类型来源与冻结绑定不一致/);
});
test('all seven actual import types and their approved corrections pass dual proof and the prior full-batch oracle',async()=>{
 const store=seedStore(),imports=emptyImports(),add=(type:string,row:any,extra={})=>{const b=createBatch(imports,store,{dataType:type,sourceSystem:'dual-unit',templateVersion:'1.0.0',rows:[row],original:Buffer.from(JSON.stringify(row)),filename:'dual.json',mime:'application/json',sourceKind:'API_JSON',...extra},u);assert.equal(b.status,'AWAITING_APPROVAL',JSON.stringify(b.errors));approveBatch(imports,store,b.batchId,{decision:'APPROVED',comment:'独立逐行核对',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},reviewer);return b;};
 const cases:[string,any,any][]=[
 ['DEVICE',{source_record_id:'asset',device_code:'PUMP',device_name:'泵',site_code:'FACTORY-01',line_code:'LINE-01'},{device_name:'循环泵'}],
 ['POINT_DEFINITION',{source_record_id:'point',device_code:'PUMP',tag_code:'pressure',tag_name:'压力',unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:60},{tag_name:'出口压力'}],
 ['MEASUREMENT',{source_record_id:'reading',device_code:'PUMP',tag_code:'pressure',measured_at:'2026-10-13T00:00:00Z',value:2,unit:'MPa',quality:'GOOD'},{value:3}],
 ['STATE_INTERVAL',{source_record_id:'state',device_code:'PUMP',start_time:'2026-10-13T00:00:00Z',end_time:'2026-10-13T08:00:00Z',state:'RUNNING',reason_code:''},{state:'DOWN',reason_code:'FAILURE'}],
 ['MAINTENANCE',{source_record_id:'repair',device_code:'PUMP',failure_time:'2026-10-13T00:00:00Z',repair_start:'2026-10-13T00:00:00Z',repair_end:'2026-10-13T01:00:00Z',failure_code:'BEARING',cause:'磨损',action:'更换'},{repair_end:'2026-10-13T01:30:00Z'}],
 ['QUALITY',{source_record_id:'quality',device_code:'PUMP',batch_code:'B',characteristic_code:'X',measured_at:'2026-10-13T00:00:00Z',sample_no:1,measured_value:1,unit:'mm',lsl:0,usl:10},{measured_value:2}],
 ['PRODUCTION',{source_record_id:'production',device_code:'PUMP',shift_code:'DAY',period_start:'2026-10-13T00:00:00Z',period_end:'2026-10-13T08:00:00Z',planned_minutes:480,total_count:1000,good_count:980,ideal_cycle_seconds:20},{good_count:950}]
 ];
 for(const [type,row] of cases)add(type,row);for(const [type,row,patch] of cases){const parent=imports.batches.find(b=>b.dataType===type)!;add(type,{...row,...patch},{supersedesBatchId:parent.batchId,correctionReason:'独立核查后修订'});}
 assert.equal(cases.length,Object.keys(definitions).length);const {audits,idempotency,...business}=store,p=tenantPayload({version:2,business,imports,audits,idempotency:[...idempotency]},'acme');await prove(p);await memoryTask(()=>verifyBatchV1(coldImportModel(p).client as any,'acme'),true);
});
test('large Unicode and historical undefined snapshot fields keep the exact original digest through actual streams',async()=>{
 const missing=inputs();delete (missing.imports.batches[0] as any).templateVersion;
 for(const p of [inputs(),missing,governedColdImports()]){const b=p.imports.batches.find((b:any)=>!b.correction)!;b.rows[0].unicode='汉😀\u0000"\\'.repeat(20000);b.validRows=structuredClone(b.rows);b.snapshotDigest=batchInputDigest(b);const event=p.audits.find((e:any)=>e.objectId===b.batchId&&e.action==='IMPORT_RECEIVED')!;event.metadata.snapshotDigest=b.snapshotDigest;rechainColdImports(p);await prove(p);await memoryTask(()=>verifyBatchV1(coldImportModel(p).client as any,'acme'),true);}
});
test('a recomputed whole root still cannot reorder the selected rows of an approved correction',async()=>{
 const store=seedStore(),imports=emptyImports(),rows=[0,1].map(i=>({source_record_id:'asset-'+i,device_code:'PUMP-'+i,device_name:'泵'+i,site_code:'FACTORY-01',line_code:'LINE-01'})),add=(rows:any[],extra={})=>{const b=createBatch(imports,store,{dataType:'DEVICE',sourceSystem:'dual-unit',templateVersion:'1.0.0',rows,original:Buffer.from(JSON.stringify(rows)),filename:'dual.json',mime:'application/json',sourceKind:'API_JSON',...extra},u);approveBatch(imports,store,b.batchId,{decision:'APPROVED',comment:'独立核查',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},reviewer);return b;};
 const parent=add(rows);add(rows.map(r=>({...r,device_name:r.device_name+'更正'})),{supersedesBatchId:parent.batchId,correctionReason:'独立核查后修改'});const {audits,idempotency,...business}=store,p=tenantPayload({version:2,business,imports,audits,idempotency:[...idempotency]},'acme');await prove(p);const changed=structuredClone(p);changed.imports.batches.at(-1)!.validRows.reverse();await assert.rejects(prove(changed,{ledgerPayload:p}),/Correction SQL ledger disagrees/);
});
