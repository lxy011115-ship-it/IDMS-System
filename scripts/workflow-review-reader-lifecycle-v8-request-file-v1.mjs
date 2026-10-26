import {spawn} from 'node:child_process';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {mkdir,lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory,backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {verifyWorkflowLifecycleToolsV1,runWorkflowLifecycleHelperV1,lifecycleJavaEnvV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {runWorkflowReaderPeerHelperV2,verifyWorkflowReaderPeerToolsV2} from './workflow-reader-peer-tools-v2-request-file-v1.mjs';
import {canonical} from '../server/imports.ts';
const owned=new WeakMap(),need=(v,c)=>{if(!v)throw Error(c);},hash=b=>createHash('sha256').update(b).digest('hex');
const readerPeers=new WeakMap();
const peerSqlWindows=new WeakMap();
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
async function json(path){const f=await backupRegular(path,65536);try{const v=JSON.parse((await readExactly(f.file,Number(f.stat.size),0)).toString('utf8'));await backupUnchanged(f);return v;}finally{await f.file.close();}}
async function immutableBytes(file,max){const f=await backupRegular(file,max);try{const value=await readExactly(f.file,Number(f.stat.size),0);await backupUnchanged(f);return value;}finally{await f.file.close();}}
function checkReceipt(got,binding,phase,pid){const want={format:'IDMS_WORKFLOW_LIFECYCLE_V1',phase,pid:String(pid),start:binding.start,owner:binding.owner,deployment:binding.deployment,jarSha256:binding.jarSha256,agentSha256:binding.agentSha256,requestId:binding.requestId??'-',directory:binding.directory};need(canonical(got)===canonical(want),'LIFECYCLE_RECEIPT');return got;}
async function checkFiles(state){await backupDirectory(state.directory);const s=await lstat(state.directory,{bigint:true});need(s.dev===state.directoryIdentity.dev&&s.ino===state.directoryIdentity.ino,'LIFECYCLE_DIRECTORY_CHANGED');for(const pin of state.files)need(canonical(await coldFileHashV1(pin.path,256*1024**2))===canonical({bytes:pin.bytes,sha256:pin.sha256}),'LIFECYCLE_DEPLOYMENT_FILE_CHANGED');await verifyWorkflowLifecycleToolsV1(state.tools);}
/** Starts a new, explicitly opted-in JVM. It never accepts an existing PID. */
export async function launchWorkflowReviewReaderV8({tools,workDirectory,jarFile,jarSha256,runtimeFile,cancelFile,reservationFile,port}){
 need(!cancelFile&&!reservationFile,'WORKFLOW_READER_NO_WRITE_CONFIG');need(Number.isInteger(port)&&port>1024&&port<=65535&&/^[a-f0-9]{64}$/.test(jarSha256)&&(!reservationFile||cancelFile),'LIFECYCLE_LAUNCH_INPUT');const data=await verifyWorkflowLifecycleToolsV1(tools),parent=await backupDirectory(workDirectory),owner=randomUUID(),directory=join(parent,'workflow-process-'+owner);await mkdir(directory,{recursive:false,mode:0o700});await privateDirectory(directory);const directoryIdentity=await lstat(directory,{bigint:true}),files=[],copied={},poolNames=[];
 for(const [name,file]of Object.entries({runtime:runtimeFile,...(cancelFile?{cancel:cancelFile}:{}),...(reservationFile?{reservation:reservationFile}:{})})){const bytes=await immutableBytes(file,1024**2),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));need(value?.format===1&&value?.purpose==='WORKFLOW_RECOVERY_READER_V1'&&value.tenants&&typeof value.tenants==='object'&&!Array.isArray(value.tenants),'LIFECYCLE_CONFIGURATION');const tenants=Object.keys(value.tenants);need(tenants.length>0&&tenants.length<=64&&tenants.every(t=>/^[A-Za-z0-9_-]{1,80}$/.test(t)),'LIFECYCLE_TENANTS');poolNames.push(...tenants.map(t=>({runtime:'workflow-reader-',cancel:'cancel-reconcile-',reservation:'cancel-reservation-'}[name]+t)));const path=join(directory,name+'.private.json');await privateNewFile(path,bytes);files.push({path,bytes:bytes.length,sha256:hash(bytes)});copied[name]=path;}
 const jarBytes=await immutableBytes(jarFile,256*1024**2);need(hash(jarBytes)===jarSha256,'LIFECYCLE_WORKFLOW_JAR');const jar=join(directory,'workflow.jar');await privateNewFile(jar,jarBytes);files.push({path:jar,bytes:jarBytes.length,sha256:jarSha256});
 const startupProfile={format:1,gracefulTimeoutSeconds:20,platformAdmin:true,dynamicAgent:true,lifecycleInfoLoggers:['org.springframework.boot.web.embedded.tomcat.GracefulShutdown','com.zaxxer.hikari.HikariDataSource']},deployment=hash(canonical({jarSha256,port,host:'127.0.0.1',startupProfile,configurations:files.filter(p=>p.path!==jar).map(p=>({name:p.path.slice(directory.length+1),sha256:p.sha256}))})),binding={owner,deployment,jarSha256,directory,jar,agentSha256:data.agent.sha256},env=lifecycleJavaEnvV1();for(const key of ['IDMS_WORKFLOW_CONFIG','IDMS_WORKFLOW_CANCEL_CONFIG','IDMS_WORKFLOW_CANCEL_RESERVATION_CONFIG','IDMS_WORKFLOW_READER_CONFIG','IDMS_WORKFLOW_READER_PORT'])delete env[key];env.IDMS_WORKFLOW_READER_CONFIG=copied.runtime;if(copied.cancel)env.IDMS_WORKFLOW_CANCEL_CONFIG=copied.cancel;if(copied.reservation)env.IDMS_WORKFLOW_CANCEL_RESERVATION_CONFIG=copied.reservation;
 const args=['-Xms64m','-Xmx384m','-XX:+EnableDynamicAgentLoading','-Dfile.encoding=UTF-8','-Dspring.application.admin.enabled=true','-Didms.lifecycle.owner='+owner,'-Didms.lifecycle.deployment='+deployment,'-Didms.lifecycle.jar-sha256='+jarSha256,'-Didms.lifecycle.directory='+directory,'-Didms.lifecycle.jar='+jar,'-jar',jar,'--server.address=127.0.0.1','--server.port='+port,'--server.shutdown=graceful','--spring.lifecycle.timeout-per-shutdown-phase=20s','--spring.application.admin.jmx-name=org.springframework.boot:type=Admin,name=SpringApplication',...startupProfile.lifecycleInfoLoggers.map(n=>'--logging.level.'+n+'=INFO')];await privateNewFile(join(directory,'launch-intent.json'),canonical({format:'IDMS_WORKFLOW_LIFECYCLE_LAUNCH_V1',binding,port,startupProfile,files,programs:data.programs}));
 const logFile=join(directory,'process.private.log');await privateNewFile(logFile,'');const logFd=openSync(logFile,'a'),process=spawn(data.java,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']}),state={tools,directory,directoryIdentity,files,binding,process,log:'',logFailed:false,exitObservation:null,exitProofFailed:false,poolNames,stopPromise:null,stopAccepted:false,closedProof:null,helperAttempts:0},terminal=new Promise((ok,no)=>{process.once('error',no);process.once('close',(code,signal)=>{try{fsyncSync(logFd);closeSync(logFd);}catch{state.logFailed=true;}state.exitObservation={format:'IDMS_OWNED_JVM_EXIT_V1',pid:process.pid,start:state.binding.start??null,owner,deployment,code,signal,observedAt:new Date().toISOString()};privateNewFile(join(directory,'exit-observation.json'),canonical(state.exitObservation)).then(()=>ok({code,signal}),()=>{state.exitProofFailed=true;ok({code,signal});});});});state.terminal=terminal;for(const stream of [process.stdout,process.stderr])stream.on('data',b=>{state.log=(state.log+b.toString()).slice(-100000);try{writeSync(logFd,b);}catch{state.logFailed=true;}});
 const handle=Object.freeze({process,terminal,directory,port,get log(){return state.log;},get binding(){return structuredClone(state.binding);},get stopProof(){return state.closedProof;},get helperAttempts(){return state.helperAttempts;}});owned.set(handle,state);return handle;
}
export async function bindWorkflowReviewReaderV8(handle){const s=owned.get(handle);need(s&&!s.stopPromise&&s.process.exitCode===null&&s.process.signalCode===null,'LIFECYCLE_HANDLE');await checkFiles(s);const result=await runWorkflowLifecycleHelperV1(s.tools,'PROBE',s.process.pid,s.binding),bound=JSON.parse(result.stdout.trim());need(/^\d{10,16}$/.test(bound.start),'LIFECYCLE_PROCESS_START');const candidate={...s.binding,start:bound.start};checkReceipt(bound,candidate,'BOUND',s.process.pid);if(s.binding.start)need(s.binding.start===bound.start,'LIFECYCLE_PROCESS_REPLACED');else{await privateNewFile(join(s.directory,'bound.json'),canonical(bound));s.binding=candidate;}return structuredClone(bound);}
/** Repeated calls wait on the original stop; they never signal or attach again. */
export function stopWorkflowReviewReaderV8(handle){const s=owned.get(handle);need(s,'LIFECYCLE_HANDLE');if(s.stopPromise)return s.stopPromise;
 const attempt=(async()=>{need(s.binding.start&&s.process.exitCode===null&&s.process.signalCode===null,'LIFECYCLE_NOT_BOUND_OR_TERMINAL');await checkFiles(s);const check=await runWorkflowLifecycleHelperV1(s.tools,'PROBE',s.process.pid,s.binding);checkReceipt(JSON.parse(check.stdout.trim()),s.binding,'BOUND',s.process.pid);const requestId=randomUUID(),binding={...s.binding,requestId};await privateNewFile(join(s.directory,'stop-intent.json'),canonical({format:'IDMS_WORKFLOW_LIFECYCLE_STOP_V1',binding,pid:s.process.pid}));s.stopAccepted=true;s.helperAttempts++;
  let helperReplyConfirmed=true;try{await runWorkflowLifecycleHelperV1(s.tools,'STOP',s.process.pid,binding);}catch{helperReplyConfirmed=false;}
  // An unconfirmed helper reply is not a target exit. Wait for the actual owned
  // handle, then require its complete original receipt; no force fallback.
  const terminal=await s.terminal;need(terminal.code===0&&terminal.signal===null&&!s.exitProofFailed,'LIFECYCLE_TARGET_EXIT');const started=checkReceipt(await json(join(s.directory,'shutdown-'+requestId+'.started.json')),binding,'STOP_STARTED',s.process.pid),completed=checkReceipt(await json(join(s.directory,'shutdown-'+requestId+'.completed.json')),binding,'STOP_COMPLETED',s.process.pid);await checkFiles(s);const gracefulWebCompleted=s.log.includes('Graceful shutdown complete')&&!s.log.includes('Graceful shutdown aborted'),poolCallbacksLogged=s.poolNames.every(p=>s.log.includes(p+' - Shutdown completed.'));need(!s.logFailed&&gracefulWebCompleted&&poolCallbacksLogged,'LIFECYCLE_CALLBACKS_UNPROVEN');const proof={format:'IDMS_WORKFLOW_NORMAL_STOP_PROOF_V1',binding,pid:s.process.pid,terminal,exitObservation:s.exitObservation,started,completed,helperReplyConfirmed,targetSignalSent:false,gracefulWebCompleted,poolCallbacksLogged,expectedPoolClosures:s.poolNames.length,observedAt:new Date().toISOString()};await privateNewFile(join(s.directory,'normal-stop-proof.json'),canonical(proof));s.closedProof=freeze(proof);return s.closedProof;
 })();s.stopPromise=attempt;attempt.catch(()=>{if(!s.stopAccepted&&s.stopPromise===attempt)s.stopPromise=null;});return attempt;
}

/** Minted only from this module's original newly launched JVM and copied config. */
export async function createOwnedWorkflowReaderPeerV1(handle,{peerTools,expectedRuntimeFile,expectedServerPort=null}){
 const s=owned.get(handle);need(s&&!s.stopPromise&&(!s.peer||s.peer.phase==='RELEASED'),'READER_PEER_HANDLE_NOT_ORIGINAL');
 await bindWorkflowReviewReaderV8(handle);await verifyWorkflowReaderPeerToolsV2(peerTools);
 const pin=s.files.find(p=>p.path===join(s.directory,'runtime.private.json'));need(pin,'READER_PEER_RUNTIME');
 const bytes=await immutableBytes(expectedRuntimeFile,1024**2);need(hash(bytes)===pin.sha256,'READER_PEER_EXPECTED_CONFIG');
 const config=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 need(Object.keys(config).sort().join(',')==='format,purpose,tenants'&&config.format===1&&config.purpose==='WORKFLOW_RECOVERY_READER_V1','READER_PEER_RUNTIME');
 need(expectedServerPort===null||Number.isInteger(expectedServerPort)&&expectedServerPort>1024&&expectedServerPort<=65535,'READER_PEER_SERVER_PORT');
 const r={handle,state:s,tools:peerTools,expectedServerPort,leaseId:randomUUID(),config:freeze(config),configSha256:pin.sha256,phase:'CREATED',connections:null,operation:null,sequence:0,tail:Promise.resolve(),releaseProof:null};
 const cap=Object.freeze({
  leaseId:r.leaseId,
  acquire(){return serializePeer(r,'ACQUIRE','-');},
  probe(){return serializePeer(r,'PROBE','-');},
  capture(tenantId){return serializePeer(r,'CAPTURE',tenantId);},
  release(){return serializePeer(r,'RELEASE','-');},
  get phase(){return r.phase;},
  get releaseProof(){return r.releaseProof;}
 });readerPeers.set(cap,r);s.peer=r;return cap;
}
function serializePeer(r,operation,tenantId){
 const job=r.tail.then(()=>peerOperation(r,operation,tenantId));r.tail=job.catch(()=>{});return job;
}
async function peerOperation(r,operation,tenantId){
 const s=r.state;need(owned.get(r.handle)===s&&s.peer===r&&!s.stopPromise&&s.binding.start,'READER_PEER_HANDLE_CHANGED');
 if(r.phase==='RELEASED'){need(operation==='RELEASE','READER_PEER_ALREADY_RELEASED');return r.releaseProof;}
 need(operation!=='CAPTURE'||Object.hasOwn(r.config.tenants,tenantId),'READER_PEER_TENANT');
 need(operation!=='ACQUIRE'||['CREATED','HELD','UNCERTAIN'].includes(r.phase),'READER_PEER_PHASE');
 need(operation!=='CAPTURE'||r.phase==='HELD','READER_PEER_PHASE');
 need(s.process.exitCode===null&&s.process.signalCode===null,'LIFECYCLE_HANDLE');await checkFiles(s);
 const request={operation,leaseId:r.leaseId,requestId:randomUUID(),tenantId,configSha256:r.configSha256};
 const file=join(s.directory,'reader-peer-'+request.requestId+'.private.json');r.sequence++;
 await privateNewFile(join(s.directory,'reader-peer-intent-'+r.leaseId+'-'+String(r.sequence).padStart(4,'0')+'.json'),canonical({format:'IDMS_OWNED_READER_PEER_INTENT_V1',binding:s.binding,...request}));
 r.operation=request;r.phase=operation==='RELEASE'?'RELEASING':'UNCERTAIN';
 let bound;try{
  const data=await verifyWorkflowReaderPeerToolsV2(r.tools);
  bound={...s.binding,requestId:request.requestId,agentSha256:data.agent.sha256};
  // Both fresh lifecycle probes execute around the frozen peer operation in the same short-lived helper.
  // A partial peer response cannot replace a missing final lifecycle probe or helper exit.
  const helper=await runWorkflowReaderPeerHelperV2(r.tools,s.process.pid,s.binding,request);
  checkReceipt(helper.bracket.before,s.binding,'BOUND',s.process.pid);checkReceipt(helper.bracket.after,s.binding,'BOUND',s.process.pid);
  const helperConfirmed=true;
  // A helper error alone is not the operation result. Authenticate its immutable
  // original response if one exists; otherwise preserve the same lease.
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await immutableBytes(file,4*1024**2+65536)));
  need(Object.keys(v).sort().join(',')==='binding,payload','READER_PEER_REPLY');checkReceipt(v.binding,bound,'READER_PEER',s.process.pid);
  const p=v.payload;need(Object.keys(p).sort().join(',')==='configSha256,format,leaseId,operation,requestId,result,tenantId'&&p.format==='IDMS_OWNED_READER_PEER_REPLY_V1'&&p.operation===operation&&p.leaseId===r.leaseId&&p.requestId===request.requestId&&p.tenantId===tenantId&&p.configSha256===r.configSha256,'READER_PEER_REPLY');
  validatePeerConnections(r,p.result.connections);
  if(r.connections)need(canonical(p.result.connections)===canonical(r.connections),'READER_PEER_BACKEND_CHANGED');
  if(operation==='RELEASE'){
   need(p.result.phase==='RELEASED'&&p.result.allOriginalTransactionsRolledBack===true&&p.result.allOriginalPoolConnectionsRetired===true&&p.result.httpReadsResumed===true,'READER_PEER_RELEASE_UNPROVEN');
  }else{
   need(p.result.phase==='HELD','READER_PEER_NOT_HELD');
   if(operation!=='CAPTURE')need(p.result.allPoolSlotsHeld===true&&p.result.httpReadsDrained===true,'READER_PEER_POOL_HOLD_UNPROVEN');
   else need(p.result.sameOriginalTransaction===true&&p.result.snapshot?.tenantId===tenantId&&p.result.snapshot.authorityId===r.config.tenants[tenantId].recoveryAuthorityId&&p.result.snapshot.readOnly===true&&p.result.snapshot.isolation==='repeatable read','READER_PEER_CAPTURE_BINDING');
   r.connections??=freeze(structuredClone(p.result.connections));
  }
  await checkFiles(s);need(s.process.exitCode===null&&s.process.signalCode===null,'LIFECYCLE_HANDLE');
  r.phase=operation==='RELEASE'?'RELEASED':'HELD';
  const result=freeze({...p,helperReplyConfirmed:helperConfirmed,evidenceFile:file,lifecycleBracketEvidenceFile:helper.evidenceFile});
  if(r.phase==='RELEASED')r.releaseProof=result;
  return result;
 }catch(e){r.phase='UNCERTAIN';throw Error('READER_PEER_OPERATION_UNCONFIRMED',{cause:e});}
}
function validatePeerConnections(r,rows){
 need(Array.isArray(rows)&&rows.length<=64,'READER_PEER_CONNECTIONS');
 // A never-acquired lease can only be retired with an empty tombstone.
 if(rows.length===0){need(!r.connections&&r.operation.operation==='RELEASE','READER_PEER_CONNECTIONS');return;}
 need(rows.length===2*Object.keys(r.config.tenants).length&&new Set(rows.map(v=>v.pid)).size===rows.length,'READER_PEER_CONNECTIONS');
 const expectedKeys='backendStart,currentUser,database,databaseOid,host,isolation,pid,port,postmasterStart,readOnly,roleOid,sessionUser,slot,tenantId';
 const slots=new Set();
 for(const v of rows){
  const t=r.config.tenants[v.tenantId];need(t&&Object.keys(v).sort().join(',')===expectedKeys&&Number.isInteger(v.pid)&&v.pid>0&&[0,1].includes(v.slot)&&!slots.has(v.tenantId+':'+v.slot),'READER_PEER_CONNECTIONS');slots.add(v.tenantId+':'+v.slot);
  need(v.database===t.database&&v.databaseOid===t.databaseOid&&v.roleOid===t.roleOid&&v.currentUser===t.user&&v.sessionUser===t.user&&v.readOnly==='on'&&v.isolation==='repeatable read'&&v.host==='127.0.0.1'&&Number.isInteger(v.port)&&(r.expectedServerPort===null?t.jdbcUrl==='jdbc:postgresql://127.0.0.1:'+v.port+'/'+v.database:v.port===r.expectedServerPort&&new RegExp('^jdbc:postgresql://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/'+v.database+'$').test(t.jdbcUrl))&&typeof v.backendStart==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v.backendStart)&&typeof v.postmasterStart==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v.postmasterStart),'READER_PEER_CONNECTION_BINDING');
 }
}
/** Independently match actual PostgreSQL rows between two original JVM probes. */
export async function assertOwnedWorkflowReaderPeerBackendsV1(client,cap,{host,port,systemIdentifier,directory}){
 const r=readerPeers.get(cap);need(r&&r.state.peer===r,'READER_PEER_NOT_MINTED');
 // An original keeper operation temporarily marks this same capability UNCERTAIN.
 // Wait for its original queue; a failed, released or replaced capability still rejects.
 await r.tail;need(readerPeers.get(cap)===r&&r.state.peer===r&&r.phase==='HELD','READER_PEER_NOT_MINTED');
 need(host==='127.0.0.1'&&Number.isInteger(port)&&typeof systemIdentifier==='string'&&/^[1-9][0-9]{0,19}$/.test(systemIdentifier)&&typeof directory==='string','READER_PEER_ROOT_INPUT');
 const before=(await cap.probe()).result.connections;
 const root=(await client.query("SELECT current_setting('data_directory') AS directory,(pg_control_system()).system_identifier::text AS system_id,host(inet_server_addr()) AS host,inet_server_port() AS port,to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS started")).rows[0];
 const norm=p=>(process.platform==='win32'?resolve(p).toLowerCase():resolve(p));
 need(root.system_id===systemIdentifier&&root.host===host&&root.port===port&&norm(root.directory)===norm(directory)&&before.every(v=>v.host===host&&v.port===port&&v.postmasterStart===root.started),'READER_PEER_OTHER_ROOT');
 const rows=(await client.query("SELECT pid,to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS \"backendStart\",datid::text AS \"databaseOid\",usesysid::text AS \"roleOid\",datname AS database,usename AS usr,state,xact_start IS NOT NULL AS \"inTransaction\" FROM pg_stat_activity WHERE backend_type='client backend' AND pid=ANY($1::int[]) ORDER BY pid",[before.map(v=>v.pid)])).rows;
 need(rows.length===before.length,'READER_PEER_SQL_BACKEND_MISSING');
 for(const a of rows){const b=before.find(v=>v.pid===a.pid);need(b&&a.backendStart===b.backendStart&&a.databaseOid===b.databaseOid&&a.roleOid===b.roleOid&&a.database===b.database&&a.usr===b.currentUser&&a.state==='idle in transaction'&&a.inTransaction===true,'READER_PEER_SQL_BACKEND_CHANGED');}
 const after=(await cap.probe()).result.connections;need(canonical(before)===canonical(after),'READER_PEER_BACKEND_CHANGED');return freeze(structuredClone(before));
}
/** Two complete SQL observations share the same genuine before/after JVM bracket.
 * The original session composes both guard checks and the complete peer inventory
 * inside this bracket instead of nesting four independent JVM probes. */
export async function beginOwnedWorkflowReaderPeerSqlWindowV1(client,cap,root){
 const r=readerPeers.get(cap);need(r&&r.state.peer===r,'READER_PEER_NOT_MINTED');await r.tail;need(readerPeers.get(cap)===r&&r.state.peer===r&&r.phase==='HELD','READER_PEER_NOT_MINTED');
 need(root?.host==='127.0.0.1'&&Number.isInteger(root.port)&&typeof root.systemIdentifier==='string'&&/^[1-9][0-9]{0,19}$/.test(root.systemIdentifier)&&typeof root.directory==='string','READER_PEER_ROOT_INPUT');
 const before=await cap.probe();need(r.phase==='HELD','READER_PEER_NOT_MINTED');const window=Object.freeze({});peerSqlWindows.set(window,{client,cap,r,root:structuredClone(root),before,connections:freeze(structuredClone(before.result.connections)),sqlChecks:[],finished:false});return window;
}
async function heldSqlWindow(client,window){const w=peerSqlWindows.get(window);need(w&&!w.finished&&w.client===client,'READER_PEER_SQL_WINDOW_NOT_MINTED');await w.r.tail;need(readerPeers.get(w.cap)===w.r&&w.r.state.peer===w.r&&w.r.phase==='HELD','READER_PEER_NOT_MINTED');return w;}
export async function readOwnedWorkflowReaderPeerSqlWindowV1(client,window){
 const w=await heldSqlWindow(client,window);need(w.sqlChecks.length<2,'READER_PEER_SQL_WINDOW_READ_LIMIT');const {host,port,systemIdentifier,directory}=w.root,before=w.connections;
 const root=(await client.query("SELECT current_setting('data_directory') AS directory,(pg_control_system()).system_identifier::text AS system_id,host(inet_server_addr()) AS host,inet_server_port() AS port,to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS started")).rows[0],norm=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
 need(root.system_id===systemIdentifier&&root.host===host&&root.port===port&&norm(root.directory)===norm(directory)&&before.every(v=>v.host===host&&v.port===port&&v.postmasterStart===root.started),'READER_PEER_OTHER_ROOT');
 const rows=(await client.query("SELECT pid,to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS \"backendStart\",datid::text AS \"databaseOid\",usesysid::text AS \"roleOid\",datname AS database,usename AS usr,state,xact_start IS NOT NULL AS \"inTransaction\" FROM pg_stat_activity WHERE backend_type='client backend' AND pid=ANY($1::int[]) ORDER BY pid",[before.map(v=>v.pid)])).rows;
 need(rows.length===before.length,'READER_PEER_SQL_BACKEND_MISSING');for(const a of rows){const b=before.find(v=>v.pid===a.pid);need(b&&a.backendStart===b.backendStart&&a.databaseOid===b.databaseOid&&a.roleOid===b.roleOid&&a.database===b.database&&a.usr===b.currentUser&&a.state==='idle in transaction'&&a.inTransaction===true,'READER_PEER_SQL_BACKEND_CHANGED');}
 w.sqlChecks.push(freeze(structuredClone({root,rows})));return w.connections;
}
export async function finishOwnedWorkflowReaderPeerSqlWindowV1(client,window){
 const w=await heldSqlWindow(client,window);need(w.sqlChecks.length===2,'READER_PEER_SQL_WINDOW_INCOMPLETE');const after=await w.cap.probe();need(canonical(w.connections)===canonical(after.result.connections),'READER_PEER_BACKEND_CHANGED');w.finished=true;
 const proof=freeze({format:'IDMS_OWNED_READER_SQL_WINDOW_V1',leaseId:w.r.leaseId,connections:structuredClone(w.connections),beforeOriginalOperationEvidenceFile:w.before.evidenceFile,afterOriginalOperationEvidenceFile:after.evidenceFile,sqlChecks:structuredClone(w.sqlChecks),originalJvmProbes:2,completeSqlObservations:2});peerSqlWindows.delete(window);return proof;
}
/** No advisory peer in this form: every other SQL backend must be the original reader. */
export async function assertOnlyOwnedWorkflowReaderPeersV1(client,cap,root){
 const connections=await assertOwnedWorkflowReaderPeerBackendsV1(client,cap,root);
 const peers=(await client.query("SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid")).rows.map(v=>v.pid);
 need(peers.length===connections.length&&peers.every(p=>connections.some(v=>v.pid===p)),'READER_PEER_OTHER_SQL_CLIENT');
 const after=await assertOwnedWorkflowReaderPeerBackendsV1(client,cap,root);need(canonical(connections)===canonical(after),'READER_PEER_BACKEND_CHANGED');return connections;
}
/** A fresh bootstrap observation, separate from the JVM's rollback/pool result. */
export async function assertOwnedWorkflowReaderPeerRetiredV1(client,cap){
 const r=readerPeers.get(cap);need(r&&r.phase==='RELEASED'&&r.releaseProof,'READER_PEER_NOT_RELEASED');
 const active=(await client.query("SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND (pid=ANY($1::int[]) OR usesysid=ANY($2::oid[]))",[(r.connections??[]).map(v=>v.pid),Object.values(r.config.tenants).map(t=>t.roleOid)])).rows;
 need(active.length===0,'READER_PEER_RETIREMENT_NOT_OBSERVED');return freeze({format:'IDMS_OWNED_READER_PEER_RETIREMENT_V1',leaseId:r.leaseId,originalBackendCount:r.connections?.length??0,readerRoleCount:Object.keys(r.config.tenants).length,actualReaderBackendsRemaining:0});
}
