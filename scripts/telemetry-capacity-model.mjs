import assert from 'node:assert/strict';
export function safeCount(value){assert.ok(typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value),'Invalid capacity counter type');const n=Number(value);assert.ok(Number.isSafeInteger(n)&&n>=0,'Invalid capacity counter');return n;}
export function assertQueue(queue){for(const key of ['pending','rejected','acknowledged','sequence'])assert.ok(typeof queue[key]==='number'&&safeCount(queue[key])===queue[key]);assert.equal(queue.pending+queue.rejected+queue.acknowledged,queue.sequence,'Queue conservation failed');}
export function summarizeCapacity(samples){
 assert.ok(samples.length>=2,'At least two samples required');
 for(let i=0;i<samples.length;i++){
  const s=samples[i];assertQueue(s.queue);assert.ok(Number.isFinite(s.elapsedMs)&&s.elapsedMs>=0);
  if(i){const p=samples[i-1];assert.ok(s.elapsedMs>p.elapsedMs,'Non-monotonic observation clock');for(const k of ['sequence','acknowledged'])assert.ok(s.queue[k]>=p.queue[k],'Queue counter reversed');for(const table of ['telemetry_points','telemetry_receipts','audit_ledger'])assert.ok(s.pg.tables[table].rows>=p.pg.tables[table].rows,'SQL row count reversed');if(p.core||s.core){assert.ok(p.core&&s.core);assert.equal(s.core.pid,p.core.pid);assert.equal(s.core.createdAt,p.core.createdAt);assert.ok(s.core.cpuSeconds>=p.core.cpuSeconds,'Process CPU counter reversed');}}
 }
 const first=samples[0],last=samples.at(-1),seconds=(last.elapsedMs-first.elapsedMs)/1000,delta=(a,b)=>b-a,rate=n=>n/seconds;
 const rows={};for(const table of ['telemetry_points','telemetry_receipts','audit_ledger']){
  const a=first.pg.tables[table],b=last.pg.tables[table];rows[table]={rowsAdded:delta(a.rows,b.rows),rowValueBytesAdded:delta(a.rowValueBytes,b.rowValueBytes),allocatedBytesAdded:delta(a.totalBytes,b.totalBytes),lastHeapBytes:b.heapBytes,lastIndexBytes:b.indexBytes,lastTotalBytes:b.totalBytes,rowsPerSecond:rate(b.rows-a.rows)};
 }
 const points=rows.telemetry_points.rowsAdded,netReduction=first.queue.pending-last.queue.pending,physical=last.pg.databaseBytes-first.pg.databaseBytes;
 return {format:'idms-telemetry-capacity-report-v1',verifiedAt:new Date().toISOString(),sampleCount:samples.length,seconds,first,last,tables:rows,
  captured:last.queue.sequence-first.queue.sequence,acknowledged:last.queue.acknowledged-first.queue.acknowledged,pendingNetReduction:netReduction,
  currentWindowLinearDrainScenarioSeconds:netReduction>0?last.queue.pending/rate(netReduction):null,
  rowValueBytesPerNewPoint:points>0?Object.values(rows).reduce((sum,t)=>sum+t.rowValueBytesAdded,0)/points:null,
  databaseAllocatedBytesDelta:physical,databaseAllocatedGrowthBytesPerSecond:rate(physical),
  dailyAllocatedGrowthAtCurrentWindowBytes:physical>0?rate(physical)*86400:null,
  coreCpuSeconds:first.core&&last.core?(last.core.cpuSeconds-first.core.cpuSeconds):null,
  diagnosticPgSampleMs:{max:Math.max(...samples.map(s=>s.pg.sampleMs)),mean:samples.reduce((n,s)=>n+s.pg.sampleMs,0)/samples.length},
  logicalCountsSharePgSnapshot:true,physicalSizesAreNonMvccObservations:true,crossStoreSnapshotsAreNotAtomic:true,auditGrowthIncludesOtherBusiness:true,
  linearScenariosAreNotCapacityGuarantees:true,retentionDeletionAuthorizedByThisReport:false,productionCapacityOrSlaAcceptance:false,productionAcceptance:false};
}
