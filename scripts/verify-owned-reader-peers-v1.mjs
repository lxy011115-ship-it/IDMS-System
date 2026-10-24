import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildWorkflowReviewReaderV2,workflowReviewReaderBuildInputsV2} from './build-workflow-review-reader-v2.mjs';
import {workflowReservationBuildInputsV1} from './build-workflow-cancel-reservation-v1.mjs';
import {lifecycleJavaSourcesV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {buildWorkflowReaderPeerToolsV1,workflowReaderPeerJavaSourcesV1} from './workflow-reader-peer-tools-v1.mjs';
import {inspectCiSourcePolicyV2} from './ci-source-policy-v2.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {canonical} from '../server/imports.ts';
import {createOwnedPlatformPgQaV1} from './fixtures/owned-platform-pg-v1-qa.mjs';
import {buildWorkflowLifecycleToolsV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {buildWorkflowReservationPortableV1,verifyOriginalWorkflowJarPortableV1} from './build-workflow-reservation-portable-v1.mjs';
import {createPredictiveCancelGracefulFlowQaV1} from './fixtures/predictive-cancel-graceful-flow-portable-v1-qa.mjs';
import {stopWorkflowLifecycleV1} from './workflow-lifecycle-portable-v1.mjs';
import {createOwnedWorkflowReaderPeerV1,assertOwnedWorkflowReaderPeerBackendsV1,assertOnlyOwnedWorkflowReaderPeersV1,assertOwnedWorkflowReaderPeerRetiredV1,launchWorkflowReviewReaderV2,bindWorkflowReviewReaderV2,stopWorkflowReviewReaderV2} from './workflow-review-reader-lifecycle-v2.mjs';

assert([5,6].includes(process.argv.length),'WORKFLOW_REVIEW_READER_ARGUMENTS');const pgBin=resolve(process.argv[2]),javaHome=resolve(process.argv[3]),mavenHome=resolve(process.argv[4]),localRepository=process.argv[5]?resolve(process.argv[5]):null,nonce=randomBytes(6).toString('hex'),work=resolve('work/owned-reader-peers-native-v1-20261025',nonce);await privateDirectory(work);
const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex'),q=s=>'"'+s.replaceAll('"','""')+'"',read=async p=>JSON.parse(await readFile(p,'utf8')),wait=ms=>new Promise(ok=>setTimeout(ok,ms));
const checks=[];
const pub=await read('docs/validation/owned-reader-peers-parent-v1.json');assert.equal(pub.commit,'e3d2d7dbf0860c06cc209300a1a6419d78a2bad6');assert.equal(pub.blobs.length,1178);for(const p of pub.blobs)assert.equal(hash(await readFile(p.path)),p.sha256,p.path);
const newSources=["scripts/build-workflow-review-reader-v2.mjs", "scripts/workflow-review-reader-lifecycle-v2.mjs", "scripts/workflow-reader-peer-tools-v1.mjs", "scripts/verify-owned-reader-peers-v1.mjs", "scripts/verify-owned-reader-peers-cleanup-v1.mjs", "docs/validation/owned-reader-peers-parent-v1.json", "docs/superpowers/specs/2026-10-25--owned-workflow-reader-peers.md", "docs/superpowers/plans/2026-10-25--owned-workflow-reader-peers.md", "scripts/start-owned-verification-job-windows-v5.ps1", "scripts/owned-verification-restricted-host-v3.cs"];
const admission=await inspectCiSourcePolicyV2('36d63806dd1f7f374631545fba9431e1342d48aeb307ff40c88fb727ae6eeb94'),paths=[...pub.blobs.map(p=>p.path),...newSources,...workflowReviewReaderBuildInputsV2.map(p=>'services/workflow-review-reader-v2/'+p),...workflowReservationBuildInputsV1.map(p=>'services/workflow/'+p),...lifecycleJavaSourcesV1,...workflowReaderPeerJavaSourcesV1,...admission.executionBaseline.blobs.map(p=>p.path)];
const graphInput=join(work,'source-graph-input.json');await privateNewFile(graphInput,canonical({format:'FIELD_SOURCE_STATIC_GRAPH_V1',paths,roots:newSources.filter(p=>/\.(mjs|ts)$/.test(p))}));
const graph=JSON.parse((await promisify(execFile)(process.execPath,['--experimental-vm-modules','scripts/field-source-static-graph-v1.mjs',resolve('.'),graphInput],{windowsHide:true,maxBuffer:4*1024**2})).stdout);assert.equal(graph.productModulesLinkedOrEvaluated,false);const sourcePins=[];for(const path of graph.paths)sourcePins.push({path,sha256:hash(await readFile(path))});await privateNewFile(join(work,'native-input-pins.json'),canonical({sourcePins,newSources,parsedModules:graph.parsedModules,productModulesLinkedOrEvaluated:false}));
console.log(JSON.stringify({nativeStarted:true,pid:process.pid,nonce,sourcePins:sourcePins.length,expectedChecks:13}));
const note=name=>{checks.push(name);console.log(JSON.stringify({nonce,check:checks.length,name}));};let cluster,tools,peerTools,peer,writerBuild,readerBuild,flow,reader,readerBound=false,readerStopped=false,flowClosed=false,report={format:'IDMS_OWNED_WORKFLOW_READER_PEERS_QA_V1',nonce,passed:false},problem;
const seenClients=new Set();const sql=async database=>{const c=await cluster.client(database);seenClients.add(c);return c;};
async function fingerprints(){const all=[];for(const [tenant,t]of Object.entries(flow.tenants)){const c=await sql(t.database);try{const tables=(await c.query("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind='r' ORDER BY n.nspname,c.relname")).rows;const facts=[];for(const v of tables){const rows=(await c.query('SELECT to_jsonb(t)::text AS value FROM '+q(v.nspname)+'.'+q(v.relname)+' t ORDER BY to_jsonb(t)::text COLLATE "C"')).rows;facts.push({schema:v.nspname,table:v.relname,rows:rows.length,sha256:hash(rows.map(r=>r.value+'\n').join(''))});}const seq=[];for(const v of(await c.query("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND c.relkind='S' ORDER BY n.nspname,c.relname")).rows)seq.push({schema:v.nspname,name:v.relname,...(await c.query('SELECT last_value::text,is_called FROM '+q(v.nspname)+'.'+q(v.relname))).rows[0]});all.push({tenant,tables:facts,sequences:seq});}finally{await c.end();seenClients.delete(c);}}return all;}
try{
 tools=await buildWorkflowLifecycleToolsV1(work,{javaHome});
 peerTools=await buildWorkflowReaderPeerToolsV1(work,tools);
 writerBuild=await buildWorkflowReservationPortableV1({tools,mavenHome,workDirectory:work,offline:!!localRepository,localRepository});
 readerBuild=await buildWorkflowReviewReaderV2({tools,mavenHome,workDirectory:work,offline:!!localRepository,localRepository});await privateNewFile(join(work,'source-pins.json'),canonical({oldManaged:pub.blobs,readerInputs:readerBuild.inputs,driverSha256:hash(await readFile('scripts/verify-workflow-review-reader-v1.mjs')),lifecycleSha256:hash(await readFile('scripts/workflow-review-reader-lifecycle-v2.mjs'))}));
 cluster=await createOwnedPlatformPgQaV1(pgBin);
 flow=await createPredictiveCancelGracefulFlowQaV1({nonce:cluster.nonce,authority:cluster.authority,adminAccount:cluster.account},work,writerBuild,tools);
 const expected={},httpSnapshots={};
 for(const tenant of Object.keys(flow.tenants)){
  const config=flow.config(tenant).workflow,id=randomUUID(),engineer='recovery-reader-engineer';let version=1,last;
  const command=async(action,actor,extra={})=>{const body={commandId:randomUUID(),entityId:id,action,expectedVersion:version,actor:{id:actor,type:'USER',permissions:[action==='create'?'predictive:approve':action==='approval'?'maintenance:approve':'maintenance:execute']},correlationId:'recovery-reader-real-qa',...extra},r=await fetch(config.baseUrl+'/v1/commands',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.serviceToken,'X-IDMS-Tenant':tenant},body:JSON.stringify({...body,requestDigest:hash(body)}),signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);last=await r.json();version=last.version;return last;};
  await command('create','recovery-reader-author',{assignee:tenant==='sandbox'?engineer:''});if(tenant==='sandbox'){await command('start',engineer);await command('submit',engineer,{evidenceDigest:'a'.repeat(64)});await command('approval','recovery-reader-independent-reviewer',{evidenceDigest:'a'.repeat(64),decision:'APPROVED',comment:'verified repair and retest'});}expected[tenant]={entityId:id,lastCommandId:last.commandId,state:last.state,version:last.version};
 }
 note('real ordinary Flowable writes create an active case and a separately approved closed case with command history');
 const writer=flow.children.at(-1);await stopWorkflowLifecycleV1(writer);assert.deepEqual(await writer.terminal,{code:0,signal:null});
 const config={format:1,purpose:'WORKFLOW_RECOVERY_READER_V1',tenants:{}},readerAccounts={},bpmnSha256=hash(await readFile('services/workflow/src/main/resources/maintenance-v1.bpmn20.xml'));
 for(const [tenant,t]of Object.entries(flow.tenants)){
  const c=await sql(t.database);try{const user='idms_review_'+cluster.nonce+'_'+tenant,password=randomBytes(32).toString('base64url');await c.query('CREATE ROLE '+q(user)+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD '+"'"+password+"'");
   await c.query('GRANT CONNECT ON DATABASE '+q(t.database)+' TO '+q(user));await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');await c.query('GRANT USAGE ON SCHEMA public TO '+q(user));await c.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO '+q(user));
   for(const n of(await c.query("SELECT nspname FROM pg_namespace WHERE nspname!~'^pg_' AND nspname<>'information_schema'")).rows)await c.query('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA '+q(n.nspname)+' FROM PUBLIC,'+q(user));
   for(const f of(await c.query("SELECT oid::regprocedure::text AS f FROM pg_proc WHERE pronamespace='pg_catalog'::regnamespace AND (proname LIKE 'lo\\_%' ESCAPE '\\' OR proname IN('lowrite','loread','loopen','loclose'))")).rows)await c.query('REVOKE EXECUTE ON FUNCTION '+f.f+' FROM PUBLIC,'+q(user));
   const roleOid=(await c.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[user])).rows[0].oid;
   for(const role of Object.values(t.roles))await c.query('ALTER ROLE '+q(role.name)+' NOLOGIN CONNECTION LIMIT 0');
   const account={...cluster.account,database:t.database,user,password};readerAccounts[tenant]=account;config.tenants[tenant]={jdbcUrl:`jdbc:postgresql://127.0.0.1:${cluster.account.port}/${t.database}`,database:t.database,databaseOid:t.databaseOid,user,roleOid,password,recoveryReadToken:randomBytes(32).toString('base64url'),recoveryAuthorityId:t.authorityId,bpmnSha256};
  }finally{await c.end();seenClients.delete(c);}
 }
 const before=await fingerprints(),file=join(work,'reader-runtime.private.json');await privateNewFile(file,canonical(config));
 let port;for(let i=0;i<30&&!port;i++){const candidate=30000+randomBytes(2).readUInt16BE()%10000,s=createServer();try{await new Promise((ok,no)=>{s.once('error',no);s.listen(candidate,'127.0.0.1',ok);});await new Promise(ok=>s.close(ok));port=candidate;}catch(e){if(!['EADDRINUSE','EACCES'].includes(e.code))throw e;}}assert(port);
 reader=await launchWorkflowReviewReaderV2({tools,workDirectory:work,jarFile:readerBuild.jar,jarSha256:readerBuild.jarSha256,runtimeFile:file,port});
 const origin='http://127.0.0.1:'+port;let ready=false;for(let i=0;i<600;i++){if(reader.process.exitCode!==null||reader.process.signalCode!==null){await reader.terminal;throw Error('READER_STARTUP_EXIT');}try{const r=await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok){assert.equal((await r.json()).mode,'RECOVERY_READ_ONLY');ready=true;break;}}catch{}await wait(100);}assert(ready,'READER_READY_TIMEOUT');await bindWorkflowReviewReaderV2(reader);readerBound=true;
 note('separate Flowable reader starts with dedicated nonowner SQL roles while all original business roles remain NOLOGIN');
 const get=(tenant,token=config.tenants[tenant].recoveryReadToken)=>fetch(origin+'/v1/recovery-state',{headers:{Authorization:'Bearer '+token,'X-IDMS-Tenant':tenant},signal:AbortSignal.timeout(30000)});
 for(const [tenant,want]of Object.entries(expected)){const r=await get(tenant);assert.equal(r.status,200);const v=await r.json();httpSnapshots[tenant]=v;assert.equal(v.readOnly,true);assert.equal(v.isolation,'repeatable read');assert.equal(v.tenantId,tenant);assert.equal(v.cases.length,1);const got=v.cases[0];for(const key of ['entityId','lastCommandId','state','version'])assert.equal(got[key],want[key]);assert(v.commandCount>0&&v.commandBytes>0&&v.commandSha256.match(/^[a-f0-9]{64}$/));assert.equal(v.activeProcessIds.length,tenant==='sandbox'?0:1);}
 note('actual read-only repeatable-read engine returns complete active and closed cases, history and original command ledger digests');
 assert.equal((await get('acme',config.tenants.sandbox.recoveryReadToken)).status,401);assert.equal((await fetch(origin+'/v1/recovery-state',{headers:{Authorization:'Bearer '+flow.config('acme').workflow.serviceToken,'X-IDMS-Tenant':'acme'}})).status,401);assert.equal((await fetch(origin+'/v1/commands',{method:'POST',headers:{Authorization:'Bearer '+config.tenants.acme.recoveryReadToken,'Content-Type':'application/json'},body:'{}'})).status,404);
 for(const account of Object.values(readerAccounts)){const c=new pg.Client(account);seenClients.add(c);try{await c.connect();await assert.rejects(c.query('UPDATE public.idms_workflow_cases SET version=version'),e=>e.code==='42501');await assert.rejects(c.query('CREATE TABLE public.not_allowed(n int)'),e=>e.code==='42501');await assert.rejects(c.query('SET SESSION AUTHORIZATION '+q(cluster.account.user)),e=>e.code==='42501');}finally{await c.end();seenClients.delete(c);}}
 note('cross-tenant and ordinary service tokens, write routes, actual SQL DML/DDL and bootstrap impersonation all reject');
 const c=await sql(flow.tenants.acme.database);try{await c.query('GRANT INSERT ON public.idms_workflow_cases TO '+q(config.tenants.acme.user));const r=await get('acme');assert.equal(r.status,500);}finally{await c.query('REVOKE INSERT ON public.idms_workflow_cases FROM '+q(config.tenants.acme.user));await c.end();seenClients.delete(c);}assert.equal((await get('acme')).status,200);
 assert.deepEqual(await fingerprints(),before);await privateNewFile(join(work,'sql-fingerprints.json'),canonical({before,after:await fingerprints()}));
 note('live privilege drift rejects the next snapshot; restored privileges revalidate and every user table/sequence stays byte-identical');

 const rootBinding={host:cluster.account.host,port:cluster.account.port,systemIdentifier:cluster.systemIdentifier,directory:cluster.source};
 const admin=await sql('postgres');
 try{await assert.rejects(assertOwnedWorkflowReaderPeerBackendsV1(admin,Object.freeze({}),rootBinding),/READER_PEER_NOT_MINTED/);}finally{await admin.end();seenClients.delete(admin);}
 const badFile=join(work,'wrong-reader-runtime.private.json');await privateNewFile(badFile,canonical({...config,purpose:'WRONG_READER'}));
 await assert.rejects(createOwnedWorkflowReaderPeerV1(reader,{peerTools,expectedRuntimeFile:badFile}),/READER_PEER_EXPECTED_CONFIG/);
 note('forged peer capability and a configuration not copied into the original JVM both reject before SQL adoption');
 peer=await createOwnedWorkflowReaderPeerV1(reader,{peerTools,expectedRuntimeFile:file});
 const held=await peer.acquire();assert.equal(peer.phase,'HELD');assert.equal(held.result.connections.length,4);
 assert.equal(new Set(held.result.connections.map(v=>v.pid)).size,4);assert(held.helperReplyConfirmed);
 assert.deepEqual((await peer.acquire()).result.connections,held.result.connections);
 const foreignLease=await createOwnedWorkflowReaderPeerV1(reader,{peerTools,expectedRuntimeFile:file}).catch(e=>e);assert.match(foreignLease.message,/READER_PEER_HANDLE_NOT_ORIGINAL/);
 note('actual owned JVM holds all four original Hikari slots in two tenant read-only repeatable-read transactions and reuses the same lease');
 for(const tenant of Object.keys(config.tenants)){assert.equal((await get(tenant)).status,503);const v=await peer.capture(tenant);assert.deepEqual(v.result.snapshot,httpSnapshots[tenant]);}
 assert.equal((await fetch(origin+'/health')).status,200);
 note('HTTP snapshots drain with 503 while complete real Flowable history and command ledgers are captured inside the original held transaction');
 const observer=await sql('postgres');try{
  const connections=await assertOnlyOwnedWorkflowReaderPeersV1(observer,peer,rootBinding);assert.deepEqual(connections,held.result.connections);
  await assert.rejects(assertOwnedWorkflowReaderPeerBackendsV1(observer,peer,{...rootBinding,systemIdentifier:'1'}),/READER_PEER_OTHER_ROOT/);
  const alien=await sql('postgres');try{await assert.rejects(assertOnlyOwnedWorkflowReaderPeersV1(observer,peer,rootBinding),/READER_PEER_OTHER_SQL_CLIENT/);assert.equal((await alien.query('SELECT 1 AS alive')).rows[0].alive,1);}finally{await alien.end();seenClients.delete(alien);}
  assert.deepEqual(await assertOnlyOwnedWorkflowReaderPeersV1(observer,peer,rootBinding),connections);
 }finally{await observer.end();seenClients.delete(observer);}
 note('bootstrap independently matches every backend start, root, database and role; a foreign SQL session rejects and stays alive');
 const originalConfig=await readFile(join(reader.directory,'runtime.private.json'));
 try{await writeFile(join(reader.directory,'runtime.private.json'),Buffer.concat([originalConfig,Buffer.from('\n')]));await assert.rejects(peer.probe(),/LIFECYCLE_DEPLOYMENT_FILE_CHANGED/);}
 finally{await writeFile(join(reader.directory,'runtime.private.json'),originalConfig);}
 assert.equal((await peer.probe()).result.connections.length,4);
 note('actual copied configuration byte drift rejects; restoring identical bytes revalidates the same original lease');
 const release=await peer.release();assert.equal(release.result.phase,'RELEASED');assert(release.result.allOriginalTransactionsRolledBack&&release.result.allOriginalPoolConnectionsRetired);
 const retirementObserver=await sql('postgres');let retirement;try{retirement=await assertOwnedWorkflowReaderPeerRetiredV1(retirementObserver,peer);}finally{await retirementObserver.end();seenClients.delete(retirementObserver);}
 await assert.rejects(peer.probe(),/READER_PEER_ALREADY_RELEASED/);assert.deepEqual(await peer.release(),release);
 await privateNewFile(join(work,'peer-evidence.private.json'),canonical({held,release,retirement,httpSnapshots}));
 for(const tenant of Object.keys(config.tenants)){const r=await get(tenant);assert.equal(r.status,200);assert.deepEqual(await r.json(),httpSnapshots[tenant]);}
 assert.deepEqual(await fingerprints(),before);
 note('original worker transactions actually roll back, all four backend identities disappear, HTTP resumes and every SQL table and sequence stays unchanged');

 peer=await createOwnedWorkflowReaderPeerV1(reader,{peerTools,expectedRuntimeFile:file});const second=await peer.acquire();assert.notEqual(second.leaseId,held.leaseId);
 const last=await peer.release();assert(last.result.allOriginalTransactionsRolledBack);await privateNewFile(join(work,'second-peer-evidence.private.json'),canonical({held:second,release:last}));
 note('a fresh lease is minted only after the original was actually released and retires through the same original worker path');

 const proof=await stopWorkflowReviewReaderV2(reader);readerStopped=true;assert(proof.helperReplyConfirmed&&proof.gracefulWebCompleted&&proof.poolCallbacksLogged&&proof.targetSignalSent===false);assert.deepEqual(await reader.terminal,{code:0,signal:null});
 note('owned reader JVM shuts down normally with original receipts, both pool callbacks and actual zero exit');
 report={...report,passed:true,checks,readerNormalStop:proof,ownedReaderPeerCapabilityImplemented:true,ownedReaderPeerCapabilityIntegrated:false,sourceReaderCaptureContractImplemented:true,recoveryReviewIntegrationComplete:false,currentOidcReviewerVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
}catch(e){problem=e;process.exitCode=1;await privateNewFile(join(work,'failure.private.json'),JSON.stringify({message:e.message,stack:e.stack,readerLog:reader?.log}));console.error(JSON.stringify({readerNativeFailed:true,code:typeof e.code==='string'?e.code:null,messageSha256:hash(e.message),completedChecks:checks.length,work}));}
finally{
 const errors=[];for(const c of seenClients)try{await c.end();}catch(e){errors.push(hash(e.message));}
 if(peer&&peer.phase!=='RELEASED')try{await peer.release();}catch(e){errors.push(hash(e.message));}
 if(reader&&!readerStopped)try{if(reader.process.exitCode!==null||reader.process.signalCode!==null)await reader.terminal;else{if(!readerBound){await bindWorkflowReviewReaderV2(reader);readerBound=true;}await stopWorkflowReviewReaderV2(reader);readerStopped=true;}}catch(e){errors.push(hash(e.message));}
 if(flow&&!flowClosed)try{await flow.close();flowClosed=true;}catch(e){errors.push(hash(e.message));}
 if(cluster?.active)try{await cluster.stop();}catch(e){errors.push(hash(e.message));}
 for(const p of sourcePins)assert.equal(hash(await readFile(p.path)),p.sha256);if(writerBuild)await verifyOriginalWorkflowJarPortableV1(writerBuild);
 report={...report,passed:report.passed&&!errors.length,checks,sourcePins,work,cleanup:{errors,readerTerminal:!reader||reader.process.exitCode!==null||reader.process.signalCode!==null,originalWriterTerminal:flow?.children.every(c=>c.process.exitCode!==null||c.process.signalCode!==null)??true,flowClosed,postgresStopped:cluster?.processes.every(p=>p.stopped)??true,clusterDirectory:cluster?.work}};if(!report.passed)process.exitCode=1;await privateNewFile(join(work,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({nonce,passed:report.passed,checks:checks.length,cleanupErrorCount:report.cleanup.errors.length,fullGoalComplete:false}));
}
