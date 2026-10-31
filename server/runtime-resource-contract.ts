import {RuntimeProbeError,probeNeed} from './runtime-probe-error.ts';
function count(n:unknown):number {probeNeed(Number.isSafeInteger(n) && (n as number)>=0,'RESOURCE_CONTRACT_INVALID');return n as number;}
export interface RuntimeResources {
 format:1;source:'IDMS_MAIN_PROCESS';sampledAt:string;operatingSystemCapacityVerified:false;uptimeMs:number;state:'AVAILABLE'|'SATURATED'|'CLOSING';
 http:{active:number;limit:number;closing:boolean};
 work:{active:number;pending:number;activeLimit:number;pendingLimit:number;closed:boolean};
 sql:{active:number;pending:number;activeLimit:number;pendingLimit:number;closed:boolean};
 ledger:{usedBytes:number;limitBytes:number;categories:Record<string,number>};
 pools:{pools:number;total:number;idle:number;waiting:number};
 memory:{rss:number;heapTotal:number;heapUsed:number;external:number;arrayBuffers:number};
}
/** Strict receiving contract: copy known numeric/boolean fields, never forward arbitrary server data. */
export function validateRuntimeResources(value:any):RuntimeResources {
  try {
    probeNeed(value?.format===1 && value.source==='IDMS_MAIN_PROCESS' && value.operatingSystemCapacityVerified===false
      && typeof value.sampledAt==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.sampledAt) && Number.isFinite(Date.parse(value.sampledAt))
      && ['AVAILABLE','SATURATED','CLOSING'].includes(value.state),'RESOURCE_CONTRACT_INVALID');
    const numbers=<K extends string>(v:any,names:K[]):Record<K,number>=>Object.fromEntries(names.map(k=>[k,count(v?.[k])])) as Record<K,number>;
    const bool=(v:any)=>{probeNeed(typeof v==='boolean','RESOURCE_CONTRACT_INVALID');return v;};
    const result={format:1,source:'IDMS_MAIN_PROCESS',sampledAt:value.sampledAt,operatingSystemCapacityVerified:false,
      uptimeMs:count(value.uptimeMs),state:value.state,
      http:{...numbers(value.http,['active','limit']),closing:bool(value.http?.closing)},
      work:{...numbers(value.work,['active','pending','activeLimit','pendingLimit']),closed:bool(value.work?.closed)},
      sql:{...numbers(value.sql,['active','pending','activeLimit','pendingLimit']),closed:bool(value.sql?.closed)},
      ledger:{...numbers(value.ledger,['usedBytes','limitBytes']),categories:numbers(value.ledger?.categories,['task','bootstrap','cache','body','response'])},
      pools:numbers(value.pools,['pools','total','idle','waiting']),memory:numbers(value.memory,['rss','heapTotal','heapUsed','external','arrayBuffers'])};
    probeNeed(result.http.limit>0 && result.work.activeLimit>0 && result.work.pendingLimit>0 && result.sql.activeLimit>0
      && result.sql.pendingLimit>0 && result.ledger.limitBytes>0 && result.pools.idle<=result.pools.total,'RESOURCE_CONTRACT_INVALID');
    const closing=result.http.closing||result.work.closed||result.sql.closed;
    const saturated=result.http.active>=result.http.limit||result.work.active>=result.work.activeLimit||result.sql.active>=result.sql.activeLimit||result.ledger.usedBytes>=result.ledger.limitBytes||result.pools.waiting>0;
    probeNeed(result.state===(closing?'CLOSING':saturated?'SATURATED':'AVAILABLE'),'RESOURCE_CONTRACT_INVALID');
    return result as RuntimeResources;
  } catch {throw new RuntimeProbeError('RESOURCE_CONTRACT_INVALID');}
}
