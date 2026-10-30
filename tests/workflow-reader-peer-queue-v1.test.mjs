import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SourceTextModule} from 'node:vm';
import {createHash} from 'node:crypto';

// Isolated white-box scheduling tests; no JVM, SQL reply or authentication proof is simulated.
// The production module has no test exports. Only this in-memory copy exposes its private map.
async function isolated(version){
 const path='scripts/workflow-review-reader-lifecycle-v'+version+'.mjs',original=await readFile(path,'utf8');
 if(version===5)assert.equal(createHash('sha256').update(original).digest('hex'),'fcbd084e7976f078f8ac4a05ab3b091c9f67c1bb7bd3ed90973c489a8c8397a7');
 const source=original.replace(/^import[^\n]*\r?\n/gm,'')+'\nexport const queueTestPrivateMap=readerPeers;\n';
 const module=new SourceTextModule(source,{identifier:path});await module.link(()=>{throw Error('UNEXPECTED_UNIT_IMPORT');});await module.evaluate();return module.namespace;
}
function pendingRecord(map){
 let finish;const tail=new Promise(ok=>{finish=ok;}),reached=Error('ORIGINAL_PROBE_REACHED'),cap={probe:async()=>{throw reached;}},r={state:{},phase:'UNCERTAIN',tail};r.state.peer=r;map.set(cap,r);
 return{cap,r,finish,reached};
}
const turn=()=>new Promise(ok=>setImmediate(ok));
const root={host:'127.0.0.1',port:23456,systemIdentifier:'7000000000000000000',directory:'queue-unit-source'};
test('the frozen old guard rejects an own pending probe before the original queue settles',async()=>{
 const m=await isolated(5),x=pendingRecord(m.queueTestPrivateMap);
 await assert.rejects(m.assertOwnedWorkflowReaderPeerBackendsV1({},x.cap,{}),/READER_PEER_NOT_MINTED/);x.r.phase='HELD';x.finish();
});
test('the new guard waits for the original pending queue and then probes the same held capability',async()=>{
 const m=await isolated(6),x=pendingRecord(m.queueTestPrivateMap);let ended=false;
 const result=m.assertOwnedWorkflowReaderPeerBackendsV1({},x.cap,root).then(()=>({ok:true}),error=>({error})).finally(()=>{ended=true;});
 await turn();assert.equal(ended,false);x.r.phase='HELD';x.finish();assert.equal((await result).error,x.reached);
});
test('an unsuccessful operation left uncertain still fails after its original queue settles',async()=>{
 const m=await isolated(6),x=pendingRecord(m.queueTestPrivateMap),result=m.assertOwnedWorkflowReaderPeerBackendsV1({},x.cap,{});
 x.finish();await assert.rejects(result,/READER_PEER_NOT_MINTED/);
});
test('an original release cannot become a held capability by waiting for its queue',async()=>{
 const m=await isolated(6),x=pendingRecord(m.queueTestPrivateMap),result=m.assertOwnedWorkflowReaderPeerBackendsV1({},x.cap,{});
 x.r.phase='RELEASED';x.finish();await assert.rejects(result,/READER_PEER_NOT_MINTED/);
});
test('replacing the original map or owner peer while awaiting settlement fails closed',async()=>{
 for(const change of ['map','owner']){const m=await isolated(6),x=pendingRecord(m.queueTestPrivateMap),result=m.assertOwnedWorkflowReaderPeerBackendsV1({},x.cap,{});
  x.r.phase='HELD';if(change==='map')m.queueTestPrivateMap.set(x.cap,{...x.r});else x.r.state.peer={};x.finish();await assert.rejects(result,/READER_PEER_NOT_MINTED/);
 }
});
test('an unminted object cannot supply a queue, a peer state or SQL work',async()=>{
 const m=await isolated(6);let touched=0;const cap={get tail(){touched++;throw Error('FOREIGN_QUEUE');},get phase(){touched++;return'HELD';},probe(){touched++;throw Error('FOREIGN_PROBE');}},sql={query(){touched++;throw Error('FOREIGN_SQL');}};
 await assert.rejects(m.assertOwnedWorkflowReaderPeerBackendsV1(sql,cap,{}),/READER_PEER_NOT_MINTED/);assert.equal(touched,0);
});
