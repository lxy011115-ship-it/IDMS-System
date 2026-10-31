import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {RuntimeReadiness,readinessPolicy,readinessComponents} from '../server/runtime-readiness.ts';
import {runtimeStatusRoutes} from '../server/runtime-status-route.ts';
import {runtimeResources} from '../server/runtime-resources.ts';
import {beginHttpResponse} from '../server/http-boundary.ts';
import {resident,workScheduler} from '../server/capacity.ts';
import {RuntimeProbeError} from '../server/runtime-probe-error.ts';
import {validateRuntimeResources} from '../server/runtime-resource-contract.ts';

const policy=()=>({format:1,enabled:true,required:[...readinessComponents],optional:[],intervalMs:1000,budgetMs:200,probeMs:100,maxAgeMs:1000});
const good=()=>({status:'PASS',code:'CHECK_PASSED',evidence:'ISOLATED_TEST'});
const tasks=fn=>Object.fromEntries(readinessComponents.map(id=>[id,ctx=>fn(id,ctx)]));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
async function http(run,handler){const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{return await run('http://127.0.0.1:'+s.address().port);}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}}

test('strict policy never silently omits components or enables a file demo',async()=>{
 const p=policy();for(const patch of [{required:['business','sessions','identity'],optional:[]},{required:readinessComponents,optional:['ai']},{budgetMs:1000},{probeMs:201},{extra:true}])assert.throws(()=>readinessPolicy({...p,...patch}));
 let called=0;for(const enabled of [null,{...p,enabled:false}]){const m=new RuntimeReadiness(enabled,tasks(()=>{called++;return good();}));m.start();await m.refresh();assert.equal(m.view().ready,false);await m.close();}assert.equal(called,0);
 for(const result of [{status:'PASS',code:'DATABASE_UNAVAILABLE',evidence:'QA'},{status:'UNKNOWN',code:'CHECK_PASSED',evidence:'QA'}]){const invalid=new RuntimeReadiness(p,tasks(async()=>result));await invalid.refresh();assert.equal(invalid.view().ready,false);await invalid.close();}
 const demo=new RuntimeReadiness(p,tasks(good),{enterprise:false});await demo.refresh();assert.equal(demo.view().detail.reason,'NOT_CONFIGURED');await demo.close();
});

test('freshness starts before probing, survives wall-clock jumps, and closing invalidates synchronously',async()=>{
 let now=100,wall='2026-10-31T01:00:00Z';const m=new RuntimeReadiness(policy(),tasks(async()=>{now+=10;return good();}),{now:()=>now,wall:()=>wall});
 assert.equal(m.view().detail.reason,'WARMING');await m.refresh();assert.equal(m.view().ready,true);assert.equal(m.view().publicResult.ageMs,70);
 wall='2020-01-01T00:00:00Z';assert.equal(m.view().ready,true);now=1101;assert.equal(m.view().detail.reason,'STALE');
 await m.refresh();assert.equal(m.view().ready,true);m.beginClose();assert.equal(m.view().detail.reason,'CLOSING');assert.equal(m.view().ready,false);await m.close();
});

test('a newly confirmed required failure withdraws old success before the rest of the cycle settles',async()=>{
 let phase=0;const hold=deferred(),failed=deferred();
 const m=new RuntimeReadiness({...policy(),budgetMs:800,probeMs:100},tasks(async id=>{
  if(phase===1){if(id==='business'){failed.resolve();return {status:'FAIL',code:'DATABASE_UNAVAILABLE',evidence:'NOT_ESTABLISHED'};}await hold.promise;}return good();
 }));
 await m.refresh();assert.equal(m.view().ready,true);phase=1;const running=m.refresh();await failed.promise;await Promise.resolve();assert.equal(m.view().ready,false);assert.equal(m.view().detail.running,true);
 hold.resolve();await running;assert.equal(m.view().ready,false);phase=2;await m.refresh();assert.equal(m.view().ready,true);await m.close();
});

test('optional failures stay visible and arbitrary error details never reach status snapshots',async()=>{
 const secret=randomBytes(30).toString('base64url'),p=policy();p.required=['business','sessions','identity'];p.optional=readinessComponents.filter(x=>!p.required.includes(x));
 const m=new RuntimeReadiness(p,tasks(async id=>{if(id==='ai')throw Error('postgres://'+secret);return good();}));await m.refresh();const v=m.view();assert.equal(v.ready,true);assert.equal(v.detail.rows.find(r=>r.component==='ai').status,'UNKNOWN');assert(!JSON.stringify(v).includes(secret));await m.close();
});

test('observation expiry waits original cleanup, shares refresh, and never publishes late green',async()=>{
 let active=0,peak=0,started=0,settled=0;
 const m=new RuntimeReadiness({...policy(),budgetMs:100,probeMs:50},tasks(async(id,{signal})=>{
  active++;started++;peak=Math.max(peak,active);await new Promise(r=>signal.addEventListener('abort',()=>setTimeout(r,70),{once:true}));active--;settled++;return good();
 }));
 const at=performance.now(),first=m.refresh();assert.equal(m.refresh(),first);await first;assert(performance.now()-at>=160);assert.equal(started,2);assert.equal(settled,2);assert.equal(peak,2);assert.equal(m.view().ready,false);assert.equal(m.view().detail.rows[0].code,'OBSERVATION_TIMEOUT');await m.close();
});

test('real HTTP routes enforce methods/authentication and polling only reads snapshots',async()=>{
 let probes=0,measurements=0;const token=randomBytes(32).toString('base64url'),m=new RuntimeReadiness(policy(),tasks(async()=>{probes++;return good();}));await m.refresh();
 const handle=runtimeStatusRoutes(m,()=>{measurements++;return {...runtimeResources([]),secret:token};},token);
 await http(async base=>{
  const get=async(path,init={})=>{const r=await fetch(base+path,init);const text=await r.text();assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert(!text.includes(token));return {r,data:text?JSON.parse(text):null};};
  assert.equal((await get('/api/v1/ready')).r.status,200);
  const head=await get('/api/v1/ready',{method:'HEAD'});assert.equal(head.r.status,200);assert.equal(head.data,null);
  assert.equal((await get('/api/v1/ready?refresh=1')).r.status,400);assert.equal((await get('/api/v1/ready',{method:'POST',body:'x'})).r.status,405);
  assert.equal((await get('/api/v1/runtime/status')).r.status,401);
  for(const extra of [{Origin:base},{Cookie:'session=qa'},{Authorization:'Bearer wrong','X-Forwarded-For':'127.0.0.1'}])assert.equal((await get('/api/v1/runtime/status',{headers:{Authorization:'Bearer '+token,...extra}})).r.status,401);
  const authed=await get('/api/v1/runtime/status',{headers:{Authorization:'Bearer '+token}});assert.equal(authed.r.status,200);assert.equal(authed.data.resources.source,'IDMS_MAIN_PROCESS');assert.equal(authed.data.resources.secret,undefined);assert.equal(measurements,1);const privateHead=await get('/api/v1/runtime/status',{method:'HEAD',headers:{Authorization:'Bearer '+token}});assert.equal(privateHead.r.status,200);assert.equal(privateHead.data,null);assert.equal(measurements,2);
  await Promise.all(Array.from({length:40},()=>get('/api/v1/ready')));assert.equal(probes,7);m.beginClose();assert.equal((await get('/api/v1/ready')).r.status,503);
 },(req,res)=>{beginHttpResponse(res);handle(req,res,new URL(req.url,'http://127.0.0.1'));});
 await m.close();assert.equal(resident.snapshot().categories.response||0,0);
});

test('close withdraws readiness before awaiting original in-flight cleanup and cannot restart the monitor',async()=>{
 let started=0,settled=0;
 const m=new RuntimeReadiness(policy(),tasks(async(id,{signal})=>{
  started++;await new Promise(r=>signal.addEventListener('abort',()=>setTimeout(r,60),{once:true}));settled++;return good();
 }));
 m.start();const closing=m.close();assert.equal(m.view().detail.reason,'CLOSING');assert.equal(m.view().ready,false);assert.equal(settled,0);await closing;assert.equal(started,2);assert.equal(settled,2);
 m.start();await m.refresh();assert.equal(started,2);await m.close();
});

test('resource snapshots reflect the actual main-process ledger and scheduler without claiming OS capacity',async()=>{
 const before=runtimeResources([]),account=resident.account('task');account.grow(65536);const hold=deferred(),begun=deferred();const work=workScheduler.run('readiness-isolated-qa',async()=>{begun.resolve();await hold.promise;});await begun.promise;
 try {const during=runtimeResources([]);assert.equal(during.ledger.usedBytes,before.ledger.usedBytes+65536);assert.equal(during.work.active,before.work.active+1);assert.equal(during.operatingSystemCapacityVerified,false);assert(during.memory.rss>0);}
 finally{hold.resolve();await work;account.release();}assert.equal(runtimeResources([]).ledger.usedBytes,before.ledger.usedBytes);
 const bad=structuredClone(before);bad.memory.rss=-1;assert.throws(()=>validateRuntimeResources(bad));
 const inconsistent=structuredClone(before);inconsistent.http.closing=true;assert.throws(()=>validateRuntimeResources(inconsistent));
});
