import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
import {FieldEdgeRunnerV3} from '../services/field/edge-runner-v3.ts';
import {FieldEdgeLock} from '../services/field/edge-lock.ts';
import {fieldCertificateFixture,fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {fieldMqttDeclaration} from '../scripts/fixtures/field-mqtt-fixture.mjs';
import {publicFieldProfile} from '../services/field/profile.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {privateDirectory} from '../scripts/backup-support.mjs';

let serverCertificate,clientCertificate;
before(async()=>{
  serverCertificate=await fieldCertificateFixture();
  clientCertificate=await fieldCertificateFixture({applicationUri:'urn:idms:field-qa-client'});
});
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(check){
  const end=performance.now()+10000;
  while(performance.now()<end){if(check())return;await sleep(10);}
  throw Error('Owned edge lifecycle observation expired');
}
async function configuration(url,source){
  const root=resolve('work/edge-owned-lifecycle-20261024','runner-native-'+randomUUID());
  await mkdir(root,{recursive:true});await privateDirectory(root);
  const profile=fieldProfileFixture(serverCertificate,clientCertificate);
  profile.source=source??{...profile.source,edgeId:randomUUID()};
  const eventKey=randomBytes(32),requestKey=randomBytes(32),keys=generateKeyPairSync('ed25519');
  profile.format='idms-field-channel-profile-v2';
  profile.transport=fieldMqttDeclaration(profile.source,{eventKeySha256:fieldSha256(eventKey),acknowledgementKeyId:fieldLeaseKeyId(keys.publicKey)});
  // These tests cancel during HTTP lease issuance, before OPC UA or MQTT.
  // Placeholder MQTT certificates are intentionally never used as live proof.
  return {root,profile,publicProfile:publicFieldProfile(profile),opcua:{serverCertificate:Buffer.from(serverCertificate.der),clientCertificate:Buffer.from(clientCertificate.der),privateKeyPem:Buffer.from(clientCertificate.privateKey)},lease:{url,requestKey,publicKey:keys.publicKey,timeoutMs:10000,renewBeforeMs:1000},eventKey,mqtt:{url:'mqtts://127.0.0.1:9',materials:{caCertificate:Buffer.alloc(256),serverCertificate:Buffer.alloc(256),clientCertificate:Buffer.alloc(256),privateKeyPem:Buffer.alloc(256,73)}},spool:{directory:'spool',capacity:2,maxBytes:1048576,maxStreams:4},schedule:{sampleIntervalMs:500,retryMs:100,ackTimeoutMs:750,batchLimit:10,onceTimeoutMs:20000,retryBackoffMs:1000}};
}
async function heldHttp(){
  const sockets=new Set();let received=0,closedResponses=0;
  const server=createServer(async(req,res)=>{
    for await(const ignored of req){}
    received++;res.once('close',()=>closedResponses++);
    // Hold the actual response until the edge cancels its owned HTTP request.
  });
  server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
  return {url:'http://127.0.0.1:'+server.address().port+'/api/v1/field-channel/lease',sockets,get received(){return received;},get closedResponses(){return closedResponses;},async close(){server.closeAllConnections();await new Promise(ok=>server.close(ok));}};
}
function cleared(c){
  for(const bytes of [c.lease.requestKey,c.eventKey,c.opcua.privateKeyPem,c.mqtt.materials.privateKeyPem])assert.ok(bytes.every(b=>b===0));
  assert.equal(c.opcua.password,undefined);
}
function closed(r){
  const s=r.state();
  for(const name of ['ready','lockHeld','spoolOpen','readerActive','httpActive','mqttActive','leaseWatching','ackWaiterActive','leaseCurrent'])assert.equal(s[name],false,name);
  assert.equal(s.closed,true);assert.equal(s.cleanupErrors,0);
}
async function lockReleased(source){
  const lock=new FieldEdgeLock(source);
  try{await lock.acquire();assert.equal(lock.held,true);}finally{await lock.close();}
}

test('pre-start cancellation clears secrets and never creates a spool or readiness',async()=>{
  const c=await configuration('http://127.0.0.1:9/api/v1/field-channel/lease'),events=[];
  const r=new FieldEdgeRunnerV3(c,e=>events.push(e));
  assert.equal(r.state().ready,false);r.stop();
  await assert.rejects(r.run(),{code:'FIELD_EDGE_STOPPED'});
  closed(r);cleared(c);await lockReleased(c.profile.source);
  await assert.rejects(lstat(resolve(c.root,'spool')),{code:'ENOENT'});
  assert.deepEqual(events.map(e=>e.type),['FIELD_EDGE_STOPPED']);
  await assert.rejects(r.close(),{code:'FIELD_EDGE_STOPPED'});
});

test('real held HTTP request drains before STOPPED and OS identity lock can be reacquired',async()=>{
  const http=await heldHttp(),c=await configuration(http.url),events=[];
  const r=new FieldEdgeRunnerV3(c,e=>events.push(e)),run=r.run();run.catch(()=>{});
  try{
    await until(()=>http.received===1);
    assert.equal(r.state().httpActive,true);assert.equal(r.state().lockHeld,true);
    assert.equal(r.state().ready,false);assert.equal(r.state().businessAckObserved,false);
    r.stop();r.stop();await run;await r.close();closed(r);cleared(c);
    await until(()=>http.closedResponses===1&&http.sockets.size===0);
    await lockReleased(c.profile.source);
    assert.equal(events.at(-1).type,'FIELD_EDGE_STOPPED');
    assert.ok(!events.some(e=>['FIELD_EDGE_STREAM','FIELD_EDGE_ENQUEUED','FIELD_EDGE_STORED'].includes(e.type)));
  }finally{r.stop();await run.catch(()=>{});await http.close();}
});

test('duplicate identity cannot reach HTTP or open a different spool while original remains live',async()=>{
  const http=await heldHttp(),c=await configuration(http.url),a=new FieldEdgeRunnerV3(c),run=a.run();run.catch(()=>{});
  let duplicate;
  try{
    await until(()=>http.received===1);
    const other=await configuration(http.url,{...c.profile.source,deviceCode:'OTHER',mapVersion:'other'});
    other.spool.directory='different-spool';duplicate=new FieldEdgeRunnerV3(other);
    await assert.rejects(duplicate.run(),{code:'FIELD_EDGE_ALREADY_RUNNING'});
    closed(duplicate);cleared(other);assert.equal(http.received,1);
    assert.equal(a.state().lockHeld,true);assert.equal(a.state().httpActive,true);
    await assert.rejects(lstat(resolve(other.root,other.spool.directory)),{code:'ENOENT'});
  }finally{a.stop();await run;await http.close();}
  closed(a);await lockReleased(c.profile.source);
});

test('stopping one actual edge does not close an unrelated edge HTTP request or identity lock',async()=>{
  const http=await heldHttp(),ca=await configuration(http.url),cb=await configuration(http.url),a=new FieldEdgeRunnerV3(ca),b=new FieldEdgeRunnerV3(cb),ar=a.run(),br=b.run();ar.catch(()=>{});br.catch(()=>{});
  try{
    await until(()=>http.received===2);a.stop();await ar;closed(a);await lockReleased(ca.profile.source);
    assert.equal(b.state().httpActive,true);assert.equal(b.state().lockHeld,true);assert.equal(b.state().closed,false);
    const duplicate=new FieldEdgeLock(cb.profile.source);
    try{await assert.rejects(duplicate.acquire(),{code:'FIELD_EDGE_ALREADY_RUNNING'});}finally{await duplicate.close();}
    b.stop();await br;closed(b);await lockReleased(cb.profile.source);
    await until(()=>http.closedResponses===2&&http.sockets.size===0);
  }finally{a.stop();b.stop();await Promise.allSettled([ar,br]);await http.close();}
});

test('startup directory failure releases the actual lock and clears all configuration secrets',async()=>{
  const c=await configuration('http://127.0.0.1:9/api/v1/field-channel/lease'),events=[];
  await writeFile(resolve(c.root,'spool'),'owned file blocks directory');
  const r=new FieldEdgeRunnerV3(c,e=>events.push(e));
  await assert.rejects(r.run(),{code:'FIELD_EDGE_SPOOL_DIRECTORY_INVALID'});
  closed(r);cleared(c);await lockReleased(c.profile.source);
  assert.equal(events.at(-1).type,'FIELD_EDGE_STOPPED');
  assert.equal(r.state().businessAckObserved,false);
});

test('synthetic close rejection cannot produce a normal STOPPED event or hide behind close()',async()=>{
  const c=await configuration('http://127.0.0.1:9/api/v1/field-channel/lease'),events=[],r=new FieldEdgeRunnerV3(c,e=>events.push(e));
  const original=FieldEdgeLock.prototype.close;
  FieldEdgeLock.prototype.close=async function(){await original.call(this);throw Error('private-synthetic-close-error');};
  try{
    r.stop();await assert.rejects(r.run(),{code:'FIELD_EDGE_DRAIN_FAILED'});
    await assert.rejects(r.close(),{code:'FIELD_EDGE_DRAIN_FAILED'});
    assert.equal(r.state().closed,false);assert.equal(r.state().cleanupErrors,1);
    assert.ok(!events.some(e=>e.type==='FIELD_EDGE_STOPPED'));
    assert.deepEqual(events.at(-1),{type:'FIELD_EDGE_DRAIN_FAILED',code:'FIELD_EDGE_DRAIN_FAILED'});
    assert.ok(!JSON.stringify(events).includes('private-synthetic'));cleared(c);
  }finally{FieldEdgeLock.prototype.close=original;}
  await lockReleased(c.profile.source);
});
