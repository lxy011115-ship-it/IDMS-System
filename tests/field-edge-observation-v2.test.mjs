import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fieldHttpClientFixture} from '../scripts/fixtures/field-http-client-fixture.mjs';
import {FieldLeaseClientV2} from '../services/field/lease-client-v2.ts';
import {FieldEdgeRunnerV3} from '../services/field/edge-runner-v3.ts';
import {FieldEdgeRunnerV4} from '../services/field/edge-runner-v4.ts';
import {fieldCertificateFixture,fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {fieldMqttDeclaration} from '../scripts/fixtures/field-mqtt-fixture.mjs';
import {publicFieldProfile} from '../services/field/profile.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {signFieldLease,fieldLeaseKeyId} from '../integrations/field-lease.ts';
import {verifyFieldLeaseRequest} from '../integrations/field-request.ts';
import {privateDirectory} from '../scripts/backup-support.mjs';

const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(check){const end=performance.now()+10000;while(performance.now()<end){if(check())return;await pause(5);}throw Error('FIELD_OBSERVATION_WAIT_EXPIRED');}
async function sdkFixture(run){return fieldHttpClientFixture(async f=>{const c=new FieldLeaseClientV2({profile:f.profile,requestKey:f.requestKey,platformPublicKey:f.keys.publicKey,url:f.url,timeoutMs:1000});try{await run(f,c);}finally{await c.close();}});}

test('pure SDK observation preserves an actual held first signed status check',async()=>sdkFixture(async(f,c)=>{
 await c.refresh();f.state.mode='HOLD';const pending=c.checkCurrent();pending.catch(()=>{});await until(()=>f.state.held.length===1);
 let revoked=0;const off=c.onRevoked(()=>revoked++);
 for(let i=0;i<30;i++){const s=c.state();assert.equal(s.active,true);assert.equal(s.transportActive,true);assert.equal(s.leaseCurrent,false);await pause(5);}
 assert.equal(revoked,0);f.state.held.shift()();await pending;
 assert.equal(c.state().leaseCurrent,true);c.authorize({profileDigest:f.profileDigest,phase:'ACTUAL_READ'});off();
}));

test('observation never extends the original two-second status validity',async()=>sdkFixture(async(f,c)=>{
 await c.ensureLease();let revoked=0;c.onRevoked(()=>revoked++);
 const end=performance.now()+2300;while(performance.now()<end){c.state();await pause(10);}
 assert.equal(c.state().leaseCurrent,false);assert.ok(revoked>=1);assert.throws(()=>c.authorize({profileDigest:f.profileDigest,phase:'ACTUAL_READ'}));
 assert.equal(f.state.lease,1);assert.equal(f.state.check,1);
}));

test('real operation still revokes a mismatched profile and explicit cancellation aborts held HTTP',async()=>sdkFixture(async(f,c)=>{
 await c.ensureLease();assert.throws(()=>c.authorize({profileDigest:'0'.repeat(64),phase:'ACTUAL_READ'}),{code:'FIELD_LEASE_PROFILE_MISMATCH'});assert.equal(c.state().leaseCurrent,false);
 f.state.mode='HOLD';const pending=c.refresh();pending.catch(()=>{});await until(()=>f.state.held.length===1);c.revoke();await assert.rejects(pending);assert.equal(c.state().transportActive,false);f.state.held.shift()();
}));

// Exercise the real runner observer while its first HTTP check is held.
// Certificates are QA materials; no OPC read or MQTT connection is executed here.
test('actual V3 observer cancels bootstrap; V4 observer leaves it active until explicit stop',async()=>{
 const serverCert=await fieldCertificateFixture(),clientCert=await fieldCertificateFixture({applicationUri:'urn:idms:field-qa-client'});
 for(const [Runner,shouldCancel] of [[FieldEdgeRunnerV3,true],[FieldEdgeRunnerV4,false]]){
  const keys=generateKeyPairSync('ed25519'),requestKey=randomBytes(32),eventKey=randomBytes(32),sockets=new Set();let checks=0,checkClosed=false;
  const profile=fieldProfileFixture(serverCert,clientCert);profile.source={...profile.source,edgeId:randomUUID()};profile.format='idms-field-channel-profile-v2';profile.transport=fieldMqttDeclaration(profile.source,{eventKeySha256:fieldSha256(eventKey),acknowledgementKeyId:fieldLeaseKeyId(keys.publicKey)});
  const server=createServer(async(req,res)=>{try{let bytes='';for await(const b of req)bytes+=b;const raw=JSON.parse(bytes);if(req.url.endsWith('/check')){checks++;res.once('close',()=>checkClosed=true);return;}verifyFieldLeaseRequest(raw,requestKey,Date.now());const now=Date.now();const signed=signFieldLease({format:'idms-field-channel-lease-v1',keyId:fieldLeaseKeyId(keys.publicKey),leaseId:randomUUID(),requestId:raw.requestId,...profile.source,profileDigest:raw.profileDigest,admissionDigest:'a'.repeat(64),registryRevision:'1',registryDigest:'b'.repeat(64),issuedAtMs:now,expiresAtMs:now+30000},keys.privateKey);res.setHeader('content-type','application/json');res.end(JSON.stringify(signed));}catch{res.writeHead(503);res.end();}});
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const root=resolve('work/field-map-gateway-20261024/observer-regression-'+randomUUID());await mkdir(root,{recursive:true});await privateDirectory(root);
  const config={root,profile,publicProfile:publicFieldProfile(profile),opcua:{serverCertificate:Buffer.from(serverCert.der),clientCertificate:Buffer.from(clientCert.der),privateKeyPem:Buffer.from(clientCert.privateKey)},lease:{url:'http://127.0.0.1:'+server.address().port+'/api/v1/field-channel/lease',requestKey:Buffer.from(requestKey),publicKey:keys.publicKey,timeoutMs:10000,renewBeforeMs:1000},eventKey,mqtt:{url:'mqtts://127.0.0.1:9',materials:{caCertificate:Buffer.alloc(256),serverCertificate:Buffer.alloc(256),clientCertificate:Buffer.alloc(256),privateKeyPem:Buffer.alloc(256,73)}},spool:{directory:'spool',capacity:2,maxBytes:1048576,maxStreams:4},schedule:{sampleIntervalMs:500,retryMs:100,ackTimeoutMs:750,batchLimit:10,onceTimeoutMs:20000,retryBackoffMs:1000}};
  const runner=new Runner(config),run=runner.run();run.catch(()=>{});
  try{await until(()=>checks===1);for(let i=0;i<25;i++){assert.equal(runner.state().ready,false);await pause(5);}if(shouldCancel)await until(()=>checkClosed);else{assert.equal(checkClosed,false);assert.equal(runner.state().httpActive,true);}runner.stop();await run;await until(()=>checkClosed);const s=runner.state();assert.equal(s.closed,true);assert.equal(s.cleanupErrors,0);assert.equal(s.lockHeld,false);assert.equal(s.httpActive,false);assert.equal(s.leaseCurrent,false);}finally{runner.stop();await run.catch(()=>{});server.closeAllConnections();await new Promise(ok=>server.close(ok));requestKey.fill(0);}
 }
});
