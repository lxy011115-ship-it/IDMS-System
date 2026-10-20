import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {seedStore} from './store.ts';
import {canonical,digest,definitions,parseCsv,createBatch,approveBatch,emptyImports,type Batch,type DataType} from './imports.ts';
import {mappingSchema,mapRows,verifyMappedBatch} from './import-mapping.ts';
import {createTemplate,submitTemplate,approveTemplate,verifyBatchMapping,bindImportMapping,exportTemplate,importTemplate} from './catalog.ts';
import {validateManifest} from './template-schema.ts';
import type {AccessContext} from './access.ts';
const ctx=(actorId:string,roles:string[],tenantId='acme'):AccessContext=>({actorId,roles,tenantId,actorType:'USER',authMode:'oidc',correlationId:randomUUID()});
const designer=ctx('designer',['tenant-admin']),uploader=ctx('uploader',['data-uploader','final-approver']),approver=ctx('approver',['final-approver']);
const expected=(t:any)=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});
function manifest(type:DataType='DEVICE'){return {schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'import-mapping',modules:['data-import'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},importMapping:{dataType:type,sourceSystem:'enterprise',templateVersion:'1.0.0',columns:definitions[type].fields.map((f,i)=>({sourceColumn:'企业字段'+i,targetField:f}))}};}
function publish(store:any,type:DataType='DEVICE',version='1.0.0') {const t=createTemplate(store,{templateKey:'import-map-'+type.toLowerCase().replaceAll('_','-'),version,industry:'多设备',manifest:manifest(type)},designer);submitTemplate(store,t.id,expected(t),designer);approveTemplate(store,t.id,{...expected(t),decision:'APPROVED',comment:'独立复核'},approver);return t;}
const ref=(t:any)=>({templateId:t.id,version:t.version,contentDigest:t.contentDigest});
function batch(store:any,data:any,t:any,type:DataType='DEVICE',file?:string):Batch {
 const content=readFileSync('docs/upload-templates/'+(file||definitions[type].file),'utf8'),parsed=parseCsv(content);
 const columns=t.manifest.importMapping.columns.filter((c:any)=>parsed.sourceHeaders.includes(c.targetField)),sourceHeaders=columns.map((c:any)=>c.sourceColumn);
 const rows=parsed.rows.map(row=>Object.fromEntries(columns.map((c:any)=>[c.sourceColumn,row[c.targetField]])));
 return createBatch(data,store,{dataType:type,templateVersion:'1.0.0',sourceSystem:'enterprise',rows,sourceHeaders,original:Buffer.from(content.replace(/^[^\r\n]+/,sourceHeaders.join(','))),filename:'mapped.csv',mime:'text/csv',sourceKind:'MANUAL_FILE',mappingRef:ref(t)},uploader);
}
const approve=(s:any,d:any,b:Batch,c=approver)=>approveBatch(d,s,b.batchId,{decision:'APPROVED',comment:'独立核查数据',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},c);

test('mapped correction freezes both the original header mapping and prior record version across retirement',()=>{
 const s=seedStore(),d=emptyImports(),t=publish(s),original=batch(s,d,t);approve(s,d,original);
 const changed={...original.rows[0],device_name:'修正后的设备名称'},columns=t.manifest.importMapping.columns.filter((c:any)=>original.sourceHeaders!.includes(c.sourceColumn)),rows=[Object.fromEntries(columns.map((c:any)=>[c.sourceColumn,changed[c.targetField]]))];
 const b=createBatch(d,s,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'enterprise',rows,sourceHeaders:original.sourceHeaders,original:Buffer.from(JSON.stringify(rows)),filename:'correction.csv',mime:'text/csv',sourceKind:'MANUAL_FILE',mappingRef:ref(t),supersedesBatchId:original.batchId,correctionReason:'复核原始台账'},uploader);
 verifyBatchMapping(s,b);publish(s,'DEVICE','1.1.0');verifyBatchMapping(s,b);approve(s,d,b);assert.equal(b.correction!.baseRows[0].revision,2);assert.equal(d.records[0].value.device_name,original.rows[0].device_name);
});

test('mapping covers all seven type schemas while rejecting unknown, duplicate, reserved and incomplete columns',()=>{
 for(const type of Object.keys(definitions) as DataType[])assert.equal(mappingSchema(manifest(type).importMapping).dataType,type);
 const valid=manifest().importMapping;
 for(const change of [{columns:valid.columns.slice(1)},{columns:[...valid.columns,{sourceColumn:'重复',targetField:'device_code'}]},{columns:valid.columns.map((c,i)=>i?c:{...c,targetField:'tenant_id'})},{columns:valid.columns.map((c,i)=>i?c:{...c,sourceColumn:'__proto__'})},{columns:valid.columns.map((c,i)=>i?c:{...c,sourceColumn:'编号\u200b'})},{columns:valid.columns.map((c,i)=>i?c:{...c,sourceColumn:' 编号'})},{columns:valid.columns.map((c,i)=>i?c:{...c,script:'run'})},{sourceSystem:'has space'},{templateVersion:'2.0.0'}])assert.throws(()=>mappingSchema({...valid,...change}));
 assert.throws(()=>validateManifest({...manifest(),maintenance:{fields:[]}}));
 assert.throws(()=>validateManifest({...manifest(),purpose:'other'}));
});
test('mapped CSV preserves original headers and physical rows, standard parsing is not relaxed',()=>{
 const parsed=parseCsv('\uFEFF 编号 ,设备名称\r\n1,"两行\n名称"\r\n\r\n2,第二台',true);assert.deepEqual(parsed.sourceHeaders,[' 编号 ','设备名称']);assert.deepEqual(parsed.lineNumbers,[2,5]);assert.equal(parsed.rows[0]['编号'],'1');
 for(const header of ['a,a',' 编号,编号 ','编号,\u200b隐藏','编号,__proto__','编号,','编号,constructor'])assert.throws(()=>parseCsv(header+'\n1,2',true));
 assert.throws(()=>parseCsv('编号,名称\n1,设备'));assert.throws(()=>parseCsv('编号,名称\n1',true));
});
test('mapRows rejects missing and unknown columns and never fills absent optional fields',()=>{
 const m=mappingSchema(manifest().importMapping),headers=m.columns.slice(0,5).map(c=>c.sourceColumn),row=Object.fromEntries(headers.map((h,i)=>[h,String(i)]));
 assert.equal(mapRows([row],headers,m)[0].equipment_type,undefined);
 assert.throws(()=>mapRows([],headers.slice(1),m),/缺少/);assert.throws(()=>mapRows([],headers.concat('不认识'),m),/未配置/);
 assert.throws(()=>mapRows([{...row,extra:'x'}],headers,m),/不一致/);
});
test('mapping publication is independent, scope bound, portable as draft and cannot replace maintenance purpose',()=>{
 const s=seedStore(),t=publish(s);assert.throws(()=>bindImportMapping(s,ref(t),'sandbox','DEVICE','enterprise'),/不存在/);
 for(const [type,source] of [['QUALITY','enterprise'],['DEVICE','other']])assert.throws(()=>bindImportMapping(s,ref(t),'acme',type,source),/不匹配/);
 assert.throws(()=>bindImportMapping(s,{...ref(t),contentDigest:'bad'},'acme','DEVICE','enterprise'));
 assert.throws(()=>createTemplate(s,{templateKey:'maintenance-form',version:'1.0.0',industry:'设备',manifest:manifest()},designer));
 const pack=exportTemplate(s,t.id,approver),other=importTemplate(s,pack,ctx('other',['tenant-admin'],'sandbox'));assert.equal(other.status,'DRAFT');assert.equal(other.publishedBy,undefined);assert.throws(()=>bindImportMapping(s,ref(other),'sandbox','DEVICE','enterprise'));
 const draft=createTemplate(s,{templateKey:'new-mapping',version:'1.0.0',industry:'设备',manifest:manifest()},uploaderWithDesign());submitTemplate(s,draft.id,expected(draft),uploaderWithDesign());assert.throws(()=>approveTemplate(s,draft.id,{...expected(draft),decision:'APPROVED',comment:'自审'},uploaderWithDesign()),/不得终审/);
 function uploaderWithDesign(){return ctx('author',['tenant-admin','final-approver']);}
});
test('old pending batches keep retired mapping and standard uploads keep the original digest contract',()=>{
 const s=seedStore(),d=emptyImports(),t=publish(s),b=batch(s,d,t);assert.equal(b.counts.invalid,0);assert.throws(()=>approve(s,d,b,uploader),/上传者/);publish(s,'DEVICE','1.1.0');assert.equal(t.status,'RETIRED');assert.throws(()=>batch(s,d,t),/未发布/);approve(s,d,b);assert.equal(b.status,'COMMITTED');assert.equal(b.mappingBinding!.version,'1.0.0');verifyBatchMapping(s,b);
 const original=readFileSync('docs/upload-templates/devices.csv'),plain=createBatch(emptyImports(),seedStore(),{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'enterprise',...parseCsv(original.toString()),original,filename:'standard.csv',mime:'text/csv',sourceKind:'MANUAL_FILE'},uploader);
 assert.equal(plain.mappingBinding,undefined);assert.equal(plain.sourceHeaders,undefined);assert.equal(plain.snapshotDigest,digest(canonical({rows:plain.rows,templateVersion:'1.0.0',ruleVersion:'upload-rules-1.0.0',sourceSystem:'enterprise',dataType:'DEVICE'})));
});
test('mapping, rows, source headers, provenance and original template tampering fail closed',()=>{
 for(const mutate of [(b:any)=>b.rows[0].device_name='changed',(b:any)=>b.sourceHeaders[0]='changed',(b:any)=>b.lineNumbers[0]=100,(b:any)=>b.mappingBinding.mapping.columns[0].targetField='tenant_id',(b:any)=>b.mappingBinding.version='9.0.0',(b:any)=>b.fileSha256='changed']){const s=seedStore(),d=emptyImports(),b=batch(s,d,publish(s));mutate(b);assert.throws(()=>verifyMappedBatch(b));assert.throws(()=>approve(s,d,b));assert.equal(d.records.length,0);}
 const s=seedStore(),d=emptyImports(),t=publish(s),b=batch(s,d,t);t.manifest.importMapping={};assert.throws(()=>verifyBatchMapping(s,b));
 const s2=seedStore(),d2=emptyImports(),b2=batch(s2,d2,publish(s2));delete b2.mappingBinding;delete b2.sourceHeaders;assert.throws(()=>verifyBatchMapping(s2,b2),/接收审计/);assert.throws(()=>approve(s2,d2,b2));
});
test('mapped rows still enforce device fields, units and conditional requirements, errors retain original column',()=>{
 const s=seedStore(),d=emptyImports(),t=publish(s),b=batch(s,d,t);approve(s,d,b);
 for(const type of ['PRODUCTION','STATE_INTERVAL','MAINTENANCE','QUALITY','MEASUREMENT'] as DataType[]){const t=publish(s,type),b=batch(s,d,t,type);assert.equal(b.counts.invalid,0,type);approve(s,d,b);}
 const p=publish(s,'POINT_DEFINITION'),content='企业字段0,企业字段1,企业字段2,企业字段3,企业字段4,企业字段5,企业字段6\np,D-001,pressure,压力,MPa,10,0',parsed=parseCsv(content,true),bad=createBatch(d,s,{dataType:'POINT_DEFINITION',templateVersion:'1.0.0',sourceSystem:'enterprise',...parsed,original:Buffer.from(content),filename:'invalid.csv',mime:'text/csv',sourceKind:'MANUAL_FILE',mappingRef:ref(p)},uploader);assert.equal(bad.status,'VALIDATION_FAILED');assert.ok(bad.errors.some(e=>e.field==='max_value'&&e.sourceField==='企业字段6'));assert.throws(()=>approve(s,d,bad));
});
