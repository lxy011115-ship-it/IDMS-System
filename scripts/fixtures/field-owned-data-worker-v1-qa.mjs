import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {createServer as httpServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';

assert(process.connected&&process.env.NODE_ENV==='test'&&/^fieldownedqa-[a-f0-9]{12}$/.test(process.env.IDMS_DEMO_NAMESPACE??''));
const input=JSON.parse(await readFile(process.argv[2],'utf8'));assert.equal(input.format,'IDMS_FIELD_DATA_PATH_QA_INPUT_V1');assert.equal(input.runtime.port,Number(new URL('http://127.0.0.1:'+input.runtime.port).port));assert.notEqual(input.runtime.port,45432);
const {nonce,work,runtime,source}=input,sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
const report={format:'IDMS_FIELD_DATA_PATH_WORKER_V1',passed:false,checks:[],edgeProofs:[],cleanupErrors:[],authenticatedHumanApprovalUiExercised:false,qaIndependentApprovalModel:true,fullPlatformIntegrated:false};
const send=(type,details={})=>{if(process.connected)process.send({type,nonce,...details},()=>{});};
const note=async name=>{report.checks.push(name);await writeFile(join(work,'worker-current.private.json'),JSON.stringify(report));send('FIELD_NOTE',{name});};
async function until(check,label,ms=30000){const end=performance.now()+ms;while(performance.now()<end){if(await check())return;await sleep(20);}throw Error(label);}
const keys=generateKeyPairSync('ed25519'),requestKey=randomBytes(32),edges=[];
let opc,mqtt,broker,platform,intake,server,db,store,closePostgres,waitForWrites,stopping=false,dropAck=false,dropCount=0,holdSql=false,heldSql=false,releaseSql,pgGuard,pgGuardResult;
const nativeQuery=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
  const sql=typeof config==='string'?config:config?.text??'';
  if(holdSql&&sql.includes('IDMS_FIELD_PRECOMMIT')){
    holdSql=false;heldSql=true;return new Promise(ok=>releaseSql=ok).then(()=>nativeQuery.call(this,config,...args));
  }
  return nativeQuery.call(this,config,...args);
};
process.on('message',m=>{if(m?.nonce!==nonce)return;if(m.type==='FIELD_PG_STOP_GUARD_RESULT'&&m.requestId===pgGuard){pgGuardResult=m.refused;}else if(m.type==='FIELD_WORKER_STOP'){stopping=true;releaseSql?.();for(const release of opc?.state.held.splice(0)??[])release();}});
const {privateDirectory,privateNewFile}=await import('../backup-support.mjs');
const {canonical}=await import('../../server/imports.ts');
const {FieldPlatformService}=await import('../../server/field-platform.ts');
const nativeReceive=FieldPlatformService.prototype.receiveMqtt;
FieldPlatformService.prototype.receiveMqtt=async function(...args){const receipt=await nativeReceive.apply(this,args);if(dropAck&&receipt){dropCount++;return null;}return receipt;};
let options,bindEdge,probeEdge,stopEdge;
async function createEdge(){
  const {launchFieldEdgeLifecycleV2}=await import('../field-edge-lifecycle-v2.mjs');
  const handle=await launchFieldEdgeLifecycleV2(options);edges.push(handle);
  const binding=bindEdge(handle);binding.catch(()=>{});return {handle,binding};
}
async function stopOne(handle){
  const stop=stopEdge(handle);
  // The public call first persists its stop intent. Do not release the held
  // native response until the actual child has accepted the monotonic STOP.
  if(opc.state.held.length)await until(()=>handle.lastObservedState?.stopping===true||handle.process.exitCode!==null,'FIELD_EDGE_STOP_NOT_ACCEPTED');
  for(const release of opc.state.held.splice(0))release();
  const proof=await stop;assert(proof.normalStop&&proof.localDrained&&proof.actualExitAndOutputAndIpcClosed);assert.equal(handle.process.exitCode,0);report.edgeProofs.push(proof);return proof;
}
async function spool(){
  const directory=join(work,'edge-spool'),names=(await readdir(directory)).filter(n=>/^stream-[a-f0-9]{64}\.sqlite$/.test(n));assert.equal(names.length,1);
  const q=new DatabaseSync(join(directory,names[0]),{readOnly:true});
  try{return {sequence:Number(q.prepare("SELECT value FROM metadata WHERE name='sequence'").get().value),pending:q.prepare('SELECT event_id,digest,sequence_no FROM pending ORDER BY sequence_no').all(),acknowledged:q.prepare('SELECT event_id,sequence_no FROM acknowledged ORDER BY sequence_no').all()};}finally{q.close();}
}
const pointCount=async()=>Number((await db.query('SELECT count(*)::int AS n FROM idms_field.points')).rows[0].n);
try{
  const {seedStore}=await import('../../server/store.ts');
  const {loadRuntimeImports,mutate,waitForWrites:wait}=await import('../../server/import-api.ts');waitForWrites=wait;
  ({closePostgres}=await import('../../server/postgres-repository.ts'));
  const {FieldIntakeService}=await import('../../server/field-intake.ts');
  const {fieldIssuanceModel}=await import('./field-issuance-model.mjs');
  const {createFieldOpcuaServer}=await import('./field-opcua-server.mjs');
  const {mqttBrokerMaterialsFixtureQaV1}=await import('./mqtt-broker-materials-v1-qa.mjs');
  const {launchMqttBrokerLifecycleV4,bindMqttBrokerLifecycleV4}=await import('../mqtt-broker-lifecycle-v4.mjs');
  const {fieldLeaseKeyId}=await import('../../integrations/field-lease.ts');
  const {fieldSha256}=await import('../../integrations/field-profile.ts');
  const {fieldRecoveryFixture}=await import('./field-recovery-fixture.mjs');
  const {fieldRegistrationCandidate}=await import('../../server/field-recovery-registration.ts');
  const edgeApi=await import('../field-edge-lifecycle-v2.mjs');bindEdge=edgeApi.bindFieldEdgeLifecycleV2;probeEdge=edgeApi.probeFieldEdgeLifecycleV2;stopEdge=edgeApi.stopFieldEdgeLifecycleV2;
  store=seedStore();await loadRuntimeImports(store);opc=await createFieldOpcuaServer();
  const materialDirectory=join(work,'materials');await privateDirectory(materialDirectory);mqtt=await mqttBrokerMaterialsFixtureQaV1({tenantId:'acme',edgeId:source.edgeId},{directory:materialDirectory});
  const probeId='idms-broker-probe-'+randomBytes(8).toString('hex');await mqtt.leaf('health',probeId);
  const reservation=netServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const brokerPort=reservation.address().port;await new Promise(ok=>reservation.close(ok));
  const brokerUrl='mqtts://127.0.0.1:'+brokerPort,brokerRuntimeFile=join(work,'broker-runtime.private.json');
  await privateNewFile(brokerRuntimeFile,JSON.stringify({format:1,purpose:'MQTT_BROKER_SERVICE_V1',toolingDirectory:input.brokerToolingDirectory,host:'127.0.0.1',port:brokerPort,server:{caFile:join(materialDirectory,'ca.pem'),certificateFile:join(materialDirectory,'broker.pem'),keyFile:join(materialDirectory,'broker.key')},probe:{clientId:probeId,certificateFile:join(materialDirectory,'health.pem'),keyFile:join(materialDirectory,'health.key')},channels:[{tenantId:'acme',edgeId:source.edgeId}]}));
  broker=await launchMqttBrokerLifecycleV4({runtimeFile:brokerRuntimeFile,workDirectory:work});report.brokerDirectory=broker.directory;await bindMqttBrokerLifecycleV4(broker);
  source.points=source.points.map((p,i)=>({...p,nodeId:opc.point(i?'native-Double':'pressure').nodeId}));
  const seed=structuredClone(opc.profile);seed.format='idms-field-channel-profile-v2';seed.transport={...mqtt.declaration(brokerUrl),acknowledgementKeyId:fieldLeaseKeyId(keys.publicKey)};seed.source={tenantId:'acme',edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion};seed.points=source.points.map(p=>({...opc.profile.points[0],...p}));seed.limits.timeoutMs=10000;
  const model=await mutate(store,(_c,w)=>{const m=fieldIssuanceModel(w.store,w.imports,source,seed);return {profile:m.profile,privateProfile:{...seed,points:structuredClone(m.profile.points)}};},'acme');
  const write=async(name,bytes)=>{const path=join(work,name);await privateNewFile(path,bytes);return path;};
  await write('signer.pem',keys.privateKey.export({type:'pkcs8',format:'pem'}));await write('request.bin',requestKey);await write('event.bin',mqtt.eventKey);await write('platform-public.pem',keys.publicKey.export({type:'spki',format:'pem'}));
  await write('server.der',opc.materials.serverCertificate);await write('client.der',opc.materials.clientCertificate);await write('client-key.pem',opc.materials.privateKeyPem);await write('profile.json',canonical(model.privateProfile));
  for(const [name,value]of Object.entries({ca:mqtt.ca.certificate,broker:mqtt.server.certificate,edge:mqtt.edge.certificate,platform:mqtt.platform.certificate,'edge-key':mqtt.edge.privateKey,'platform-key':mqtt.platform.privateKey}))await write(name+'.pem',value);
  const recovery=fieldRecoveryFixture({host:runtime.host,port:runtime.port,database:runtime.tenants.acme.database,user:runtime.tenants.acme.user});await write('recovery.json',canonical(recovery));
  const platformFile=await write('platform.json',canonical({format:'idms-field-platform-config-v2',leaseSigningKeyFile:'signer.pem',tenants:[{tenantId:'acme',recoveryFile:'recovery.json',channels:[{profile:model.profile,requestKeyFile:'request.bin',eventKeyFile:'event.bin'}]}]}));
  const transport=role=>({url:brokerUrl,caFile:'ca.pem',serverCertificateFile:'broker.pem',clientCertificateFile:role==='EDGE'?'edge.pem':'platform.pem',privateKeyFile:role==='EDGE'?'edge-key.pem':'platform-key.pem'});
  const intakeFile=await write('intake.json',canonical({format:'idms-field-platform-intake-v1',tenants:[{tenantId:'acme',channels:[{edgeId:source.edgeId,mqtt:transport('PLATFORM')}]}]}));
  platform=new FieldPlatformService();await platform.start(store,platformFile);intake=new FieldIntakeService(platform);await intake.start(intakeFile,input.runtimeFile);await until(()=>intake.state().connected===1,'FIELD_INTAKE_NOT_CONNECTED');
  const {withRequestCapacity,readRequestBytes}=await import('../../server/request-capacity.ts');
  server=httpServer((req,res)=>void withRequestCapacity(req,res,async()=>{
    assert(['/api/v1/field-channel/lease','/api/v1/field-channel/lease/check'].includes(req.url));const raw=JSON.parse((await readRequestBytes(req,4096)).toString('utf8'));
    const result=req.url.endsWith('/check')?await platform.checkCurrent(store,raw):await platform.issue(store,raw);res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  }).catch(error=>{if(!res.destroyed){res.statusCode=error.status??503;res.setHeader('content-type','application/json');res.end('{"error":"FIELD_OWNED_QA_REQUEST_FAILED"}');}}));
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const edgeFile=await write('edge.json',canonical({format:'idms-field-edge-config-v1',profileFile:'profile.json',lease:{url:'http://127.0.0.1:'+server.address().port+'/api/v1/field-channel/lease',requestKeyFile:'request.bin',platformPublicKeyFile:'platform-public.pem',timeoutMs:3000,renewBeforeMs:1000},eventKeyFile:'event.bin',mqtt:transport('EDGE'),spool:{directory:'edge-spool',capacity:source.points.length,maxBytes:1048576,maxStreams:4},schedule:{sampleIntervalMs:60000,retryMs:100,ackTimeoutMs:5000,batchLimit:10,onceTimeoutMs:30000,retryBackoffMs:1000}}));
  const materialFile=await write('activation-materials.json',canonical({format:'idms-field-activation-materials-v1',tenantId:'acme',intakeConfigurationFile:intakeFile,edges:[{edgeId:source.edgeId,configurationFile:edgeFile}]})),registry=platform.publicSnapshot('acme');
  const registration=fieldRegistrationCandidate({format:'idms-field-recovery-registration-candidate-v1',tenantId:'acme',operationId:randomUUID(),controlSha256:fieldSha256(canonical(recovery)),operationIntentSha256:'b'.repeat(64),configSha256:fieldSha256(await readFile(platformFile)),registry,registrySha256:fieldSha256(canonical(registry)),fieldEnabled:false,activationGranted:false});
  options={configurationFile:materialFile,edgeConfigurationFile:edgeFile,edgeId:source.edgeId,registration,workDirectory:work};
  db=new pg.Client({host:runtime.host,port:runtime.port,...runtime.tenants.acme});await db.connect();
  await note('production issuer and transactional intake use the generated PostgreSQL and recovery binding');
  const first=await createEdge();await until(async()=>!!first.handle.lastObservedState?.ready,'FIELD_EDGE_SIGNED_ACK_READY_TIMEOUT');await first.binding;
  assert.equal(await pointCount(),source.points.length);assert.equal((await spool()).pending.length,0);
  for(let i=0;i<4;i++){await sleep(200);const s=await probeEdge(first.handle);assert(s.ready&&s.leaseCurrent&&s.businessAckObserved);}
  await stopOne(first.handle);await note('actual OPC UA, mTLS, committed SQL and signed ACK produce stable READY');
  const countBeforeRead=await pointCount(),queueBeforeRead=await spool();opc.state.mode='HOLD_VALUE';const holding=await createEdge();
  await until(()=>opc.state.held.length===1,'FIELD_EDGE_NATIVE_READ_NOT_HELD');assert.equal((await probeEdge(holding.handle)).readerActive,true);
  await stopOne(holding.handle);assert.equal(await pointCount(),countBeforeRead);assert.equal((await spool()).sequence,queueBeforeRead.sequence);
  await note('stop during a held native OPC UA read leaves PostgreSQL and spool sequence unchanged');
  dropAck=true;const lost=await createEdge();await until(()=>dropCount===1,'FIELD_EDGE_COMMITTED_ACK_NOT_DROPPED');
  assert.equal(await pointCount(),countBeforeRead+1);assert.equal((await probeEdge(lost.handle)).ackWaiterActive,true);
  const pending=await spool();assert.equal(pending.pending.length,source.points.length);const priorEvent=pending.pending[0];
  const receipt=(await db.query('SELECT audit_event_id FROM idms_field.receipts WHERE event_id=$1',[priorEvent.event_id])).rows[0];assert(receipt);
  await stopOne(lost.handle);assert.deepEqual((await spool()).pending,pending.pending);dropAck=false;
  await note('lost business ACK after COMMIT retains the exact pending events through normal stop');
  opc.state.mode='HOLD_VALUE';const replay=await createEdge();await until(()=>replay.handle.lastObservedState?.ready,'FIELD_EDGE_REPLAY_READY_TIMEOUT');await replay.binding;
  await until(async()=>(await spool()).pending.length===0,'FIELD_EDGE_REPLAY_QUEUE_NOT_CLEARED');
  assert.equal((await db.query('SELECT audit_event_id FROM idms_field.receipts WHERE event_id=$1',[priorEvent.event_id])).rows[0].audit_event_id,receipt.audit_event_id);
  await stopOne(replay.handle);assert.equal(await pointCount(),countBeforeRead+source.points.length);
  await note('replay uses the original committed receipt without duplicate points');
  opc.state.mode=null;holdSql=true;const sqlBefore=await pointCount(),sqlEdge=await createEdge();
  await until(()=>heldSql,'FIELD_EDGE_PRECOMMIT_NOT_HELD');assert.equal(await pointCount(),sqlBefore);
  const edgeStop=stopEdge(sqlEdge.handle);let intakeClosed=false,platformClosed=false;
  const intakeStop=intake.close().then(()=>intakeClosed=true),platformStop=platform.close().then(()=>platformClosed=true);
  await sleep(60);assert.equal(intakeClosed,false);assert.equal(platformClosed,false);
  pgGuard=randomUUID();send('FIELD_PG_STOP_GUARD',{requestId:pgGuard});await until(()=>pgGuardResult!==undefined,'FIELD_PG_STOP_GUARD_NOT_OBSERVED');assert.equal(pgGuardResult,true);
  releaseSql();await Promise.all([intakeStop,platformStop]);const sqlProof=await edgeStop;assert(sqlProof.normalStop&&sqlProof.localDrained);report.edgeProofs.push(sqlProof);
  assert.equal(await pointCount(),sqlBefore);assert.equal((await spool()).pending.length,source.points.length);assert.equal(intake.state().closed,true);
  await note('held SQL prevents intake drain and PostgreSQL stop; cancellation rolls back and retains the queue');
  assert.equal(opc.state.requests.WriteRequest??0,0);assert.equal(opc.state.requests.CallRequest??0,0);
  report.readOnlyServices=opc.state.requests;report.actualStoredPoints=await pointCount();report.signedBusinessAckPositiveCase=true;report.pgStopGuardRefused=pgGuardResult;report.passed=report.checks.length===6&&!stopping;
}catch(error){
  report.failure={message:error.message,stack:error.stack,code:error.code??null};process.exitCode=1;
}finally{
  releaseSql?.();for(const release of opc?.state.held.splice(0)??[])release();
  for(const edge of edges)if(edge.process.exitCode===null&&edge.process.signalCode===null)try{report.edgeProofs.push(await stopEdge(edge));}catch{report.cleanupErrors.push('EDGE_STOP');}
  if(intake)try{await intake.close();}catch{report.cleanupErrors.push('INTAKE_CLOSE');}
  if(server)try{server.closeAllConnections();await new Promise(ok=>server.close(ok));}catch{report.cleanupErrors.push('HTTP_CLOSE');}
  if(platform)try{await platform.close();}catch{report.cleanupErrors.push('PLATFORM_CLOSE');}
  if(opc)try{await opc.close();}catch{report.cleanupErrors.push('OPCUA_CLOSE');}
  if(broker)try{const {stopMqttBrokerLifecycleV4}=await import('../mqtt-broker-lifecycle-v4.mjs');const proof=await stopMqttBrokerLifecycleV4(broker);assert(proof.normalClose);report.brokerStop=proof;}catch{report.cleanupErrors.push('BROKER_STOP');}
  if(waitForWrites)try{await waitForWrites();}catch{report.cleanupErrors.push('SQL_WRITES');}
  if(db)try{await db.end();}catch{report.cleanupErrors.push('OBSERVER_DB_CLOSE');}
  if(closePostgres)try{await closePostgres();}catch{report.cleanupErrors.push('POOLS_CLOSE');}
  pg.Client.prototype.query=nativeQuery;FieldPlatformService.prototype.receiveMqtt=nativeReceive;requestKey.fill(0);mqtt?.eventKey.fill(0);
  report.passed=report.passed&&report.cleanupErrors.length===0;await writeFile(join(work,'worker-verification.private.json'),JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;send('FIELD_WORKER_PROOF',{proof:report});await new Promise(ok=>setImmediate(ok));if(process.connected)process.disconnect();
}
