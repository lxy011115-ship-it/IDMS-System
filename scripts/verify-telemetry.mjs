import assert from 'node:assert/strict';
import { readFile,mkdir,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import pg from 'pg';
import mqtt from 'mqtt';
import { createMqttConfig,launchBroker,brokerRoot } from './mqtt-local.mjs';
import { writePrivate } from './keycloak-local.mjs';
import { signEvent,topicFor,authenticAck } from '../integrations/telemetry.ts';
import {migrateQaDatabases,cleanupQaRoles,qaAdminAccount} from './qa-database.mjs';
const suffix=randomUUID().replaceAll('-','').slice(0,10),directory=resolve('.local',`telemetry-qa-${suffix}`),base='http://127.0.0.1:4028';
const main=JSON.parse(await readFile('.local/postgres-runtime.json','utf8'));
const dbConfig={host:main.host,port:main.port,tenants:Object.fromEntries(Object.keys(main.tenants).map(id=>{const name=`idms_qa_${id}_${suffix}`;return [id,{user:name,password:randomBytes(32).toString('base64url'),database:name}];}))};
const admin=new pg.Client({host:main.host,port:main.port,database:'postgres',user:'idms_bootstrap',password:main.bootstrapPassword});
let core,replica,edge,simulator,broker,conn,publisher,probe,predictor,browser;const children=[];const logs=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(task,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const result=await task();if(result)return result;}catch{}await pause(150);}throw Error('Timeout: '+label);}
function launch(file,env){const child=spawn(process.execPath,[file],{env:{...process.env,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});track(child,file);return child;}
function track(child,label){children.push(child);logs.set(child,'');for(const stream of [child.stdout,child.stderr])stream?.on('data',b=>logs.set(child,(logs.get(child)+b).slice(-12000)));child.on('error',()=>{});return child;}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([done,pause(5000)]);assert.ok(child.exitCode!==null||child.signalCode!==null,'owned process did not exit');}
async function api(path,tenant='sandbox',expected=200){const r=await fetch(base+'/api/v1'+path,{headers:{'X-Tenant-Id':tenant,'X-Actor-Id':'demo.auditor','X-Actor-Type':'USER'}});const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;}
async function post(path,body,expected=200,actor='demo.approver'){const r=await fetch(base+'/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Tenant-Id':'sandbox','X-Actor-Id':actor,'X-Actor-Type':'USER','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID()},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;}
try{
  await admin.connect();
  for(const account of Object.values(dbConfig.tenants)){assert.match(account.database,/^idms_qa_(acme|sandbox)_[a-f0-9]{10}$/);await admin.query(`CREATE ROLE "${account.user}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);await admin.query(`CREATE DATABASE "${account.database}" OWNER "${account.user}"`);await admin.query(`REVOKE CONNECT ON DATABASE "${account.database}" FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE "${account.database}" TO "${account.user}"`);}
  const prepared=await createMqttConfig(directory,{port:1894,statusPort:4034,opcPort:4851,simulatorPort:4035,edgeId:'qa-edge-'+suffix});
  const {config,file,brokerFile}=prepared;config.edge.pollMs=1000;await writePrivate(file,JSON.stringify(config));
  // QA-only second tenant producer verifies delivery isolation, not merely SUBACK reason codes.
  const probeUser='qa-probe',probePassword=randomBytes(32).toString('base64url'),foreignTopic=`idms/v1/acme/${config.sources[0].edgeId}/telemetry`;
  await writePrivate(resolve(directory,'mqtt-passwords'),`${config.mqtt.username}:${config.mqtt.password}\n${config.edge.username}:${config.edge.password}\n${probeUser}:${probePassword}\n`);
  await promisify(execFile)(resolve(brokerRoot,'mosquitto_passwd.exe'),['-U',resolve(directory,'mqtt-passwords')],{windowsHide:true});
  await writePrivate(resolve(directory,'mqtt-acl'),await readFile(resolve(directory,'mqtt-acl'),'utf8')+`user ${probeUser}\ntopic write ${foreignTopic}\n`);
  const pgPath=resolve(directory,'postgres.json');await writePrivate(pgPath,JSON.stringify(await migrateQaDatabases(dbConfig,main,{telemetryTenants:['sandbox']})));
  const env={PORT:'4028',IDMS_AUTH_MODE:'demo',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:pgPath,IDMS_DEMO_NAMESPACE:'telemetry-qa-'+suffix,IDMS_TELEMETRY_CONFIG:file,IDMS_PREDICTOR_URL:'http://127.0.0.1:4032',IDMS_SERVICE_TOKEN:randomBytes(32).toString('base64url')};
  const source=config.sources[0];
  const edgeStatus=async()=>{const r=await fetch(source.statusUrl,{headers:{Authorization:'Bearer '+source.statusKey}});return r.json();};
  const simStatus=async()=>{const r=await fetch(`http://127.0.0.1:${config.simulator.statusPort}/status`,{headers:{Authorization:'Bearer '+config.simulator.statusKey}});return r.json();};
  broker=track(launchBroker(brokerFile),'broker');
  predictor=launch('services/predictor/index.ts',{...env,PREDICTOR_PORT:'4032'});await until(async()=>{const r=await fetch('http://127.0.0.1:4032/health');return r.ok;},'predictor');
  core=launch('server/index.ts',env);await until(()=>api('/health'),'core');
  simulator=launch('services/edge/simulator.ts',{...env,IDMS_SIMULATOR_HISTORY:'1'});await until(simStatus,'OPC simulator');
  edge=launch('services/edge/index.ts',env);await until(async()=>{const s=await edgeStatus();return s.acknowledged>=6&&s.pending===0;},'OPC → spool → MQTT → committed SQL → ACK');
  conn=new pg.Client(qaAdminAccount(main,dbConfig.tenants.sandbox));await conn.connect();
  assert.ok(Number((await conn.query('SELECT count(*) FROM telemetry_points')).rows[0].count)>=3);
  assert.equal((await simStatus()).writeRequests,0);assert.ok((await simStatus()).readRequests>0);
  assert.equal((await api('/telemetry/overview','acme')).sources.length,0);
  await api('/telemetry/points?edgeId='+source.edgeId,'acme',404);
  assert.equal((await api('/telemetry/overview')).sources[0].origin,'SIMULATOR');
  replica=launch('server/index.ts',{...env,PORT:'4029',IDMS_DEMO_NAMESPACE:'telemetry-replica-'+suffix});
  await until(async()=>{const r=await fetch('http://127.0.0.1:4029/api/v1/telemetry/overview',{headers:{'X-Tenant-Id':'sandbox','X-Actor-Id':'demo.auditor','X-Actor-Type':'USER'}});if(!r.ok)return false;const a=await r.json(),b=await api('/telemetry/overview');return a.brokerConnected&&a.subscribed&&b.brokerConnected&&b.subscribed;},'both core MQTT sessions coexist');
  for(let i=1;i<=5;i++){
    const advanced=await fetch(`http://127.0.0.1:${config.simulator.statusPort}/advance`,{method:'POST',headers:{Authorization:'Bearer '+config.simulator.statusKey}});assert.equal(advanced.status,200);
    await until(async()=>Number((await conn.query('SELECT count(*) FROM telemetry_points')).rows[0].count)>=(i+1)*3,'synthetic history step '+i);
  }
  await post('/telemetry/analyze',{edgeId:source.edgeId},403,'demo.auditor');
  const analyzed=await post('/telemetry/analyze',{edgeId:source.edgeId});assert.equal(analyzed.status,'ANALYZED');assert.equal(analyzed.snapshot.provenance,'SIMULATED_TELEMETRY');assert.equal(analyzed.snapshot.sourceEventIds.length,18);assert.equal(analyzed.snapshot.confidence,null);
  assert.equal((await post('/telemetry/analyze',{edgeId:source.edgeId})).reused,true);
  console.log('PASS real read-only OPC UA → authenticated MQTT → PostgreSQL + audit');
  await stop(replica);await stop(core);const cached=await until(async()=>{const s=await edgeStatus();return s.pending>=6?s:false;},'core outage cache');
  await stop(edge);edge=launch('services/edge/index.ts',env);await until(async()=>{const s=await edgeStatus();return s.pending>=cached.pending&&s.sequence>=cached.sequence;},'SQLite restart durability');
  core=launch('server/index.ts',env);await until(()=>api('/health'),'core restart');
  await until(async()=>{const s=await edgeStatus();return s.pending===0&&s.acknowledged>=cached.sequence;},'backlog replay after core restart');
  await stop(broker);const brokerCached=await until(async()=>{const s=await edgeStatus();return s.pending>=6?s:false;},'broker outage cache');
  broker=track(launchBroker(brokerFile),'broker-restart');
  await until(async()=>{const s=await edgeStatus();return s.pending===0&&s.acknowledged>=brokerCached.sequence;},'broker reconnect and drain');
  await stop(edge);
  console.log('PASS core/broker outages, edge restart, durable replay and drain');
  publisher=mqtt.connect(config.mqtt.url,{username:config.edge.username,password:config.edge.password,clientId:config.edge.username,protocolVersion:5,reconnectPeriod:0});publisher.on('error',()=>{});
  await new Promise((r,j)=>{publisher.once('connect',r);publisher.once('error',j);});
  await new Promise((r,j)=>publisher.subscribe(topicFor(source,'ack'),{qos:1},(e,g)=>e?j(e):g[0].qos>=128?j(Error('ACK denied')):r()));
  const acknowledgements=[],deliveries=[];publisher.on('message',(t,b)=>{deliveries.push({topic:t,body:b.toString()});try{const a=JSON.parse(b);if(authenticAck(a,source.acknowledgementKey))acknowledgements.push(a);}catch{}});
  let sequence=100000;
  const point=source.points[0];
  function make(patch={}){return signEvent({version:1,eventId:randomUUID(),tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,tagCode:point.tagCode,nodeId:point.nodeId,mapVersion:source.mapVersion,sequenceNo:sequence++,eventTime:new Date(Date.now()-3600000-sequence*10).toISOString(),value:3,unit:point.unit,quality:'GOOD',...patch},source.signingKey);}
  async function send(e){const offset=acknowledgements.length;await new Promise((r,j)=>publisher.publish(topicFor(source,'telemetry'),JSON.stringify(e),{qos:1},err=>err?j(err):r()));return until(()=>acknowledgements.slice(offset).find(a=>a.eventId===e.eventId),'application ACK');}
  const riskStart=Date.now()-300000;
  for(let round=0;round<2;round++){
    for(let i=0;i<6;i++)for(const tag of source.points){
      const e=make({tagCode:tag.tagCode,nodeId:tag.nodeId,unit:tag.unit,value:tag.tagCode==='vibration_rms'?99:tag.tagCode==='bearing_temperature'?200:90,eventTime:new Date(riskStart+i*60000+round*1000).toISOString()});
      assert.equal((await send(e)).status,'STORED');
    }
    const result=await post('/telemetry/analyze',{edgeId:source.edgeId});assert.equal(result.status,'ANALYZED');assert.equal(result.snapshot.band,'CRITICAL');
    assert.equal((await api('/predictive/alerts')).items.filter(a=>a.deviceCode===source.deviceCode).length,1,'new abnormal windows must not open duplicate active maintenance episodes');
  }
  const alert=(await api('/predictive/alerts')).items.find(a=>a.deviceCode===source.deviceCode);
  const approved=await post(`/predictive/alerts/${alert.id}/approval`,{decision:'APPROVED',comment:'独立核对模拟采集证据，创建测试工单',expectedVersion:alert.version});assert.ok(approved.workOrderId);
  const orderId=approved.workOrderId;
  await post(`/work-orders/${orderId}/start`,{expectedVersion:1},200,'demo.technician');
  const submitted=await post(`/work-orders/${orderId}/submit`,{expectedVersion:2,failureCode:'QA-SIMULATED',cause:'模拟信号异常，不代表现场故障',action:'隔离模拟信号并复测',verification:'对照模拟器原始输入与采集链路',minutes:30,partsUsed:[]},200,'demo.technician');
  await post(`/work-orders/${orderId}/approval`,{decision:'APPROVED',comment:'独立检查模拟维修证据，批准关闭',expectedVersion:submitted.version,snapshotDigest:submitted.resolution.digest});
  assert.equal((await api(`/work-orders/${orderId}`)).state,'CLOSED');
  const good=make();assert.equal((await send(good)).status,'STORED');
  const before=(await conn.query('SELECT (SELECT count(*) FROM telemetry_points) AS points,(SELECT count(*) FROM audit_ledger) AS audits')).rows[0];
  assert.equal((await send(good)).status,'STORED');assert.deepEqual((await conn.query('SELECT (SELECT count(*) FROM telemetry_points) AS points,(SELECT count(*) FROM audit_ledger) AS audits')).rows[0],before);
  assert.equal((await send(signEvent({...good,value:4,signature:undefined},source.signingKey))).reason,'EVENT_ID_CONFLICT');
  assert.equal((await send(make({eventTime:good.eventTime,value:5}))).reason,'POINT_TIME_CONFLICT');
  assert.equal((await send(make({tenantId:'acme'}))).reason,'SOURCE_SCOPE_MISMATCH');
  assert.equal((await send(make({quality:'BAD',value:null}))).status,'STORED');
  assert.equal((await send(make({eventTime:new Date(Date.now()-7200000).toISOString()}))).status,'STORED');
  const forged=make();forged.value=9;const offset=acknowledgements.length;
  await new Promise(r=>publisher.publish(topicFor(source,'telemetry'),JSON.stringify(forged),{qos:1},r));await pause(500);
  assert.equal(acknowledgements.slice(offset).some(a=>a.eventId===forged.eventId),false);
  assert.equal((await conn.query('SELECT count(*) FROM telemetry_receipts WHERE event_id=$1',[forged.eventId])).rows[0].count,'0');
  // A database error AFTER point insertion must roll back both SQL and in-memory audit and send no stored ACK.
  await conn.query("CREATE FUNCTION qa_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA rollback'; END $$; CREATE TRIGGER qa_reject_audit BEFORE INSERT ON audit_ledger FOR EACH ROW EXECUTE FUNCTION qa_reject_audit()");
  const rollback=make(),offset2=acknowledgements.length;
  await new Promise(r=>publisher.publish(topicFor(source,'telemetry'),JSON.stringify(rollback),{qos:1},r));await pause(500);
  assert.equal((await conn.query('SELECT count(*) FROM telemetry_points WHERE id=$1',[rollback.eventId])).rows[0].count,'0');
  assert.equal(acknowledgements.slice(offset2).some(a=>a.eventId===rollback.eventId),false);
  await conn.query('DROP TRIGGER qa_reject_audit ON audit_ledger; DROP FUNCTION qa_reject_audit()');
  assert.equal((await send(rollback)).status,'STORED');
  assert.equal((await api('/audit')).chainValid,true);
  const ownTopics=topicFor(source,'telemetry'),foreign=ownTopics.replace('/sandbox/','/acme/');
  // Static ACL may grant a subscription filter but denies unauthorized message delivery.
  await new Promise(r=>publisher.subscribe([foreign,ownTopics,'#'],{qos:1},()=>r()));
  probe=mqtt.connect(config.mqtt.url,{username:probeUser,password:probePassword,clientId:probeUser,protocolVersion:5,reconnectPeriod:0});probe.on('error',()=>{});
  await new Promise((r,j)=>{probe.once('connect',r);probe.once('error',j);});
  const deliveryOffset=deliveries.length;
  await new Promise((r,j)=>probe.publish(foreignTopic,'QA cross-tenant marker',{qos:1},e=>e?j(e):r()));
  await new Promise((r,j)=>publisher.publish(ownTopics,'QA forbidden self-read marker',{qos:1},e=>e?j(e):r()));
  await pause(500);assert.equal(deliveries.slice(deliveryOffset).some(d=>d.topic===foreign||d.topic===ownTopics),false,'ACL must block foreign and unauthorized own telemetry reads');
  const forbidden=make(),offset3=acknowledgements.length;
  let deniedPublish=false;try{await new Promise((r,j)=>publisher.publish(foreign,JSON.stringify(forbidden),{qos:1},e=>e?j(e):r()));}catch{deniedPublish=true;}
  await pause(300);assert.equal(acknowledgements.slice(offset3).some(a=>a.eventId===forbidden.eventId),false);
  assert.equal((await conn.query('SELECT count(*) FROM telemetry_receipts WHERE event_id=$1',[forbidden.eventId])).rows[0].count,'0');
  const beforeBad=await post('/telemetry/analyze',{edgeId:source.edgeId});assert.equal(beforeBad.status,'ANALYZED');
  const bad=make({quality:'BAD',value:null,eventTime:new Date().toISOString()});assert.equal((await send(bad)).status,'STORED');
  assert.equal((await post('/telemetry/analyze',{edgeId:source.edgeId})).status,'HUMAN_REVIEW','latest BAD sample must not reuse an old healthy snapshot');
  const audit=await api('/audit');assert.equal(audit.chainValid,true);
  assert.equal(Number((await conn.query('SELECT count(*) FROM audit_ledger')).rows[0].count),audit.items.length);
  assert.equal((await conn.query('SELECT count(*) FROM telemetry_points GROUP BY edge_id,device_code,tag_code,event_time HAVING count(*)>1')).rowCount,0);
  assert.equal((await api('/telemetry/overview')).sources[0].low_quality,2);
  assert.equal((await simStatus()).writeRequests,0);
  await stop(core);core=launch('server/index.ts',env);await until(()=>api('/health'),'final recovery');assert.equal((await api('/audit')).chainValid,true);
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/**',route=>route.continue({headers:{...route.request().headers(),'x-tenant-id':'sandbox'}}));
  await page.goto(base+'/?view=telemetry');await page.locator('.telemetry-source').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  assert.ok((await page.locator('.telemetry-source').innerText()).includes('模拟设备'));
  await mkdir('outputs/demo-preview',{recursive:true});await page.screenshot({path:'outputs/demo-preview/17-telemetry-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'outputs/demo-preview/18-telemetry-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
  const result={date:new Date().toISOString(),broker:'Mosquitto 2.1.2 portable loopback',opcUaRealProtocolSimulator:true,readOnlyWriteRequests:0,tenantReadIsolation:true,authenticatedTopicAcl:true,crossTenantDeliveryDenied:true,crossTenantPublishDenied:deniedPublish,perEventHmac:true,signedDurableAck:true,sqliteRestartRecovery:true,coreOutageReplay:true,brokerOutageReplay:true,twoCoreMqttConnectionsCoexist:true,duplicatePointAndAuditSuppressed:true,conflictingPayloadQuarantined:true,lowQualityPreserved:true,outOfOrderAccepted:true,atomicPointReceiptAuditRollback:true,restartAuditIntegrity:true,telemetryPredictionLineage:true,activeAlertEpisodeDeduplicated:true,telemetryToIndependentHumanClosedWorkOrder:true,latestBadQualityFailsClosed:true,desktopMobileBrowser:true,pageErrors:0,fieldDeviceValidated:false,timescaleEnabled:false};
  await mkdir('outputs',{recursive:true});await writePrivate(resolve('outputs/telemetry-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}catch(e){
  // Logs contain no broker passwords or token responses; print only process failures, not configuration.
  for(const [child,log] of logs)if(child.exitCode!==null&&child.exitCode!==0)console.error(log.slice(-5000));throw e;
}finally{
  await browser?.close();publisher?.end(true);probe?.end(true);for(const child of children.reverse())await stop(child).catch(()=>{});await conn?.end().catch(()=>{});
  for(const account of Object.values(dbConfig.tenants))if(/^idms_qa_(acme|sandbox)_[a-f0-9]{10}$/.test(account.database)){await admin.query(`DROP DATABASE IF EXISTS "${account.database}" WITH(FORCE)`);await admin.query(`DROP ROLE IF EXISTS "${account.user}"`);}await cleanupQaRoles(admin,dbConfig);
  await admin.end();await unlink(resolve(directory,'postgres.json')).catch(()=>{});
}
