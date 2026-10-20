import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {seedStore} from '../../server/store.ts';
import {estimatedBytes,resident} from '../../server/capacity.ts';
import * as api from '../../server/import-api.ts';
import * as repo from '../../server/postgres-repository.ts';
if(!process.send||process.env.NODE_ENV!=='test'||!/^bootstrapqa-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Owned bootstrap QA IPC required');
let store,server,runtime,close;const start=performance.now();
try{
 if(process.argv.includes('--full')){store=seedStore();await api.loadImports(store);close=async()=>{api.clearWorkspaceCache();await repo.closePostgres();};}
 else{runtime=await import('../../server/index.ts');store=runtime.store;server=createServer(runtime.handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));close=async()=>{await new Promise(ok=>server.close(ok));await runtime.closeRuntime();};}
 global.gc?.();const graph={store,imports:api.importData},bootstrap={tenants:store.tenants.length,businessRows:Object.entries(store).filter(([k,v])=>Array.isArray(v)&&!['tenants','audits'].includes(k)).reduce((n,[,v])=>n+v.length,0),audits:store.audits.length,batches:api.importData.batches.length,facts:api.importData.records.length,receipts:store.idempotency.size+api.importData.requests.length,originalBase64Characters:api.importData.batches.reduce((n,b)=>n+b.originalBase64.length,0),estimatedGraphBytes:estimatedBytes(graph),heapAfterGcBytes:process.memoryUsage().heapUsed,maxRssKiB:process.resourceUsage().maxRSS,elapsedMs:performance.now()-start,ledger:resident.snapshot(),rootFrozen:Object.isFrozen(store)};
 if(runtime)assert.throws(()=>api.platformSnapshot(store),/启动绑定/);
 process.on('message',m=>{
  if(m.type==='ROOT')process.send({type:'DONE',id:m.id,value:{businessRows:bootstrap.businessRows,audits:store.audits.length,batches:api.importData.batches.length,facts:api.importData.records.length,receipts:store.idempotency.size+api.importData.requests.length,ledger:resident.snapshot()}});
  if(m.type==='CLOSE')void close().then(()=>process.send({type:'DONE',id:m.id},()=>process.disconnect()));
 });
 process.send({type:'READY',bootstrap,url:server?'http://127.0.0.1:'+server.address().port:undefined});
}catch(error){process.send({type:'BOOT_ERROR',message:error.message},()=>process.exit(2));}
