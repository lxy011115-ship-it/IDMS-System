import {batchInputValue,batchInputDigest} from './import-revisions.ts';
import {canonicalDigest} from './canonical-state.ts';
import {revisionFacts} from './import-revisions.ts';
import {governedColdImports,rechainColdImports} from '../scripts/fixtures/cold-import-governance.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {smallColdFixture} from '../scripts/fixtures/cold-proof-model.mjs';
import {coldImportModel} from '../scripts/fixtures/cold-import-model.mjs';
import {verifyColdImports,readColdImportSnapshot} from './cold-import-proof.ts';
import {resident,memoryTask,requestResources,limits} from './capacity.ts';
import {createBatch,approveBatch,canonical,digest} from './imports.ts';
import {validateTenantPayload} from './entity-repository.ts';
const upload={tenantId:'acme',actorId:'new-uploader',actorType:'USER',authMode:'oidc',roles:['data-uploader'],correlationId:'cold-import-unit'},review={...upload,actorId:'new-reviewer',roles:['final-approver']};
function corrections(){const payload=smallColdFixture(),store={...payload.business,audits:payload.audits,idempotency:new Map(payload.idempotency)};let parent=payload.imports.batches[0];for(let i=2;i<=3;i++){const row={...parent.rows[0],device_name:'逐批版本'+i},b=createBatch(payload.imports,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:parent.sourceSystem,rows:[row],lineNumbers:[i+5],original:Buffer.from(JSON.stringify(row)),filename:'correction.json',mime:'application/json',sourceKind:'API_JSON',supersedesBatchId:parent.batchId,correctionReason:'独立核对原来源'},upload);approveBatch(payload.imports,store,b.batchId,{decision:'APPROVED',comment:'独立核查',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},review);parent=b;}return payload;}
test('batchwise full source proof matches independent legacy canonical across empty and Base64 boundaries',async()=>{
 for(const size of [0,1,2,3,49151,49152,49153,98305]){const payload=smallColdFixture(size),before=resident.snapshot().total,model=coldImportModel(payload),bindings=await memoryTask(()=>verifyColdImports(model.client as any,'acme'),true);assert.equal(bindings.revision,7);assert.deepEqual(bindings.history,{workflowRequired:payload.business.workOrders.some(w=>!!w.workflow),aiModelDigests:[]});assert.equal(bindings.tenants.length,1);assert.deepEqual(Object.keys(bindings).sort(),['history','revision','tenants']);assert.ok(model.maxDriverRows<=1);assert.equal(resident.snapshot().total,before);assert.throws(()=>bindings.tenants.push({}));}
});
test('two correction versions match the actual root and frozen previous records without retaining all roots',async()=>{const payload=corrections();validateTenantPayload(payload,'acme');const m=coldImportModel(payload);await memoryTask(()=>verifyColdImports(m.client as any,'acme'),true);assert.ok(m.maxDriverRows<=1);});
test('every source phase rejects changed, missing, duplicate, foreign, ordering and metadata evidence and drains',async()=>{
 const payload=corrections(),before=resident.snapshot().total;const targets=['state','business','mirrors','headers','audits','receipts','totals','batch','inputs','fileMeta','chunks','anchor','projectionState','facts','requests','revisions','typedMismatch'];
 for(const target of targets){let hit=false;const m=coldImportModel(payload,{fault:(kind:string,rows:any[])=>{if(kind!==target||hit)return rows;hit=true;if(target==='state')rows[0].payload_digest='0'.repeat(64);else if(target==='totals')rows[0].inputs=String(Number(rows[0].inputs)+1);else if(target==='chunks')rows[0].content[0]^=1;else if(target==='typedMismatch')return [{bad:true}];else if(target==='anchor')rows[0].event.metadata.tamper=true;else if(target==='projectionState')rows[0].rows_digest='0'.repeat(64);else if(target==='batch')rows[0].body.lineNumbers=[];else if(target==='inputs')rows[0].valid_ordinal=2;else if(target==='mirrors')return [{tenant_id:'sandbox',id:'orphan',body:{}}];else if(target==='revisions')rows.at(-1).previous_digest='0'.repeat(64);else return [];return rows;}});await assert.rejects(memoryTask(()=>verifyColdImports(m.client as any,'acme'),true),target);assert.equal(hit,true,target);assert.equal(resident.snapshot().total,before,target);}
});
test('audit sequence may have legitimate gaps while tenant/order/column failures remain denied',async()=>{
 const payload=smallColdFixture();await memoryTask(()=>verifyColdImports(coldImportModel(payload,{fault:(kind:string,rows:any[])=>kind==='audits'?rows.map((r,i)=>({...r,sequence_no:String(100+i*100)})):rows}).client as any,'acme'),true);
 for(const target of ['foreign','duplicate','column']){const m=coldImportModel(payload,{fault:(kind:string,rows:any[])=>{if(kind==='audits'){if(target==='foreign')rows[0].tenant_id='sandbox';if(target==='duplicate')rows.splice(1,0,structuredClone(rows[0]));if(target==='column')rows[0].hash='bad';}return rows;}});await assert.rejects(memoryTask(()=>verifyColdImports(m.client as any,'acme'),true));}
});
test('cancellation before sources and after complete canonical/typed work releases all proof allocations',async()=>{
 const payload=corrections(),before=resident.snapshot().total;for(const phase of ['inputs','typedCounts','revisions']){const control=new AbortController(),m=coldImportModel(payload,{visit:(kind:string)=>{if(kind===phase)control.abort();}});await requestResources.run({signal:control.signal} as any,()=>assert.rejects(memoryTask(()=>verifyColdImports(m.client as any,'acme'),true),e=>(e as any).code==='REQUEST_CANCELLED'));assert.equal(resident.snapshot().total,before);}
});

test('a recomputed full root and audit chain cannot bypass frozen mapping/profile/correction anchors or previous-record rules',async()=>{
 const payload=governedColdImports();validateTenantPayload(payload,'acme');await memoryTask(()=>verifyColdImports(coldImportModel(payload).client as any,'acme'),true);
 const changes=[
 (p:any)=>delete p.imports.batches.find((b:any)=>b.mappingBinding).mappingBinding,
 (p:any)=>delete p.imports.batches.find((b:any)=>b.correction).correction,
 (p:any)=>delete p.imports.batches.find((b:any)=>b.equipmentProfileBinding).equipmentProfileBinding,
 (p:any)=>{const t=p.business.templates.find((t:any)=>t.manifest.purpose==='equipment-profile');p.audits.filter((a:any)=>a.objectType==='TEMPLATE'&&a.objectId===t.id).at(-1).after.name='forged';},
 (p:any)=>{const b=p.imports.batches.find((b:any)=>b.mappingBinding);p.audits.find((a:any)=>a.objectId===b.batchId&&a.action==='IMPORT_RECEIVED').metadata.sourceHeaders=['forged'];},
 (p:any)=>{const b=p.imports.batches.find((b:any)=>b.correction),e=p.audits.find((a:any)=>a.objectId===b.batchId&&a.action==='IMPORT_RECEIVED');b.correction.baseRows[0].recordDigest='0'.repeat(64);e.metadata.correction=structuredClone(b.correction);}
 ];
 for(const change of changes){const candidate=structuredClone(payload);change(candidate);rechainColdImports(candidate);const m=coldImportModel(candidate,{ledgerPayload:payload});await assert.rejects(memoryTask(()=>verifyColdImports(m.client as any,'acme'),true));}
});

test('explicit complete read capture uses exactly the proved business, real inputs/independent valid rows and all facts',async()=>{
 const payload=corrections(),before=resident.snapshot().total,m=coldImportModel(payload),loaded=await memoryTask(()=>readColdImportSnapshot(m.client as any,'acme'),true);assert.deepEqual(loaded.data,{store:payload.business,imports:{batches:payload.imports.batches.map(({originalBase64,...batch})=>batch),records:payload.imports.records}});assert.equal(loaded.revision,7);assert.notEqual(loaded.data.imports.batches[0].rows[0],loaded.data.imports.batches[0].validRows[0]);assert.throws(()=>loaded.data.imports.batches[0].rows[0].device_name='poison');assert.equal('originalBase64' in loaded.data.imports.batches[0],false);assert.equal('requests' in loaded.data.imports,false);assert.equal(resident.snapshot().total,before);
 const broken=coldImportModel(payload,{fault:(kind:string,rows:any[])=>{if(kind==='batch')rows[0].body.filename='changed-after-proof-query';return rows;}});await assert.rejects(memoryTask(()=>readColdImportSnapshot(broken.client as any,'acme'),true));assert.equal(resident.snapshot().total,before);
});

test('streamed snapshot payload factories preserve the independent old plain/mapping/profile/correction formulas',()=>{
 const payload=governedColdImports(),plain=smallColdFixture().imports.batches[0];
 for(const original of [plain,...payload.imports.batches]){const b=structuredClone(original);b.rows[0].unicode='汉😀\u0000"\\'.repeat(20000);const old=b.mappingBinding?{rows:b.rows,templateVersion:b.templateVersion,ruleVersion:'upload-rules-1.0.0',sourceSystem:b.sourceSystem,dataType:b.dataType,mappingBinding:b.mappingBinding,sourceHeaders:b.sourceHeaders,fileSha256:b.fileSha256,lineNumbers:b.lineNumbers,...(b.equipmentProfileBinding?{equipmentProfileBinding:b.equipmentProfileBinding}:{}),...(b.correction?{correction:b.correction}:{})}:{rows:b.rows,templateVersion:b.templateVersion,ruleVersion:'upload-rules-1.0.0',sourceSystem:b.sourceSystem,dataType:b.dataType,...(b.correction||b.equipmentProfileBinding?{...(b.correction?{correction:b.correction}:{}),...(b.equipmentProfileBinding?{equipmentProfileBinding:b.equipmentProfileBinding}:{}),fileSha256:b.fileSha256,lineNumbers:b.lineNumbers}:{})};const expected=digest(canonical(old));assert.deepEqual(batchInputValue(b),old);assert.equal(batchInputDigest(b),expected);assert.equal(canonicalDigest(batchInputValue(b)),expected);}
});
test('even valid recomputed canonical/audit/input roots and matching wire metadata cannot forge the previous stored record',async()=>{
 const payload=governedColdImports(),candidate=structuredClone(payload),batch=candidate.imports.batches.find((b:any)=>b.correction)!,event=candidate.audits.find((e:any)=>e.objectId===batch.batchId&&e.action==='IMPORT_RECEIVED')!;batch.correction!.baseRows[0].recordDigest='0'.repeat(64);batch.snapshotDigest=batchInputDigest(batch);event.metadata.correction=structuredClone(batch.correction);event.metadata.snapshotDigest=batch.snapshotDigest;rechainColdImports(candidate);assert.throws(()=>revisionFacts(candidate.imports));let reached=false;
 const m=coldImportModel(candidate,{ledgerPayload:payload,visit:(kind:string)=>{if(kind==='revisions')reached=true;},fault:(kind:string,rows:any[])=>{if(kind==='revisions')for(const row of rows)if(row.kind==='revision'&&row.batch_id===batch.batchId){row.previous_digest='0'.repeat(64);row.snapshot_digest=batch.snapshotDigest;}return rows;}});await assert.rejects(memoryTask(()=>verifyColdImports(m.client as any,'acme'),true));assert.equal(reached,true,'global root, frozen bindings and typed checks passed before previous-record validation rejected the forgery');
});

test('early proof budget refusal releases business/header work and the shared task capacity is reusable',async()=>{
 const payload=corrections(),before=resident.snapshot().total,block=resident.account('task');block.grow(limits.taskTotalBytes-100000);try{const m=coldImportModel(payload);await assert.rejects(memoryTask(()=>verifyColdImports(m.client as any,'acme'),true),e=>(e as any).code==='MEMORY_BUDGET');}finally{block.release();}assert.equal(resident.snapshot().total,before);await memoryTask(()=>verifyColdImports(coldImportModel(payload).client as any,'acme'),true);assert.equal(resident.snapshot().total,before);
});

test('plain batch frozen input digest is checked even if a changed normalized row has a recomputed valid overall root',async()=>{
 const candidate=smallColdFixture(),batch=candidate.imports.batches[0];batch.rows[0].device_name='changed normalized input';batch.validRows=structuredClone(batch.rows);assert.notEqual(batchInputDigest(batch),batch.snapshotDigest);let factsStarted=false;const m=coldImportModel(candidate,{visit:(kind:string)=>{if(kind==='facts')factsStarted=true;}});await assert.rejects(memoryTask(()=>verifyColdImports(m.client as any,'acme'),true));assert.equal(factsStarted,false);
});
