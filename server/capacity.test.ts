import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {capacityPolicy,MemoryLedger,FairScheduler,WeightedCache,estimatedBytes,memoryTask,accountValue,resident} from './capacity.ts';
const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>(ok=>resolve=ok),resolve:()=>resolve()};};
const delay=(ms:number)=>new Promise(ok=>setTimeout(ok,ms));
test('capacity policy rejects unknown, unbounded and inconsistent settings',()=>{
 for(const v of [{workActive:0},{waitMs:Infinity},{taskBytes:-1},{unknown:1},{tenantHttp:100},{cacheEntryBytes:9000000000},{tenantWorkPending:100}])assert.throws(()=>capacityPolicy(v));assert.equal(capacityPolicy({workActive:3}).workActive,3);
});
test('resource accounts enforce category and process totals and release exactly once',()=>{
 const ledger=new MemoryLedger(100,{task:80,cache:50}),a=ledger.account('task'),b=ledger.account('cache');a.grow(70);assert.throws(()=>a.grow(11));b.grow(30);assert.throws(()=>b.grow(1));a.release();a.release();assert.equal(ledger.snapshot().total,30);b.release();assert.equal(ledger.snapshot().total,0);assert.throws(()=>ledger.account('unknown'));
});
test('partial memory leases return evicted rows without returning other retained values',()=>{
 const ledger=new MemoryLedger(100,{task:100}),account=ledger.account('task');account.grow(10);const a=account.hold(30),b=account.hold(40);assert.equal(account.bytes,80);assert.throws(()=>account.hold(21));a();a();assert.equal(account.bytes,50);assert.equal(ledger.snapshot().total,50);account.hold(50);account.release();b();assert.equal(ledger.snapshot().total,0);assert.throws(()=>account.hold(1));
});

test('memory watermarks retain actual allocation peaks after release without counting refused growth',()=>{
 const ledger=new MemoryLedger(100,{task:80,cache:50}),a=ledger.account('task'),b=ledger.account('cache');a.grow(70);b.grow(30);assert.throws(()=>b.grow(1));a.release();b.grow(20);b.release();
 assert.deepEqual(ledger.snapshot(),{total:0,categories:{task:0,cache:0}});assert.deepEqual(ledger.watermarks(),{total:100,categories:{task:70,cache:50}});
 const external=ledger.watermarks();external.categories.task=999;assert.equal(ledger.watermarks().categories.task,70);
});
test('fair queue bounds active and pending work without head-of-line blocking another tenant',async()=>{
 const q=new FairScheduler({active:2,tenantActive:1,pending:2,tenantPending:1,waitMs:5000}),a=deferred(),b=deferred(),events:string[]=[];
 const first=q.run('a',async()=>{events.push('a1');await a.promise;}),next=q.run('a',async()=>{events.push('a2');});await assert.rejects(q.run('a',async()=>{}),e=>(e as any).status===429);
 const other=q.run('b',async()=>{events.push('b');await b.promise;});const third=q.run('c',async()=>{events.push('c');});await assert.rejects(q.run('d',async()=>{}),e=>(e as any).status===503);await delay(1);assert.deepEqual(events,['a1','b']);a.resolve();await first;await next;assert.ok(events.includes('c'));b.resolve();await Promise.all([other,third]);await q.drain();assert.deepEqual(q.snapshot(),{active:0,pending:0,closed:false});
});
test('cancelled and expired queued jobs never run; started work drains during close',async()=>{
 const q=new FairScheduler({active:1,tenantActive:1,pending:4,tenantPending:4,waitMs:20}),gate=deferred(),controller=new AbortController();let calls=0;
 const running=q.run('a',async()=>{await gate.promise;calls++;});const cancelled=q.run('a',async()=>{calls+=100;},controller.signal);controller.abort();await assert.rejects(cancelled,e=>(e as any).code==='REQUEST_CANCELLED');
 const expired=q.run('b',async()=>{calls+=100;}).catch(e=>e);await delay(30);assert.equal((await expired).code,'QUEUE_EXPIRED');const closing=q.close();await assert.rejects(q.run('c',async()=>{}),e=>(e as any).code==='CAPACITY_CLOSING');gate.resolve();await running;await closing;assert.equal(calls,1);assert.equal(q.snapshot().pending,0);
});
test('queued jobs preserve the submitting async context instead of the prior job context',async()=>{
 const q=new FairScheduler({active:1,tenantActive:1,pending:2,tenantPending:2,waitMs:5000}),context=new AsyncLocalStorage<string>(),gate=deferred();
 const a=context.run('request-a',()=>q.run('a',async()=>{await gate.promise;assert.equal(context.getStore(),'request-a');}));const b=context.run('request-b',()=>q.run('b',async()=>assert.equal(context.getStore(),'request-b')));gate.resolve();await Promise.all([a,b]);await q.drain();
});
test('weighted cache evicts LRU and idle entries, skips oversized entries and returns budget',async()=>{
 const ledger=new MemoryLedger(1000,{cache:500}),cache=new WeightedCache<string,number>({entries:2,bytes:300,entryBytes:150,idleMs:20},ledger);
 cache.set('a',1,100);cache.set('b',2,100);assert.equal(cache.get('a'),1);cache.set('c',3,100);assert.equal(cache.get('b'),undefined);assert.equal(cache.set('huge',4,151),false);assert.equal(ledger.snapshot().total,200);await delay(30);assert.equal(cache.snapshot().entries,0);assert.equal(ledger.snapshot().total,0);cache.clear();
});
test('workspace accounting estimates aliases conservatively and releases memory after failure',async()=>{
 const shared={s:'x'.repeat(100)};assert.ok(estimatedBytes({a:shared,b:shared})<estimatedBytes({a:{...shared},b:{...shared}}));const before=resident.snapshot().total;await assert.rejects(memoryTask(async()=>{accountValue(shared);throw Error('rollback');},true),/rollback/);assert.equal(resident.snapshot().total,before);
});
