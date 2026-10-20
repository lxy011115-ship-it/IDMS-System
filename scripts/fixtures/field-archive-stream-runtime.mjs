import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import net from 'node:net';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,basename,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadFieldEdgeConfiguration,clearFieldEdgeConfiguration} from '../../services/field/edge-config.ts';
import {FieldLeaseClient} from '../../services/field/lease-client.ts';
import {LeasedFieldReadOnlyClient} from '../../services/field/leased-readonly.ts';
import {FieldSpool} from '../../services/field/spool.ts';
import {prepareFieldEdgeDirectory,checkFieldEdgeStreams} from '../../services/field/edge-directory.ts';
import {FieldMqttTransport} from '../../services/field/mqtt-transport.ts';
import {publicFieldProfileDigest} from '../../integrations/field-profile.ts';
import {decodeFieldMessage,verifyFieldAck,fieldStreamBinding,fieldStreamId} from '../../integrations/field-event.ts';
import {writePrivate} from '../keycloak-local.mjs';

export async function streamUntil(check,label,ms=20000){const end=performance.now()+ms;while(performance.now()<end){if(await check())return;await new Promise(ok=>setTimeout(ok,20));}throw Error('Archive stream QA timeout: '+label);}
export function archivedQueueRows(file){const db=new DatabaseSync(file,{readOnly:true});try{return {metadata:db.prepare('SELECT * FROM metadata ORDER BY name').all().map(r=>({...r})),pending:db.prepare('SELECT * FROM pending ORDER BY sequence_no').all().map(r=>({...r})),acknowledged:db.prepare('SELECT * FROM acknowledged ORDER BY sequence_no').all().map(r=>({...r}))};}finally{db.close();}}
export async function startArchiveStreamCore(directory,runtimeFile){
 const actual=await realpath(directory),base=await realpath(resolve('work/field-channel-20261017')),rel=relative(base,actual),suffix=basename(actual).replace('formal-archive-','');assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'));assert.match(basename(actual),/^formal-archive-[a-f0-9]{10}$/);
 const runtime=JSON.parse(await readFile(runtimeFile));for(const [tenant,a]of Object.entries(runtime.tenants))assert.ok(a.database==='idms_fieldarchiveqa_'+tenant+'_'+suffix||tenant==='acme'&&a.database==='idms_fieldarchivetarget_'+suffix);
 const endpointFile=resolve(directory,'stream-endpoint.json');let port;try{const endpoint=JSON.parse(await readFile(endpointFile));assert.equal(endpoint.format,'idms-field-owned-stream-endpoint-v1');assert.equal(endpoint.suffix,suffix);assert.ok(Number.isInteger(endpoint.port)&&endpoint.port>0&&endpoint.port<=65535);port=endpoint.port;}catch(e){if(e.code!=='ENOENT')throw e;const socket=net.createServer();await new Promise(ok=>socket.listen(0,'127.0.0.1',ok));port=socket.address().port;await new Promise(ok=>socket.close(ok));await writePrivate(endpointFile,JSON.stringify({format:'idms-field-owned-stream-endpoint-v1',suffix,port}));}
 const child=fork(resolve('scripts/fixtures/field-workspace-probe.mjs'),[],{windowsHide:true,env:{...process.env,NODE_ENV:'test',PORT:String(port),IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:resolve(runtimeFile),IDMS_DEMO_NAMESPACE:'fieldworkspaceqa-'+suffix,IDMS_AUTH_MODE:'demo',IDMS_PUBLIC_ORIGIN:'http://127.0.0.1:'+port,IDMS_TELEMETRY_CONFIG:'',IDMS_FIELD_PLATFORM_CONFIG:resolve(directory,'platform.json'),IDMS_FIELD_INTAKE_CONFIG:resolve(directory,'intake-materials.json'),IDMS_WORKFLOW_CLIENT_CONFIG:process.env.IDMS_FIELD_REVIEW_WORKFLOW_QA==='1'?resolve(directory,'workflow-client.json'):'',IDMS_AI_CLIENT_CONFIG:'',IDMS_PREDICTOR_URL:'',IDMS_CAPACITY_CONFIG:''},stdio:['ignore','pipe','pipe','ipc']});
 let terminal=false,log='',bootResolve,bootReject;const pending=new Map(),entered=new Set(),boot=new Promise((ok,no)=>{bootResolve=ok;bootReject=no;});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log=(log+b).slice(-6000));
 const closed=new Promise((ok,no)=>{child.once('error',e=>{bootReject(e);no(e);});child.once('close',(code,signal)=>{terminal=true;const e=Error('Archive stream core exited '+code+'/'+signal+' '+log);bootReject(e);for(const r of pending.values()){clearTimeout(r.timer);r.no(e);}pending.clear();ok({code,signal});});});
 child.on('message',m=>{if(m.type==='READY')bootResolve();if(m.type==='BOOT_ERROR')bootReject(Error('Archive stream core boot failed: '+m.message));if(m.type==='ENTERED')entered.add(m.target);if(m.type==='DONE'){const r=pending.get(m.id);if(r){pending.delete(m.id);clearTimeout(r.timer);m.error?r.no(Error(m.error.message)):r.ok(m.value);}}});
 const call=(type,body={})=>new Promise((ok,no)=>{if(!child.connected)return no(Error('Archive stream core disconnected'));const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);no(Error('Archive stream IPC timeout '+type));},20000);pending.set(id,{ok,no,timer});child.send({type,id,...body});});
 const release=()=>{if(child.connected)child.send({type:'RELEASE'});};
 const close=async()=>{if(terminal){await closed;return;}release();try{await call('CLOSE');}finally{if(!terminal){const timer=setTimeout(()=>child.kill(),10000);try{await closed;}finally{clearTimeout(timer);}}}assert.equal(terminal,true);};
 try{await Promise.race([boot,new Promise((_,no)=>{const t=setTimeout(()=>no(Error('Archive stream core startup timeout')),30000);t.unref();})]);return {url:'http://127.0.0.1:'+port,child,entered,call,release,close,get terminal(){return terminal;}};}catch(e){child.kill();await closed;throw e;}
}

// Source and target use the same real peer files, profile and keys. Only the
// machine endpoint and new SQLite path differ; this is the SDK, not a fake read.
export async function openArchiveSdk(directory,core,contextLease=null){
 const config=await loadFieldEdgeConfiguration(resolve(directory,'edge-materials.json')),profile=config.publicProfile,digest=publicFieldProfileDigest(profile),sdk=new FieldLeaseClient({profile,requestKey:config.lease.requestKey,platformPublicKey:config.lease.publicKey,url:config.lease.url,timeoutMs:3000});let reader,edge,spool;
 const authorize=()=>{sdk.authorize({profileDigest:digest,phase:'FORMAL_ARCHIVE_STREAM'});return sdk.currentLease();};
 assert.equal(config.lease.url,core.url+'/api/v1/field-channel/lease');
 const close=async()=>{try{await edge?.close();}finally{try{if(reader)await reader.close();else await sdk.close();}finally{spool?.close();clearFieldEdgeConfiguration(config);}}};
 return {config,profile,sdk,authorize,
  async read(){reader=new LeasedFieldReadOnlyClient(config.profile,config.opcua,sdk);return reader.readOnce();},
  async connect(receive){edge=new FieldMqttTransport({profile,url:config.mqtt.url,role:'EDGE',materials:config.mqtt.materials,authorize:sdk.authorize,receive});await edge.start();return edge;},
  spool(file,lease=contextLease){spool=new FieldSpool(file,{profile,contextLease:lease,eventKey:config.eventKey,platformPublicKey:config.lease.publicKey,authorize});return spool;},
  close};
}

export async function archiveStreamSpoolPath(config,lease){const id=fieldStreamId(fieldStreamBinding(config.publicProfile,lease,config.lease.publicKey)),directory=await prepareFieldEdgeDirectory(config.root,config.spool.directory);return (await checkFieldEdgeStreams(directory,id,config.spool.maxStreams)).path;}

export async function createArchiveSourceStream(directory,runtimeFile){
 let core,session,closed=false;
 try{
  core=await startArchiveStreamCore(directory,runtimeFile);const edgeFile=resolve(directory,'edge-materials.json'),edgeConfig=JSON.parse(await readFile(edgeFile));edgeConfig.lease.url=core.url+'/api/v1/field-channel/lease';await writePrivate(edgeFile,JSON.stringify(edgeConfig));await streamUntil(async()=>{const r=await fetch(core.url+'/api/v1/health');return (await r.json()).fieldTransactionalIntake.connected===1;},'source receiver ready');
  session=await openArchiveSdk(directory,core);const observed=await session.read(),check=await session.sdk.checkCurrent(),file=await archiveStreamSpoolPath(session.config,observed.lease),spool=session.spool(file,observed.lease);spool.append(randomUUID(),observed);const rows=spool.ready(),acks=[];assert.equal(rows.length,2);
  const edge=await session.connect(bytes=>{acks.push(decodeFieldMessage(bytes));});
  for(const row of rows){spool.attempted(row.eventId,row.digest);await edge.publish(Buffer.from(row.payload));await streamUntil(()=>acks.some(a=>a.body.eventId===row.eventId),'real source committed ACK');assert.equal(verifyFieldAck(acks.find(a=>a.body.eventId===row.eventId),session.config.lease.publicKey,row.event).body.status,'STORED');}
  assert.equal(spool.stats().pending,2);await session.sdk.stopWatching();
  const oldRows=archivedQueueRows(file),record={format:'idms-field-owned-source-stream-proof-v1',spoolRelativePath:relative(directory,file).replaceAll('\\','/'),machineUrl:session.config.lease.url,profile:session.profile,lease:observed.lease,check,rows,acks,queue:oldRows};await writePrivate(resolve(directory,'old-stream-proof.json'),JSON.stringify(record));
  const proof={actualProductionCoreHttpSdkEncryptedOpcuaSqliteMtlsPostgresSource:true,actualPoints:2,actualReceipts:2,actualStoredAcksDeliberatelyNotApplied:2,oldQueuePending:2,protocolFixtureOnly:false};
  return {proof,
   async verifyRestoringAndClose(){const r=await fetch(core.url+'/api/v1/field-channel/lease/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify((await import('../../integrations/field-check.ts')).signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:Date.now(),lease:observed.lease},session.config.lease.requestKey))});assert.equal(r.status,503);assert.equal(Object.hasOwn(await r.json(),'signature'),false);await streamUntil(async()=>{const h=(await(await fetch(core.url+'/api/v1/health')).json()).fieldTransactionalIntake;return h.connected===0&&h.ownedTenants===0;},'source runtime retired by real RESTORING');await close();assert.deepEqual(archivedQueueRows(file),oldRows);proof.actualSourceRuntimeRetiredByNativeRestoring=true;proof.actualUnsignedMachineRefusalDuringRestoring=true;proof.actualSourceCoreAndSdkClosedBeforeFreeze=true;},close};
 }catch(e){await close();throw e;}
 async function close(){if(closed)return;closed=true;try{await session?.close();}finally{await core?.close();}}
}
