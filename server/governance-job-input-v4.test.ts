import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeGovernanceJobInputV4 as normalize} from './governance-job-input-v4.ts';
test('public JSON freezes server-generated original and rejects trusted parser/AI fields',async()=>{
 const rows=[{source_record_id:'中😀',n:1}],c=await normalize({action:'IMPORT_CREATE',input:{dataType:'DEVICE',rows}});assert.deepEqual(JSON.parse(Buffer.from(c.input.originalBase64 as string,'base64').toString()),rows);assert.equal(c.input.sourceKind,'API_JSON');assert.deepEqual(c.input.lineNumbers,[2]);for(const name of ['originalBase64','aiMode','sourceHeaders','lineNumbers','context'])await assert.rejects(()=>normalize({action:'IMPORT_CREATE',input:{rows,[name]:'forged'}}),/PUBLIC_FIELDS/);
});
test('public CSV preserves exact UTF-8 bytes and physical lines',async()=>{
 const original=Buffer.from('\uFEFFsource_record_id,device_code\r\nx,"A\nB"\r\n'),c=await normalize({action:'IMPORT_CREATE',input:{file:{filename:'设备.csv',base64:original.toString('base64')}}});assert.equal(c.input.originalBase64,original.toString('base64'));assert.deepEqual(c.input.lineNumbers,[2]);assert.equal((c.input.rows as any[])[0].device_code,'A\nB');await assert.rejects(()=>normalize({action:'IMPORT_CREATE',input:{file:{filename:'x.csv',base64:'***'}}}),/FILE_BYTES/);
});
test('workbook rejects formulas and keeps source bytes and row numbers',async()=>{
 const {default:ExcelJS}=await import('exceljs'),w=new ExcelJS.Workbook(),s=w.addWorksheet('data');s.addRow(['source_record_id','device_code']);s.addRow(['x','D']);const b=Buffer.from(await w.xlsx.writeBuffer()),c=await normalize({action:'IMPORT_CREATE',input:{file:{filename:'x.xlsx',base64:b.toString('base64')}}});assert.equal(c.input.originalBase64,b.toString('base64'));assert.deepEqual(c.input.lineNumbers,[2]);s.getCell('B2').value={formula:'1+1',result:2};await assert.rejects(()=>w.xlsx.writeBuffer().then(b=>normalize({action:'IMPORT_CREATE',input:{file:{filename:'x.xlsx',base64:Buffer.from(b).toString('base64')}}})),/公式/);
});
