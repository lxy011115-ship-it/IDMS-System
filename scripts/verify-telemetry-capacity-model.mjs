import assert from 'node:assert/strict';
import {safeCount,assertQueue,summarizeCapacity} from './telemetry-capacity-model.mjs';
import {capacityArguments} from './telemetry-capacity.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const sample=(elapsedMs,sequence,ack,rows,allocated)=>({elapsedMs,queue:{sequence,acknowledged:ack,pending:sequence-ack,rejected:0},pg:{tables:Object.fromEntries(['telemetry_points','telemetry_receipts','audit_ledger'].map(t=>[t,{rows,rowValueBytes:rows*100,totalBytes:allocated,heapBytes:allocated/2,indexBytes:allocated/2}])),databaseBytes:allocated,sampleMs:20},core:{pid:1,createdAt:'same',cpuSeconds:elapsedMs/1000}});
const first=sample(0,100,10,10,1000),last=sample(100000,120,50,50,5000),report=summarizeCapacity([first,last]);
assert.equal(report.seconds,100);assert.equal(report.pendingNetReduction,20);assert.equal(report.currentWindowLinearDrainScenarioSeconds,350);assert.equal(report.rowValueBytesPerNewPoint,300);assert.equal(report.acknowledged,40);assert.equal(report.captured,20);assert.equal(report.coreCpuSeconds,100);
const growth=sample(100000,200,20,20,500);assert.equal(summarizeCapacity([first,growth]).currentWindowLinearDrainScenarioSeconds,null);assert.equal(summarizeCapacity([first,growth]).dailyAllocatedGrowthAtCurrentWindowBytes,null);
const idle=sample(100000,100,10,10,1000);assert.equal(summarizeCapacity([first,idle]).rowValueBytesPerNewPoint,null);
for(const mutate of [s=>s.elapsedMs=0,s=>s.queue.acknowledged=5,s=>s.queue.sequence=99,s=>s.pg.tables.audit_ledger.rows=1,s=>s.core.cpuSeconds=-1,s=>s.core.createdAt='other']){const s=structuredClone(last);mutate(s);assert.throws(()=>summarizeCapacity([first,s]));}
for(const value of [null,undefined,true,'','1.2','-1',-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>safeCount(value));assert.equal(safeCount('123'),123);assert.throws(()=>assertQueue({pending:1,rejected:1,acknowledged:1,sequence:4}));
const args=['--business-config','business','--edge-config','edge','--tenant','sandbox','--edge','one','--out','result'];assert.equal(capacityArguments(args).seconds,300);assert.throws(()=>capacityArguments([...args,'--unknown','x']));assert.throws(()=>capacityArguments([...args,'--seconds','4']));assert.throws(()=>capacityArguments([...args,'--tenant','again']));
if(process.platform==='win32'){
 const exec=promisify(execFile),created=(await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').CreationDate.ToString('o')`],{windowsHide:true})).stdout.trim(),args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/telemetry-capacity-process.ps1'),'-TargetProcess',String(process.pid),'-ExpectedCreatedAt'];
 const own=JSON.parse((await exec('powershell.exe',[...args,created],{windowsHide:true})).stdout);assert.equal(own.pid,process.pid);assert.ok(own.cpuSeconds>=0&&own.workingSetBytes>0);
 await assert.rejects(exec('powershell.exe',[...args,'2000-01-01T00:00:00+00:00'],{windowsHide:true}));
}
console.log('Verified capacity growth/idle/backlog/negative physical allocation scenarios, unsafe counter/clock/process changes, real own-process birth binding/refusal, strict CLI parsing and explicit non-SLA scope.');
