import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {csv,csvParts} from './data-export.ts';
import {csvChunks,CsvManifest,csvChunkBytes} from './csv-chunks.ts';
import {memoryTask,resident} from './capacity.ts';
const rows=async function*(data:unknown[][]){yield*data;};
async function chunks(headers:string[],data:unknown[][]){const result:Buffer[]=[];for await(const chunk of csvChunks(headers,rows(data),()=>{}))result.push(chunk);return result;}
const integrity=(e:any)=>e.status===503&&e.code==='CSV_EXPORT_INTEGRITY';
test('incremental CSV bytes match legacy BOM, CRLF, formulas, quotes and Unicode at fragment boundaries',async()=>{
 const text='x'.repeat(8191)+'😀'+ '"'.repeat(8193)+'中\r\n文',data=[[text,' \t=1+1','@SUM(1)',-1.2,'-1.2',null,undefined,true,'\ud800','\udfff']];const result=await chunks(['a','b'],data);assert.deepEqual(Buffer.concat(result),Buffer.from(csv(['a','b'],data)));assert.ok(result.every(b=>b.length<=csvChunkBytes));assert.equal([...csvParts([text])].some(p=>p.length>16384),false);
});
test('fixed chunks and tiny digest manifest preserve a large file without retaining CSV bodies',async()=>{
 const data=Array.from({length:2000},(_,i)=>[i,'中文😀'+ '"'.repeat(90)]),result=await chunks(['n','text'],data),before=resident.snapshot().total;
 await memoryTask(async()=>{const manifest=new CsvManifest(4*1024*1024);try{for(const b of result)manifest.add(b);const summary=manifest.seal(data.length);assert.equal(summary.bytes,Buffer.concat(result).length);assert.equal(summary.sha256,createHash('sha256').update(Buffer.concat(result)).digest('hex'));assert.ok(result.slice(0,-1).every(b=>b.length===csvChunkBytes));assert.ok((resident.snapshot().categories.task||0)<=65536+result.length*512);for(const b of result)manifest.verify(b);manifest.finishDelivery(data.length);assert.throws(()=>manifest.finishDelivery(data.length),integrity);}finally{manifest.dispose();}},true);assert.equal(resident.snapshot().total,before);
});
test('manifest refuses changed, missing, extra or reordered blocks and wrong row totals',async()=>{
 const result=await chunks(['value'],Array.from({length:1000},(_,i)=>[String(i)+'x'.repeat(300)]));assert.ok(result.length>2);
 for(const mutate of [(a:Buffer[])=>a[1][0]^=1,(a:Buffer[])=>a.splice(1,1),(a:Buffer[])=>a.push(a.at(-1)!),(a:Buffer[])=>{const b=a[0];a[0]=a[1];a[1]=b;}]){const m=new CsvManifest(1024*1024);try{for(const b of result)m.add(b);m.seal(1000);const changed=result.map(b=>Buffer.from(b));mutate(changed);assert.throws(()=>{for(const b of changed)m.verify(b);m.finishDelivery(1000);},integrity);}finally{m.dispose();}}
 const m=new CsvManifest(1024*1024);try{for(const b of result)m.add(b);m.seal(1000);for(const b of result)m.verify(b);assert.throws(()=>m.finishDelivery(999),integrity);}finally{m.dispose();}
});
test('byte caps reject rather than truncate and cancellation unwinds the source iterator',async()=>{
 const m=new CsvManifest(10);assert.throws(()=>m.add(Buffer.alloc(11)),(e:any)=>e.status===422&&e.code==='CSV_EXPORT_BYTES_LIMIT');m.dispose();let closed=false,n=0;async function* source(){try{for(let i=0;i<10000;i++)yield ['x'.repeat(100)];}finally{closed=true;}}
 await assert.rejects(async()=>{for await(const _ of csvChunks(['x'],source(),()=>{if(++n>1000)throw Error('CANCEL');})){}},/CANCEL/);assert.equal(closed,true);
});
