import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {coldModel,smallColdFixture,cloneColdRows} from '../scripts/fixtures/cold-proof-model.mjs';
import {ColdCanonicalVerifier,coldFileChunkBytes} from './cold-proof.ts';
import {LeanRows,readLeanSnapshot} from './lean-snapshot.ts';
import {memoryTask,resident,limits} from './capacity.ts';
import {canonical,digest,emptyImports,createBatch,approveBatch,definitions} from './imports.ts';
import {seedStore} from './store.ts';
import {createTemplate,submitTemplate,approveTemplate} from './catalog.ts';
import {tenantPayload,validateTenantPayload} from './entity-repository.ts';
import {emitCanonical,canonicalDigest} from './canonical-state.ts';
function prove(model:any,rows=model.rows){const proof=new ColdCanonicalVerifier(model.snapshot,'acme');try{for(const row of rows)proof.accept(row);return proof.finish();}finally{proof.dispose();}}

test('incremental canonical emitter preserves legacy bytes and bounded Unicode/scalar output',()=>{
 for(const value of [[],{},[undefined,,null],{a:undefined,b:'汉😀\ud800'},'x'.repeat(8191)+'😀'.repeat(50000),JSON.parse('{"__proto__":1,"a":2}')]){const chunks:string[]=[];emitCanonical(value,s=>chunks.push(s));assert.equal(chunks.join(''),canonical(value));assert.ok(chunks.every(s=>s.length<=32768));assert.equal(createHash('sha256').update(chunks.join('')).digest('hex'),canonicalDigest(value));}
});
test('independent full payload and segmented replay have identical canonical roots across Base64 remainder and empty files',()=>{
 for(const size of [0,1,2,3,49151,49152,49153,98305,131073]){const payload=smallColdFixture(size),model=coldModel(payload),out=prove(model);assert.equal(out.files,1);assert.equal(out.audits,payload.audits.length);assert.equal(out.receipts,1);assert.ok(model.rows.filter((r:any)=>r.kind==='file-chunk').every((r:any)=>r.content.length<=coldFileChunkBytes));}
});
test('lean assembly preserves complete old input/facts and independent valid rows without file/audit/receipt placeholders',()=>{
 const model=coldModel(smallColdFixture()),source=[...model.lean].reverse(),state=new LeanRows('acme');try{for(const row of source)state.add(row);const result=state.finish();assert.deepEqual(result.data,model.snapshot.data);assert.equal(result.payloadDigest,model.snapshot.payloadDigest);assert.notEqual(result.data.imports.batches[0].rows[0],result.data.imports.batches[0].validRows[0]);assert.equal('originalBase64'in result.data.imports.batches[0],false);assert.equal('audits'in result.data.store,false);assert.equal('requests'in result.data.imports,false);assert.throws(()=>result.data.imports.batches[0].rows[0].device_name='bad');}finally{state.dispose();}
 for(const change of [(r:any[])=>r.push({...r[0]}),(r:any[])=>r[0].tenant_id='foreign',(r:any[])=>r.find(x=>x.kind==='input').identity='orphan',(r:any[])=>r.find(x=>x.kind==='input').detail.validOrdinal=2,(r:any[])=>r.find(x=>x.kind==='record').identity='missing',(r:any[])=>r.find(x=>x.kind==='batch').detail.originalBase64='fake']){const rows=structuredClone(model.lean),builder=new LeanRows('acme');change(rows);try{assert.throws(()=>{rows.forEach(row=>builder.add(row));builder.finish();});}finally{builder.dispose();}}
});
test('every framed evidence section rejects missing, extra, reordered, foreign or changed content and audit columns',()=>{
 const model=coldModel(smallColdFixture());const corruptions=[
 (r:any[])=>r.splice(r.findIndex(x=>x.kind==='state'),1),
 (r:any[])=>r.find(x=>x.kind==='state').detail.payloadDigest='a'.repeat(64),
 (r:any[])=>r.find(x=>x.kind==='audit').detail.hash='bad',
 (r:any[])=>r.splice(r.findIndex(x=>x.kind==='audit'),1),
 (r:any[])=>r.find(x=>x.kind==='audit').detail.event.action='tamper',
 (r:any[])=>r.find(x=>x.kind==='receipt').detail={changed:true},
 (r:any[])=>r.find(x=>x.kind==='receipt').identity='foreign:command',
 (r:any[])=>r.find(x=>x.kind==='file-meta').detail.bytes++,
 (r:any[])=>r.find(x=>x.kind==='file-meta').identity='orphan',
 (r:any[])=>r.find(x=>x.kind==='file-chunk').content[0]^=1,
 (r:any[])=>r.find(x=>x.kind==='file-chunk').detail.offset++,
 (r:any[])=>r.splice(r.findIndex(x=>x.kind==='file-chunk'),1),
 (r:any[])=>{const i=r.findIndex(x=>x.kind==='file-chunk');r.splice(i,0,r[i]);},
 (r:any[])=>{const i=r.findIndex(x=>x.kind==='file-chunk');[r[i],r[i+1]]=[r[i+1],r[i]];},
 (r:any[])=>r.find(x=>x.kind==='request').detail.digest='changed',
 (r:any[])=>r.find(x=>x.kind==='request').tenant_id='foreign',
 (r:any[])=>r.splice(r.findIndex(x=>x.kind==='frame'&&x.phase===2),1),
 (r:any[])=>r.push({...r.at(-1)})
 ];for(const change of corruptions){const rows=cloneColdRows(model.rows);change(rows);assert.throws(()=>prove(model,rows));}
 const gaps=cloneColdRows(model.rows);for(const row of gaps)if(row.kind==='audit')row.ordinal=String(BigInt(row.ordinal)*100000000000n);assert.equal(prove(model,gaps).audits,model.rows.filter((r:any)=>r.kind==='audit').length);
 const reversed=cloneColdRows(model.rows),events=reversed.filter((r:any)=>r.kind==='audit');events[1].ordinal=events[0].ordinal;assert.throws(()=>prove(model,reversed));
});
test('canonical root covers all unretained receipts and the last hidden event even when files and active facts are unchanged',()=>{
 const model=coldModel(smallColdFixture());for(const kind of ['receipt','request','audit']){const rows=cloneColdRows(model.rows),i=rows.findLastIndex((r:any)=>r.kind===kind);rows.splice(i,1);assert.throws(()=>prove(model,rows));}
 const empty=smallColdFixture();empty.imports={batches:[],records:[],requests:[]};empty.audits=[];empty.idempotency=[];assert.equal(prove(coldModel(empty)).files,0);
});
test('row-index, file and evidence leases return on success or failure; insufficient budget rejects before source replay',async()=>{
 const model=coldModel(smallColdFixture(150000,3000)),before=resident.snapshot().total;await memoryTask(async()=>{const proof=new ColdCanonicalVerifier(model.snapshot,'acme');try{for(const row of model.rows)proof.accept(row);proof.finish();assert.ok(resident.snapshot().categories.task<1024*1024);}finally{proof.dispose();}},true);assert.equal(resident.snapshot().total,before);
 await assert.rejects(memoryTask(async()=>{const proof=new ColdCanonicalVerifier(model.snapshot,'acme');try{for(const row of model.rows){if(row.kind==='file-chunk')throw Error('WIRE_FAILURE');proof.accept(row);}}finally{proof.dispose();}},true),/WIRE_FAILURE/);assert.equal(resident.snapshot().total,before);
 const blocker=resident.account('task');blocker.grow(limits.taskTotalBytes-65537);try{await assert.rejects(memoryTask(async()=>{new ColdCanonicalVerifier(model.snapshot,'acme');},true),(e:any)=>e.code==='MEMORY_BUDGET');}finally{blocker.release();}assert.equal(resident.snapshot().total,before);
});
test('lean reader drains malformed rows on the same handle and clears the driver result array and leases',async()=>{
 const model=coldModel(smallColdFixture()),before=resident.snapshot().total;let seen=0,max=0;const client:any={query:(q:any)=>queueMicrotask(()=>{const result={rows:[] as any[]};for(const row of model.lean){q.emit('row',seen++===1?{...row,tenant_id:'foreign'}:row,result);result.rows.push(row);max=Math.max(max,result.rows.length);}q.callback(null,result);})};await assert.rejects(memoryTask(()=>readLeanSnapshot(client,'acme'),true));assert.equal(seen,model.lean.length);assert.equal(max,1);assert.equal(resident.snapshot().total,before);
});

function governed(){
 const store=seedStore(),imports=emptyImports(),designer={tenantId:'acme',actorId:'designer',actorType:'USER',authMode:'oidc' as const,roles:['tenant-admin'],correlationId:'gov'},uploader={...designer,actorId:'uploader',roles:['data-uploader']},reviewer={...designer,actorId:'reviewer',roles:['final-approver']};
 const publish=(manifest:any,key:string)=>{const t=createTemplate(store,{templateKey:key,version:'1.0.0',industry:'多设备',manifest},designer),expected=()=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});submitTemplate(store,t.id,expected(),designer);approveTemplate(store,t.id,{...expected(),decision:'APPROVED',comment:'独立核验'},reviewer);return {templateId:t.id,version:t.version,contentDigest:t.contentDigest};};
 const policy={finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},profile=publish({schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'equipment-profile',modules:['equipment','quality','data-import'],policy,equipmentProfile:{typeCode:'pump',typeName:'泵组',assetFields:[],points:[{tag_code:'pressure',tag_name:'压力',unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:60}],qualityRules:{gapMultiplier:1.5,staleMultiplier:3,futureSkewSeconds:300}}},'cold-pump');
 const add=(rows:any[],extra:any={})=>{const b=createBatch(imports,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'enterprise',rows,original:Buffer.from(JSON.stringify(rows)),filename:'gov.json',mime:'application/json',sourceKind:'API_JSON',...extra},uploader);assert.equal(b.status,'AWAITING_APPROVAL');approveBatch(imports,store,b.batchId,{decision:'APPROVED',comment:'独立核对',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},reviewer);return b;};
 const a={source_record_id:'profile',device_code:'PROFILE-1',device_name:'配置设备',site_code:'FACTORY-01',line_code:'LINE-01'},first=add([a],{equipmentProfileRef:profile});add([{...first.rows[0],device_name:'显式更正'}],{equipmentProfileRef:profile,supersedesBatchId:first.batchId,correctionReason:'已核验更正'});
 const columns=['source_record_id','device_code','device_name','site_code','line_code'].map((targetField,i)=>({sourceColumn:'企业列'+i,targetField})),mapping=publish({schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'import-mapping',modules:['data-import'],policy,importMapping:{dataType:'DEVICE',sourceSystem:'enterprise',templateVersion:'1.0.0',columns}},'cold-map');
 const mapped={...a,source_record_id:'mapped',device_code:'MAPPED-1'};add([Object.fromEntries(columns.map(c=>[c.sourceColumn,(mapped as any)[c.targetField]]))],{mappingRef:mapping,sourceHeaders:columns.map(c=>c.sourceColumn),sourceKind:'MANUAL_FILE'});
 const {audits,idempotency,...business}=store;return tenantPayload({version:2,business,imports,audits,idempotency:[...idempotency]},'acme');
}
function rechain(payload:any){let previous='GENESIS';for(const event of payload.audits){const {hash,...base}=event;base.previousHash=previous;event.previousHash=previous;event.hash=digest(previous+canonical(base));previous=event.hash;}}

test('cold evidence preserves mapping, profile inheritance anchors and frozen correction rules even with a valid root and recomputed chain',()=>{
 const payload=governed();validateTenantPayload(payload,'acme');assert.equal(prove(coldModel(payload)).files,3);
 for(const change of [
 (p:any)=>delete p.imports.batches.find((b:any)=>b.mappingBinding).mappingBinding,
 (p:any)=>delete p.imports.batches.find((b:any)=>b.correction).correction,
 (p:any)=>delete p.imports.batches.find((b:any)=>b.equipmentProfileBinding).equipmentProfileBinding,
 (p:any)=>{const t=p.business.templates.find((t:any)=>t.manifest.purpose==='equipment-profile');p.audits.filter((e:any)=>e.objectType==='TEMPLATE'&&e.objectId===t.id).at(-1).after.name='forged-latest-anchor';},
 (p:any)=>{const b=p.imports.batches.find((b:any)=>b.mappingBinding);p.audits.find((e:any)=>e.objectId===b.batchId&&e.action==='IMPORT_RECEIVED').metadata.sourceHeaders=['伪造'];}
 ]){const invalid=structuredClone(payload);change(invalid);rechain(invalid);assert.throws(()=>validateTenantPayload(invalid,'acme'));assert.throws(()=>prove(coldModel(invalid)));}
});
test('compact received evidence includes later flags and full occurrence counts without retaining every event',()=>{
 const payload=smallColdFixture(),batch=payload.imports.batches[0],later={...structuredClone(payload.audits.at(-1)),eventId:'duplicate-received-unit',objectType:'DATA_IMPORT',objectId:batch.batchId,action:'IMPORT_RECEIVED',metadata:{mappingBinding:{forged:true}}};payload.audits.push(later);rechain(payload);assert.throws(()=>validateTenantPayload(payload,'acme'));assert.throws(()=>prove(coldModel(payload)));
});
