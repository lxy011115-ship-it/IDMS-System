import {readFileSync} from 'node:fs';
import {AsyncLocalStorage,AsyncResource} from 'node:async_hooks';
import {DomainError} from './service.ts';

const MiB=1024*1024;
export const defaultCapacity={http:64,tenantHttp:32,bodyBytes:512*MiB,jsonParseBytes:8*MiB,fileParseBytes:416*MiB,bodyTimeoutMs:15000,exportPrepareMs:120000,exportSendMs:300000,responseBytes:256*MiB,workActive:2,workPending:32,tenantWorkPending:16,sqlActive:4,tenantSqlActive:2,sqlPending:32,tenantSqlPending:16,waitMs:30000,taskBytes:512*MiB,taskTotalBytes:1024*MiB,bootstrapBytes:512*MiB,cacheBytes:256*MiB,cacheEntryBytes:128*MiB,cacheEntries:16,cacheIdleMs:60000,totalBytes:2048*MiB};
export type CapacityPolicy=typeof defaultCapacity;
export function capacityPolicy(input:unknown={}):CapacityPolicy{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaultCapacity,k)))throw Error('Invalid capacity policy fields');
 const value={...defaultCapacity,...input};for(const [key,n]of Object.entries(value)){const max=key.endsWith('Bytes')?32*1024*MiB:key.endsWith('Ms')?300000:4096;if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('Invalid positive capacity limit: '+key);}
 if(value.tenantHttp>value.http||value.tenantWorkPending>value.workPending||value.tenantSqlPending>value.sqlPending||value.tenantSqlActive>value.sqlActive||value.taskBytes>value.taskTotalBytes||value.taskTotalBytes>value.totalBytes||value.fileParseBytes>value.bodyBytes||value.jsonParseBytes>value.bodyBytes||value.cacheEntryBytes>value.cacheBytes||[value.bootstrapBytes,value.bodyBytes,value.responseBytes,value.cacheBytes].some(n=>n>value.totalBytes))throw Error('Inconsistent capacity policy');return value;
}
function configured(){const file=process.env.IDMS_CAPACITY_CONFIG;if(!file)return capacityPolicy();const raw=readFileSync(file);if(raw.length>65536)throw Error('Capacity policy file is too large');return capacityPolicy(JSON.parse(raw.toString('utf8')));}
export const limits=configured();
export class CapacityError extends DomainError {
 code:string;retryAfter=1;
 constructor(status=503,message='当前处理容量已满，请稍后使用同一幂等键重试',code='CAPACITY_BUSY'){super(status,message);this.code=code;}
}
export class MemoryLedger {
 private used=new Map<string,number>();private total=0;private peak=0;private peaks=new Map<string,number>();readonly cap:number;readonly categories:Record<string,number>;
 constructor(cap:number,categories:Record<string,number>){this.cap=cap;this.categories=categories;}
 account(category:string,maximum=this.categories[category]){
  if(!Object.hasOwn(this.categories,category)||!Number.isSafeInteger(maximum)||maximum<1)throw Error('Unknown resource category');
  let amount=0,released=false;const ledger=this;
  const grow=(bytes:number)=>{if(released||!Number.isSafeInteger(bytes)||bytes<0)throw Error('Invalid resource accounting');if(amount+bytes>maximum||ledger.total+bytes>ledger.cap||(ledger.used.get(category)||0)+bytes>ledger.categories[category])throw new CapacityError(503,'当前工作区或解析预算不足，请稍后重试或联系管理员调整容量','MEMORY_BUDGET');amount+=bytes;ledger.total+=bytes;ledger.used.set(category,(ledger.used.get(category)||0)+bytes);ledger.peak=Math.max(ledger.peak,ledger.total);ledger.peaks.set(category,Math.max(ledger.peaks.get(category)||0,ledger.used.get(category)||0));};
  const shrink=(bytes:number)=>{if(released)return;amount-=bytes;ledger.total-=bytes;ledger.used.set(category,(ledger.used.get(category)||0)-bytes);};
  return {grow,hold(bytes:number){grow(bytes);let held=true;return ()=>{if(!held)return;held=false;shrink(bytes);};},lease(){
   // One aggregate lease avoids a retained closure for every SQL row. Transfer
   // changes only this owner's charge, synchronously, into task-owned memory.
   let bytes=0,active=true;
   return {grow(n:number){if(!active)throw Error('Memory lease is closed');grow(n);bytes+=n;},transfer(n:number){if(!active||released||!Number.isSafeInteger(n)||n<0)throw Error('Invalid memory lease transfer');if(n>bytes)grow(n-bytes);else shrink(bytes-n);bytes=0;active=false;},release(){if(!active)return;active=false;shrink(bytes);bytes=0;}};
  },release(){if(released)return;released=true;ledger.total-=amount;ledger.used.set(category,(ledger.used.get(category)||0)-amount);amount=0;},get bytes(){return amount;}};

 }
 snapshot(){return {total:this.total,categories:Object.fromEntries(this.used)};}
 /** Monotonic since-process-start accounting, separate from sampled process RSS. */
 watermarks(){return {total:this.peak,categories:Object.fromEntries(this.peaks)};}
}
export const resident=new MemoryLedger(limits.totalBytes,{task:limits.taskTotalBytes,bootstrap:limits.bootstrapBytes,cache:limits.cacheBytes,body:limits.bodyBytes,response:limits.responseBytes});
type Account=ReturnType<MemoryLedger['account']>;
const memoryContext=new AsyncLocalStorage<Account>();
export function estimatedBytes(value:unknown):number{
 const seen=new WeakSet<object>();let bytes=0;
 function visit(item:unknown,depth:number){if(depth>512)throw new CapacityError(503,'工作区嵌套过深，超出当前处理预算','MEMORY_BUDGET');if(typeof item==='string'){bytes+=16+item.length*2;return;}if(!item||typeof item!=='object'){bytes+=8;return;}if(seen.has(item))return;seen.add(item);bytes+=64;if(item instanceof Map){bytes+=item.size*24;for(const [k,v]of item){visit(k,depth+1);visit(v,depth+1);}}else if(Array.isArray(item)){bytes+=item.length*8;for(const entry of item)visit(entry,depth+1);}else for(const key of Object.keys(item)){bytes+=24+key.length*2;visit((item as any)[key],depth+1);}}
 visit(value,0);if(!Number.isSafeInteger(bytes))throw new CapacityError();return bytes;
}
export function holdValue(value:unknown):()=>void{const account=memoryContext.getStore();return account?account.hold(estimatedBytes(value)):()=>{};}
export function holdAllocation(bytes:number):()=>void{return memoryContext.getStore()?.hold(bytes)||(()=>{});}
export function temporaryAllocation(){return memoryContext.getStore()?.lease()||{grow(_bytes:number){},transfer(_bytes:number){},release(){}};}
export function accountAllocation(bytes:number){memoryContext.getStore()?.grow(bytes);}
export function accountValue(value:unknown){const account=memoryContext.getStore();if(account)account.grow(estimatedBytes(value));}
export async function memoryTask<T>(task:()=>Promise<T>,independent=false):Promise<T>{if(!independent&&memoryContext.getStore())return task();const account=resident.account('task',limits.taskBytes);try{account.grow(65536);return await memoryContext.run(account,task);}finally{account.release();}}
const bootstrapAccounts=new WeakMap<object,Account>(),bootstrapFinalizer=new FinalizationRegistry<Account>(account=>account.release());
export function registerBootstrap(owner:object,value:unknown){const next=resident.account('bootstrap');try{next.grow(estimatedBytes(value));}catch(e){next.release();throw e;}bootstrapAccounts.get(owner)?.release();bootstrapFinalizer.unregister(owner);bootstrapAccounts.set(owner,next);bootstrapFinalizer.register(owner,next,owner);}

interface Pending<T=unknown>{tenant:string;task:()=>Promise<T>;resolve:(value:T)=>void;reject:(error:unknown)=>void;timer?:ReturnType<typeof setTimeout>;signal?:AbortSignal;abort?:()=>void}
export class FairScheduler {
 private pending:Pending<any>[]=[];private active=0;private byTenant=new Map<string,number>();private closed=false;private idle=new Set<()=>void>();
 readonly options:{active:number;tenantActive:number;pending:number;tenantPending:number;waitMs:number};
 constructor(options:FairScheduler['options']){this.options=options;}
 run<T>(tenant:string,task:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(this.closed)return Promise.reject(new CapacityError(503,'服务正在排空，请稍后重试','CAPACITY_CLOSING'));if(signal?.aborted)return Promise.reject(new CapacityError(499,'请求已取消，任务尚未开始','REQUEST_CANCELLED'));
  return new Promise<T>((resolve,reject)=>{
   const entry:Pending<T>={tenant,task:AsyncResource.bind(task),resolve,reject,signal};
   if(this.active<this.options.active&&(this.byTenant.get(tenant)||0)<this.options.tenantActive&&!this.pending.some(e=>e.tenant===tenant)){this.start(entry);return;}
   if(this.pending.filter(e=>e.tenant===tenant).length>=this.options.tenantPending){reject(new CapacityError(429,'当前企业等待任务已满，请稍后使用同一幂等键重试'));return;}
   if(this.pending.length>=this.options.pending){reject(new CapacityError());return;}
   const remove=(error:unknown)=>{const index=this.pending.indexOf(entry);if(index<0)return;this.pending.splice(index,1);this.cleanup(entry);reject(error);this.pump();};
   entry.timer=setTimeout(()=>remove(new CapacityError(503,'等待超时，任务尚未开始，请稍后重试','QUEUE_EXPIRED')),this.options.waitMs);entry.timer.unref?.();
   entry.abort=()=>remove(new CapacityError(499,'请求已取消，任务尚未开始','REQUEST_CANCELLED'));signal?.addEventListener('abort',entry.abort,{once:true});this.pending.push(entry);if(signal?.aborted)entry.abort();else this.pump();
  });
 }
 private cleanup(entry:Pending<any>){if(entry.timer)clearTimeout(entry.timer);if(entry.abort)entry.signal?.removeEventListener('abort',entry.abort);}
 private start(entry:Pending<any>){this.cleanup(entry);this.active++;this.byTenant.set(entry.tenant,(this.byTenant.get(entry.tenant)||0)+1);const finish=(ok:boolean,value:unknown)=>{this.active--;const n=(this.byTenant.get(entry.tenant)||1)-1;if(n)this.byTenant.set(entry.tenant,n);else this.byTenant.delete(entry.tenant);this.pump();ok?entry.resolve(value):entry.reject(value);};void Promise.resolve().then(()=>{if(entry.signal?.aborted)throw new CapacityError(499,'请求已取消，任务尚未开始','REQUEST_CANCELLED');return entry.task();}).then(value=>finish(true,value),error=>finish(false,error));}
 private pump(){while(this.active<this.options.active){const index=this.pending.findIndex(e=>(this.byTenant.get(e.tenant)||0)<this.options.tenantActive);if(index<0)break;const [entry]=this.pending.splice(index,1);this.start(entry);}if(!this.active&&!this.pending.length){for(const done of this.idle)done();this.idle.clear();}}
 close(){this.closed=true;return this.drain();}
 drain():Promise<void>{return this.active||this.pending.length?new Promise(done=>this.idle.add(done)):Promise.resolve();}
 snapshot(){return {active:this.active,pending:this.pending.length,closed:this.closed};}
}
export const workScheduler=new FairScheduler({active:limits.workActive,tenantActive:1,pending:limits.workPending,tenantPending:limits.tenantWorkPending,waitMs:limits.waitMs});
export const sqlScheduler=new FairScheduler({active:limits.sqlActive,tenantActive:limits.tenantSqlActive,pending:limits.sqlPending,tenantPending:limits.tenantSqlPending,waitMs:limits.waitMs});
interface RequestResources {signal:AbortSignal;reserveBody:(file:boolean)=>void;reserveOutput:(bytes:number)=>void;reserveStreamOutput?:(bytes:number,window:number)=>void;prepareResult:(value:unknown)=>void;bindTenant:(tenant:string)=>void}
export const requestResources=new AsyncLocalStorage<RequestResources>();
export function requestSignal(){return requestResources.getStore()?.signal;}

export class WeightedCache<K,V> {
 private entries=new Map<K,{value:V;bytes:number;seen:number;account:Account}>();private timer?:ReturnType<typeof setTimeout>;private bytes=0;
 readonly policy:{entries:number;bytes:number;entryBytes:number;idleMs:number};readonly ledger:MemoryLedger;
 constructor(policy:WeightedCache<K,V>['policy'],ledger=resident){this.policy=policy;this.ledger=ledger;}
 get(key:K){const entry=this.entries.get(key);if(!entry)return;if(Date.now()-entry.seen>=this.policy.idleMs){this.delete(key);return;}entry.seen=Date.now();this.entries.delete(key);this.entries.set(key,entry);this.schedule();return entry.value;}
 set(key:K,value:V,bytes=estimatedBytes(value)){this.delete(key);if(bytes>this.policy.entryBytes||bytes>this.policy.bytes)return false;while(this.entries.size&&(this.entries.size>=this.policy.entries||this.bytes+bytes>this.policy.bytes))this.delete(this.entries.keys().next().value!);const account=this.ledger.account('cache');try{account.grow(bytes);}catch{account.release();return false;}this.entries.set(key,{value,bytes,seen:Date.now(),account});this.bytes+=bytes;this.schedule();return true;}
 delete(key:K){const entry=this.entries.get(key);if(!entry)return false;entry.account.release();this.bytes-=entry.bytes;this.entries.delete(key);if(!this.entries.size&&this.timer){clearTimeout(this.timer);this.timer=undefined;}return true;}
 private schedule(){if(this.timer)clearTimeout(this.timer);if(!this.entries.size){this.timer=undefined;return;}const due=Math.min(...[...this.entries.values()].map(e=>e.seen+this.policy.idleMs));this.timer=setTimeout(()=>{this.timer=undefined;for(const [key,entry]of this.entries)if(Date.now()-entry.seen>=this.policy.idleMs)this.delete(key);this.schedule();},Math.max(1,due-Date.now()));this.timer.unref?.();}
 clear(){for(const key of this.entries.keys())this.delete(key);}
 snapshot(){return {entries:this.entries.size,bytes:this.bytes};}
}
