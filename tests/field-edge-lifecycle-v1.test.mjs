import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile,lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {launchFieldEdgeLifecycleV1,bindFieldEdgeLifecycleV1,probeFieldEdgeLifecycleV1,stopFieldEdgeLifecycleV1} from '../scripts/field-edge-lifecycle-v1.mjs';
import {fieldOwnedMaterialFixtureV1} from '../scripts/fixtures/field-owned-material-v1-qa.mjs';
import {FieldEdgeLock} from '../services/field/edge-lock.ts';

const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(check){const end=performance.now()+30000;while(performance.now()<end){if(await check())return;await sleep(20);}throw Error('Owned child observation expired; no restart or kill was attempted');}
async function httpFixture(){
  const sockets=new Set();let received=0;
  const server=createServer(async(req,res)=>{for await(const ignored of req){}received++;});
  server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  return {url:'http://127.0.0.1:'+server.address().port+'/api/v1/field-channel/lease',get received(){return received;},sockets,async close(){server.closeAllConnections();await new Promise(ok=>server.close(ok));}};
}
const options=f=>({configurationFile:f.configurationFile,edgeConfigurationFile:f.edgeConfigurationFile,edgeId:f.edgeId,registration:f.registration,workDirectory:f.workDirectory});
async function released(source){const lock=new FieldEdgeLock(source);try{await lock.acquire();assert.equal(lock.held,true);}finally{await lock.close();}}
function actualClosed(handle,proof){assert.equal(handle.process.exitCode,proof.exit.code);assert.equal(handle.process.signalCode,proof.exit.signal);assert.equal(handle.process.stdout.closed,true);assert.equal(handle.process.stderr.closed,true);assert.equal(handle.process.connected,false);assert.equal(proof.actualExitAndOutputAndIpcClosed,true);assert.equal(proof.genericKillUsed,false);}

test('actual owned child cancels before START, repeats the same stop promise and closes all pipes/IPC',async()=>{
  const f=await fieldOwnedMaterialFixtureV1('http://127.0.0.1:9/api/v1/field-channel/lease');
  const handle=await launchFieldEdgeLifecycleV1(options(f));
  assert.equal(handle.process.exitCode,null);assert.equal(typeof handle.process.send,'function');
  const requestId=randomUUID(),stop=stopFieldEdgeLifecycleV1(handle,{requestId});
  assert.equal(stopFieldEdgeLifecycleV1(handle,{requestId}),stop);
  assert.throws(()=>stopFieldEdgeLifecycleV1(handle,{requestId:randomUUID()}),/FIELD_EDGE_STOP_REQUEST_CHANGED/);
  const proof=await stop;actualClosed(handle,proof);
  assert.equal(proof.normalStop,true);assert.equal(proof.startupCancelled,true);assert.equal(proof.pinsUnchanged,true);
  await released(f.source);await assert.rejects(lstat(resolve(f.directory,'spool')),{code:'ENOENT'});
});

test('actual child probes held HTTP without false READY, ignores bare STOP and drains on correlated stop',async()=>{
  const http=await httpFixture();let handle;
  try{
    const f=await fieldOwnedMaterialFixtureV1(http.url);handle=await launchFieldEdgeLifecycleV1(options(f));
    let ready=false;const binding=bindFieldEdgeLifecycleV1(handle);binding.then(()=>ready=true,()=>{});
    await until(()=>http.received===1);
    const state=await probeFieldEdgeLifecycleV1(handle);
    assert.equal(state.ready,false);assert.equal(state.businessAckObserved,false);assert.equal(state.httpActive,true);
    handle.process.send({type:'STOP'});await sleep(30);
    assert.equal((await probeFieldEdgeLifecycleV1(handle)).httpActive,true);assert.equal(ready,false);
    const proof=await stopFieldEdgeLifecycleV1(handle);actualClosed(handle,proof);
    assert.equal(proof.normalStop,true);assert.equal(proof.localDrained,true);assert.equal(proof.localState.httpActive,false);
    assert.equal(proof.businessIntakeDrainProven,false);await assert.rejects(binding,/FIELD_EDGE_STOPPING/);
    await until(()=>http.sockets.size===0);await released(f.source);
    const raw=await readFile(resolve(handle.directory,'terminal-proof.json'),'utf8');
    assert.ok(!raw.includes('PRIVATE KEY'));assert.ok(!raw.includes(http.url));
  }finally{if(handle&&handle.process.exitCode===null)await stopFieldEdgeLifecycleV1(handle);await http.close();}
});

test('configuration changed after launch is rejected by the actual child before HTTP or spool creation',async()=>{
  const http=await httpFixture();let handle;
  try{
    const f=await fieldOwnedMaterialFixtureV1(http.url);handle=await launchFieldEdgeLifecycleV1(options(f));
    f.edge.schedule.sampleIntervalMs=999;await writeFile(f.edgeConfigurationFile,JSON.stringify(f.edge));
    const binding=bindFieldEdgeLifecycleV1(handle);binding.catch(()=>{});
    const proof=await handle.terminal;actualClosed(handle,proof);
    assert.equal(proof.exit.code,1);assert.equal(proof.normalStop,false);assert.equal(http.received,0);
    await assert.rejects(binding,/FIELD_EDGE_EXIT_BEFORE_READY/);
    await assert.rejects(lstat(resolve(f.directory,'spool')),{code:'ENOENT'});await released(f.source);
  }finally{if(handle&&handle.process.exitCode===null)await stopFieldEdgeLifecycleV1(handle);await http.close();}
});

test('request credential changed after launch is rejected even when configuration bytes stay identical',async()=>{
  const http=await httpFixture();let handle;
  try{
    const f=await fieldOwnedMaterialFixtureV1(http.url);handle=await launchFieldEdgeLifecycleV1(options(f));
    await writeFile(resolve(f.directory,'request.bin'),randomBytes(32));
    const binding=bindFieldEdgeLifecycleV1(handle);binding.catch(()=>{});
    const proof=await handle.terminal;actualClosed(handle,proof);
    assert.equal(proof.exit.code,1);assert.equal(proof.normalStop,false);assert.equal(http.received,0);
    await assert.rejects(binding,/FIELD_EDGE_EXIT_BEFORE_READY/);
    await assert.rejects(lstat(resolve(f.directory,'spool')),{code:'ENOENT'});await released(f.source);
  }finally{if(handle&&handle.process.exitCode===null)await stopFieldEdgeLifecycleV1(handle);await http.close();}
});

test('actual parent IPC loss drains held HTTP; absence of correlated CLOSED is kept unproven',async()=>{
  const http=await httpFixture();let handle;
  try{
    const f=await fieldOwnedMaterialFixtureV1(http.url);handle=await launchFieldEdgeLifecycleV1(options(f));
    const binding=bindFieldEdgeLifecycleV1(handle);binding.catch(()=>{});
    await until(()=>http.received===1);handle.process.disconnect();
    const proof=await handle.terminal;actualClosed(handle,proof);
    assert.equal(proof.exit.code,0);assert.equal(proof.normalStop,false);assert.equal(proof.localDrained,false);
    assert.equal(proof.localState,null);await until(()=>http.sockets.size===0);await released(f.source);
  }finally{if(handle&&handle.process.exitCode===null&&handle.process.connected)await stopFieldEdgeLifecycleV1(handle);await http.close();}
});
