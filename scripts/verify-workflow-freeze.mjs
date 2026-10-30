import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fork} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createWorkflowFreezeAuthority,runWorkflowFreeze} from './workflow-freeze-control.mjs';
import {restoreWorkflowQa,cleanupWorkflowQa} from '../work/workflow-runtime-upgrade-20261018/workflow-backup.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,'')),main=await read('.local/postgres-runtime.json');
const runLabel=process.argv[2]||'verification';assert.match(runLabel,/^[a-z0-9-]{1,32}$/);assert.ok(process.argv.length<=3);
const copies=await read('work/workflow-runtime-upgrade-20261018/readiness-private-state.json'),suffix=randomUUID().replaceAll('-','').slice(0,10),nonce=randomUUID().replaceAll('-','').slice(0,12),directory=resolve('.local/workflow-freeze-qa',nonce);
const authorityName='idms_workflowcontrol_'+nonce,probeRole='idms_workflowprobeqa_'+nonce,probePassword=randomBytes(32).toString('base64url');
const admin=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres'}),accounts=[],clients=[],children=[],closed=new Map();
let authority,config,configFile,probeCreated=false;const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const q=v=>'"'+v.replaceAll('"','""')+'"';
async function client(account,database=account.database||accounts[0].database){const c=new pg.Client({host:main.host,port:main.port,...account,database,connectionTimeoutMillis:1500,query_timeout:3000});c.on('error',()=>{});clients.push(c);await c.connect();return c;}
const rootAccount={user:'idms_bootstrap',password:main.bootstrapPassword};
async function sourceRead(fn){const c=await client(rootAccount,accounts[0].database);try{return await fn(c);}finally{await c.end();}}
async function rejectedConnect(account,database=accounts[0].database){const c=new pg.Client({host:main.host,port:main.port,...account,database,connectionTimeoutMillis:1500});c.on('error',()=>{});try{await assert.rejects(c.connect(),e=>['28000','53300','42501'].includes(e.code));}finally{await c.end().catch(()=>{});}}
async function attrs(){return (await admin.query('SELECT r.rolcanlogin,d.datconnlimit FROM pg_roles r,pg_database d WHERE r.rolname=$1 AND d.datname=$2',[config.source.user,config.source.database])).rows[0];}
async function absent(connection){for(let i=0;i<100;i++){if(!(await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[connection.pid,connection.backendStart])).rowCount)return;await pause(25);}throw Error('Owned controller backend terminal state not observed');}
function launch(operation,action,hold=''){
 const child=fork('scripts/fixtures/workflow-freeze-controller.mjs',[configFile,operation,action,hold],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(child);child.stdout.resume();child.stderr.resume();
 let barrierResolve,barrierReject,resultResolve,barrierSeen=false,lastPhase='none';const barrier=new Promise((ok,reject)=>{barrierResolve=ok;barrierReject=reject;}),result=new Promise(ok=>{resultResolve=ok;});barrier.catch(()=>{});
 closed.set(child,new Promise(ok=>child.once('close',(code,signal)=>{if(hold&&!barrierSeen)barrierReject(Error('Controller closed before '+hold+'; code='+code));ok({code,signal});})));child.on('error',()=>{});
 child.on('message',m=>{if(m.type==='PHASE')lastPhase=m.phase;if(m.type==='BARRIER'){barrierSeen=true;barrierResolve(m);}if(m.type==='RESULT'||m.type==='ERROR'){if(m.type==='ERROR'){m.message+=' lastPhase='+lastPhase;barrierReject(Error(m.code+': '+m.message));}resultResolve(m);}});
 return {child,barrier,result};
}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('QA timeout: '+label)),20000);})]);}finally{clearTimeout(timer);}}
async function fresh(operation,action){const ch=launch(operation,action),r=await bounded(ch.result,action);const terminal=await bounded(closed.get(ch.child),'controller close');assert.equal(terminal.code,0,r.code+': '+r.message);assert.equal(r.type,'RESULT');return r.result;}
async function killAt(operation,action,phase){const ch=launch(operation,action,phase),reached=await bounded(ch.barrier,phase);ch.child.kill();await bounded(closed.get(ch.child),'killed controller close');await absent(reached.connection);return reached;}
let proof;
try{
 await admin.connect();await privateDirectory(directory);
 const restored=await restoreWorkflowQa(main,copies.backups.acme,'acme',suffix);accounts.push(restored.account);
 authority=await createWorkflowFreezeAuthority({host:main.host,port:main.port,bootstrapPassword:main.bootstrapPassword},authorityName);
 config={format:'idms-workflow-freeze-config-v1',authority,source:{scope:'QA',tenantId:'acme',database:restored.account.database,user:restored.account.user}};
 configFile=join(directory,'control.json');await privateNewFile(configFile,JSON.stringify(config));
 await admin.query('CREATE ROLE '+q(probeRole)+" LOGIN PASSWORD '"+probePassword+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");probeCreated=true;
 await admin.query('GRANT CONNECT ON DATABASE '+q(config.source.database)+' TO '+q(probeRole));
 const probe={user:probeRole,password:probePassword};const p=await client(probe);await p.end();
 await rejectedConnect(restored.account,authorityName);
 await assert.rejects(runWorkflowFreeze({...config,source:{...config.source,database:'postgres',user:'postgres'}},randomUUID(),'prepare'),e=>e.code==='WF_FENCE_SOURCE');
 await assert.rejects(runWorkflowFreeze({...config,authority:{...authority,systemIdentifier:'1234567890123456789'}},randomUUID(),'prepare'),e=>e.code==='WF_FENCE_AUTHORITY_BINDING');
 await assert.rejects(runWorkflowFreeze({...config,unexpected:true},randomUUID(),'prepare'),e=>e.code==='WF_FENCE_CONFIG');
 await admin.query('GRANT CONNECT ON DATABASE '+q(authorityName)+' TO '+q(probeRole));
 await assert.rejects(runWorkflowFreeze(config,randomUUID(),'prepare'),e=>e.code==='WF_FENCE_AUTHORITY_PRIVILEGES');
 await admin.query('REVOKE CONNECT ON DATABASE '+q(authorityName)+' FROM '+q(probeRole));
 const before=await attrs();assert.deepEqual(before,{rolcanlogin:true,datconnlimit:-1});
 // Reproduce a stale activity snapshot, then prove the refresh used by production sees the real exit.
 const staleWriter=await client(restored.account),staleObserver=await client(rootAccount,'postgres');
 const staleIdentity=(await staleWriter.query('SELECT pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS started')).rows[0];
 await staleObserver.query('BEGIN');assert.equal((await staleObserver.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[staleIdentity.pid])).rows[0].n,1);
 await admin.query('SELECT pg_terminate_backend(pid,5000) FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[staleIdentity.pid,staleIdentity.started]);
 await absent({pid:staleIdentity.pid,backendStart:staleIdentity.started});
 assert.equal((await staleObserver.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[staleIdentity.pid])).rows[0].n,1);
 await staleObserver.query('SELECT pg_stat_clear_snapshot()');assert.equal((await staleObserver.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1',[staleIdentity.pid])).rows[0].n,0);
 await staleObserver.query('ROLLBACK');await staleObserver.end();await staleWriter.end().catch(()=>{});
 const live=await client(restored.account);await live.query('BEGIN');
 const marker=randomUUID();await live.query('INSERT INTO idms_workflow_commands(command_id,request_digest,response) VALUES($1,$2,$3::jsonb)',[marker,'a'.repeat(64),JSON.stringify({qaUncommitted:true})]);
 for(const name of ['act_evt_log_log_nr__seq','act_hi_tsk_log_id__seq'])assert.equal((await live.query('SELECT nextval($1::regclass)::text AS v',['public.'+name])).rows[0].v,'1');
 const op=randomUUID();assert.equal((await runWorkflowFreeze(config,op,'prepare')).phase,'PREPARED');let oldStillLiveAtFence=false;
 const frozen=await runWorkflowFreeze(config,op,'freeze',{onPhase:async phase=>{if(phase==='FENCED'){
  await rejectedConnect(restored.account);await rejectedConnect(probe);assert.equal((await live.query('SELECT 1 AS n')).rows[0].n,1);oldStillLiveAtFence=true;
 }}});
 assert.equal(frozen.phase,'DRAINED');assert.equal(frozen.recordedOldBackendDrainCount,1);assert.ok(oldStillLiveAtFence);await assert.rejects(live.query('SELECT 1'));
 assert.deepEqual(await attrs(),{rolcanlogin:false,datconnlimit:0});assert.deepEqual(await runWorkflowFreeze(config,op,'freeze'),frozen);
 await sourceRead(async c=>{assert.equal((await c.query('SELECT count(*)::int AS n FROM idms_workflow_commands')).rows[0].n,0);for(const name of ['act_evt_log_log_nr__seq','act_hi_tsk_log_id__seq']){const row=(await c.query('SELECT last_value::text,is_called FROM public.'+q(name))).rows[0];assert.deepEqual(row,{last_value:'1',is_called:true});}});
 const unexpected=await client(rootAccount,config.source.database);await assert.rejects(runWorkflowFreeze(config,op,'release'),e=>e.code==='WF_FENCE_OTHER_SESSION');assert.deepEqual(await attrs(),{rolcanlogin:false,datconnlimit:0});await unexpected.end();
 assert.equal((await runWorkflowFreeze(config,op,'release')).phase,'RELEASED');assert.deepEqual(await attrs(),before);
 const resumed=await client(restored.account);await resumed.query('INSERT INTO idms_workflow_commands(command_id,request_digest,response) VALUES($1,$2,$3::jsonb)',[randomUUID(),'b'.repeat(64),JSON.stringify({qaResumed:true})]);
 for(const name of ['act_evt_log_log_nr__seq','act_hi_tsk_log_id__seq'])assert.equal((await resumed.query('SELECT nextval($1::regclass)::text AS v',['public.'+name])).rows[0].v,'2');await resumed.end();
 await assert.rejects(runWorkflowFreeze(config,op,'freeze'),e=>e.code==='WF_FENCE_ALREADY_RELEASED');
 const unknown=await client(probe);await assert.rejects(runWorkflowFreeze(config,randomUUID(),'prepare'),e=>e.code==='WF_FENCE_OTHER_SESSION');assert.deepEqual(await attrs(),before);await unknown.end();
 const drift=randomUUID();await runWorkflowFreeze(config,drift,'prepare');await runWorkflowFreeze(config,drift,'freeze');
 await admin.query('ALTER DATABASE '+q(config.source.database)+' CONNECTION LIMIT 1');
 await assert.rejects(runWorkflowFreeze(config,drift,'status'),e=>e.code==='WF_FENCE_CATALOG_DRIFT');await assert.rejects(runWorkflowFreeze(config,drift,'release'),e=>e.code==='WF_FENCE_CATALOG_DRIFT');assert.deepEqual(await attrs(),{rolcanlogin:false,datconnlimit:1});
 // External QA injector restores its own drift; production control never repairs it implicitly.
 await admin.query('ALTER DATABASE '+q(config.source.database)+' CONNECTION LIMIT 0');await runWorkflowFreeze(config,drift,'release');
 const crashCases=[];
 for(const phase of ['PREPARE_BEFORE_COMMIT','PREPARED','FENCE_BEFORE_COMMIT','FENCED','DRAIN_BEFORE_COMMIT','DRAINED','RELEASE_BEFORE_COMMIT','RELEASED']){
  console.log('Actual workflow controller crash case: '+phase);
  const id=randomUUID(),action=phase.startsWith('PREPARE')?'prepare':phase.startsWith('RELEASE')?'release':'freeze';
  if(action!=='prepare')await runWorkflowFreeze(config,id,'prepare');if(action==='release')await runWorkflowFreeze(config,id,'freeze');
  let oldWriter;if(['FENCED','DRAIN_BEFORE_COMMIT'].includes(phase)){oldWriter=await client(restored.account);await oldWriter.query('BEGIN');await oldWriter.query('SELECT 1');}
  if(phase==='PREPARED'){
   const held=launch(id,'prepare',phase),at=await bounded(held.barrier,'parallel held lock');
   await assert.rejects(runWorkflowFreeze(config,randomUUID(),'prepare'),e=>e.code==='WF_FENCE_BUSY');held.child.kill();await bounded(closed.get(held.child),'parallel controller close');await absent(at.connection);
  }else await killAt(id,action,phase);
  const expectedFrozen=['FENCED','DRAIN_BEFORE_COMMIT','DRAINED','RELEASE_BEFORE_COMMIT'].includes(phase);assert.deepEqual(await attrs(),expectedFrozen?{rolcanlogin:false,datconnlimit:0}:before);
  if(phase==='PREPARE_BEFORE_COMMIT')await fresh(id,'prepare');
  if(!phase.startsWith('RELEASE'))assert.equal((await fresh(id,'freeze')).phase,'DRAINED');
  assert.equal((await fresh(id,'release')).phase,'RELEASED');assert.deepEqual(await attrs(),before);await oldWriter?.end().catch(()=>{});
  crashCases.push({phase,actualChildProcessKilledAndClosed:true,actualBackendIdentityAbsentBeforeResume:true,freshControllerSameOperationRecovers:true,catalogAndControlCommitAtomic:true});
 }
 const verify=await client(restored.account);assert.equal((await verify.query('SELECT count(*)::int AS n FROM idms_workflow_commands')).rows[0].n,1);await verify.end();
 const oidOperation=randomUUID();await runWorkflowFreeze(config,oidOperation,'prepare');
 const oldDatabase=(await admin.query('SELECT oid::text,datdba::text,datconnlimit,datacl::text FROM pg_database WHERE datname=$1',[config.source.database])).rows[0];
 await admin.query('DROP DATABASE '+q(config.source.database)+' WITH (FORCE)');
 await admin.query('CREATE DATABASE '+q(config.source.database)+' OWNER '+q(config.source.user)+' TEMPLATE template0');
 await admin.query('REVOKE CONNECT ON DATABASE '+q(config.source.database)+' FROM PUBLIC');await admin.query('GRANT CONNECT ON DATABASE '+q(config.source.database)+' TO '+q(probeRole));
 const replacement=(await admin.query('SELECT oid::text,datdba::text,datconnlimit,datacl::text FROM pg_database WHERE datname=$1',[config.source.database])).rows[0];
 assert.notEqual(replacement.oid,oldDatabase.oid);assert.deepEqual({...replacement,oid:oldDatabase.oid},oldDatabase);
 await assert.rejects(runWorkflowFreeze(config,oidOperation,'freeze'),e=>e.code==='WF_FENCE_CATALOG_DRIFT');assert.deepEqual(await attrs(),before);
 proof={verifiedAt:new Date().toISOString(),actualRestored38TableWorkflowQaSource:true,persistentRoleNoLoginAndDatabaseLimitZero:true,oldNativeBackendStayedLiveUntilExplicitDrain:true,
  oldWriteTransactionActuallyRolledBack:true,nonMvccSequenceConsumptionSurvivesOldTransactionRollback:true,newOwnerAndOtherOrdinaryConnectionsDenied:true,
  controlDatabaseInaccessibleToApplicationRole:true,exactLoginConnectionLimitAndAclRestored:true,applicationWriteAndNextvalResume:true,
  drainedReplayKeepsOriginalProofTimestamp:true,releasedOperationCannotRefreeze:true,unknownSessionAndCatalogDriftRefuseWithoutImplicitRepair:true,sourceAndAuthorityBindingRefusals:true,
  concurrentControllerLockRefusesSecondActor:true,authorityConnectPrivilegeDriftRefused:true,strictConfigUnknownFieldsRefused:true,actualStaleActivitySnapshotReproducedAndFreshReadSeesRealExit:true,actualSameNameDatabaseOidReplacementRefused:true,crashCases,realCommitReplyNetworkFaultInjected:false,
  originalWorkflowServiceStoppedOrRolesChanged:false,formalWorkflowArchiveCreated:false,productionAcceptance:false};
}finally{
 for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();for(const child of children)await closed.get(child);
 for(const c of clients)await c.end().catch(()=>{});
 await cleanupWorkflowQa(main,accounts,suffix);
 if(probeCreated)await admin.query('DROP ROLE '+q(probeRole));
 if(authority){assert.equal(authority.controlDatabase,authorityName);await admin.query('DROP DATABASE '+q(authorityName)+' WITH (FORCE)');await admin.query('DROP ROLE '+q(authorityName+'_owner'));}
 await admin.end();assert.equal(dirname(directory),resolve('.local/workflow-freeze-qa'));await rm(directory,{recursive:true,force:true});
}
assert.ok(proof);proof.ownedControllerProcessesQaDatabaseRolesAndPrivateCredentialsRemoved=true;
await privateNewFile(resolve('outputs/workflow-freeze-'+runLabel+'.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
