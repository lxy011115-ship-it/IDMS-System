import type pg from 'pg';
import {httpCapacitySnapshot} from './request-capacity.ts';
import {limits,resident,workScheduler,sqlScheduler} from './capacity.ts';
import {probeNeed} from './runtime-probe-error.ts';
import type {RuntimeResources} from './runtime-resource-contract.ts';

function count(n:unknown):number {probeNeed(Number.isSafeInteger(n) && (n as number)>=0,'RESOURCE_CONTRACT_INVALID');return n as number;}
export function runtimeResources(pools:readonly pg.Pool[]):RuntimeResources {
  const http=httpCapacitySnapshot(),work=workScheduler.snapshot(),sql=sqlScheduler.snapshot();
  const ledger=resident.snapshot(),memory=process.memoryUsage();
  const aggregate={pools:count(pools.length),total:0,idle:0,waiting:0};
  for(const pool of pools){aggregate.total+=count(pool.totalCount);aggregate.idle+=count(pool.idleCount);aggregate.waiting+=count(pool.waitingCount);}
  const measured={rss:count(memory.rss),heapTotal:count(memory.heapTotal),heapUsed:count(memory.heapUsed),external:count(memory.external),arrayBuffers:count(memory.arrayBuffers)};
  const categories:Record<string,number>={};
  for(const name of ['task','bootstrap','cache','body','response'])categories[name]=count(ledger.categories[name] || 0);
  const saturated=http.active>=limits.http || work.active>=limits.workActive || sql.active>=limits.sqlActive || ledger.total>=limits.totalBytes || aggregate.waiting>0;
  return {format:1,source:'IDMS_MAIN_PROCESS',sampledAt:new Date().toISOString(),
    operatingSystemCapacityVerified:false,uptimeMs:count(Math.floor(process.uptime()*1000)),
    state:http.closing || work.closed || sql.closed ? 'CLOSING' : saturated?'SATURATED':'AVAILABLE',
    http:{active:count(http.active),limit:count(limits.http),closing:http.closing},
    work:{active:count(work.active),pending:count(work.pending),activeLimit:count(limits.workActive),pendingLimit:count(limits.workPending),closed:work.closed},
    sql:{active:count(sql.active),pending:count(sql.pending),activeLimit:count(limits.sqlActive),pendingLimit:count(limits.sqlPending),closed:sql.closed},
    ledger:{usedBytes:count(ledger.total),limitBytes:count(limits.totalBytes),categories},pools:aggregate,memory:measured};
}
