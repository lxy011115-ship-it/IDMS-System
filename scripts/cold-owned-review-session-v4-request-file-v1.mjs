import pg from 'pg';
import {readFile,lstat,realpath,mkdir} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {authorityRuntimeV1} from '../server/identity-authority-live-v1.ts';
import {readRuntimeColdReviewV3} from './runtime-cold-readonly-control-v5.mjs';
import {coldReviewAccountV3} from './runtime-cold-review-target-v5.mjs';
import {validateColdReviewCredentialsV3,coldReviewJavaConfigV3} from './runtime-cold-review-credentials-v3.mjs';
import {reviewSourceNeedV1 as need,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {FieldRecoveryAuthorityLock} from './field-recovery-lock.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {createOwnedWorkflowReaderPeerV1,assertOwnedWorkflowReaderPeerBackendsV1,assertOwnedWorkflowReaderPeerRetiredV1,beginOwnedWorkflowReaderPeerSqlWindowV1,readOwnedWorkflowReaderPeerSqlWindowV1,finishOwnedWorkflowReaderPeerSqlWindowV1} from './workflow-review-reader-lifecycle-v8-request-file-v1.mjs';
const records=new WeakMap(),family=0x49445246,same=(a,b)=>canonical(a)===canonical(b),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const norm=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
async function original(config,recoveryId){
 const s=await readRuntimeColdReviewV3(config.trust),i=s.details.review;
 need(s.phase==='REVIEW_READY_V3'&&i?.format==='COLD_READONLY_REVIEW_INTENT_V3'&&i.recoveryId===recoveryId&&i.sourceHash===config.trust.sourceHash&&i.controlId===config.trust.controlId&&i.result?.format==='COLD_READONLY_REVIEW_RESULT_V3'&&i.result.recoveryId===recoveryId&&i.result.businessAdmissionGranted===false&&i.result.fullFactsCheck?.sourceFullFactsSha256===s.source.fullFacts.sha256,'COLD_OWNED_ORIGINAL_READY_INTENT');
 need(i.directory===join(config.workDirectory,'review-'+recoveryId)&&await realpath(i.directory)===i.directory&&i.credentialFile===join(i.directory,'readers.private.json'),'COLD_OWNED_ORIGINAL_INTENT_PATH');
 const stat=await lstat(i.credentialFile);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=1024**2,'COLD_OWNED_ORIGINAL_CREDENTIAL_FILE');
 const bytes=await readFile(i.credentialFile);need(hash(bytes)===i.credentialSha256,'COLD_OWNED_ORIGINAL_CREDENTIAL_CHANGED');
 const credentials=validateColdReviewCredentialsV3(JSON.parse(bytes.toString('utf8')),s.source,config.trust,recoveryId);
 need(credentials.host===config.account.host&&credentials.port===config.account.port&&i.result.credentialSha256===i.credentialSha256,'COLD_OWNED_ORIGINAL_CREDENTIAL_ENDPOINT');
 need(await realpath(s.details.targetDirectory)===s.details.targetDirectory&&norm(s.details.targetDirectory)!==norm(s.source.inventory.identity.directory),'COLD_OWNED_ORIGINAL_TARGET');
 return{s,credentials,intentSha256:hash(i),config:coldReviewJavaConfigV3(credentials)};
}
async function rootIdentity(r,c){
 const v=(await c.query("SELECT (pg_control_system()).system_identifier::text AS system_id,current_setting('data_directory') AS directory,session_user::regrole::oid::text AS control_oid,current_user::regrole::oid::text AS current_oid,host(inet_server_addr()) AS host,inet_server_port() AS port,pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
 need(v&&v.system_id===r.source.inventory.identity.system_id&&v.control_oid===r.source.inventory.identity.control_oid&&v.current_oid===v.control_oid&&norm(v.directory)===norm(r.targetDirectory)&&v.host==='127.0.0.1'&&Number.isInteger(v.port)&&v.port>1024&&v.port<=65535&&(!r.serverPort||r.serverPort===v.port),'COLD_OWNED_TARGET_IDENTITY');
 return v;
}
async function retired(r,c){
 for(const p of[...r.retired]){
  let present=true;for(let n=0;n<30&&present;n++){present=(await c.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2) AS value',[p.pid,p.started])).rows[0].value;if(present)await new Promise(ok=>setTimeout(ok,50));}
  need(!present,'COLD_OWNED_PRIOR_ROOT_NOT_RETIRED');r.retired.splice(r.retired.indexOf(p),1);
 }
}
async function connect(r){
 const c=new pg.Client({...r.config.account,database:'postgres',connectionTimeoutMillis:5000,application_name:'idms-cold-owned-review-'+randomUUID()});r.clients.add(c);c.on('error',()=>{});
 try{await c.connect();const identity=await rootIdentity(r,c);r.frames.set(c,identity);await retired(r,c);return c;}catch(e){await end(r,c);throw e;}
}
async function end(r,c){
 if(!r.clients.has(c))return;const socket=c.connection?.stream,closed=!socket||socket.closed?Promise.resolve():new Promise(ok=>socket.once('close',ok));
 await c.end();await closed;const f=r.frames.get(c);if(f)r.retired.push(f);r.frames.delete(c);r.clients.delete(c);
}
async function revalidate(r){
 const value=await original(r.config,r.recoveryId);
 need(value.intentSha256===r.intentSha256&&hash(value.config)===r.runtimeSha256&&same(value.s.source,r.source)&&value.s.details.targetDirectory===r.targetDirectory,'COLD_OWNED_ORIGINAL_CONTEXT_CHANGED');
}
function context(r,expected){
 need(expected&&same(expected.trust,r.config.trust)&&expected.recoveryId===r.recoveryId&&expected.targetDirectory===r.targetDirectory&&expected.credentialSha256===r.credentialSha256&&same(expected.source,r.source),'COLD_OWNED_CONTEXT_NOT_ORIGINAL');
}
/** Caller supplies an original owned JVM, never a PID or a purported list of peers. */
export async function createColdOwnedReviewSessionV1({config,recoveryId,reader,peerTools}){
 need(config&&Object.keys(config).sort().join(',')==='account,authority,binDirectory,keyFile,trust,workDirectory'&&uuid(recoveryId),'COLD_OWNED_CONFIG');
 const c=structuredClone(config);c.account=coldReviewAccountV3(c.account);c.authority=authorityRuntimeV1(c.authority);
 need(c.account.user==='idms_bootstrap'&&[c.trust.storeFile,c.binDirectory,c.keyFile,c.workDirectory].every(p=>typeof p==='string'&&isAbsolute(p)),'COLD_OWNED_CONFIG');
 const value=await original(c,recoveryId),s=value.s,tenants=s.source.fullFacts.databases.filter(d=>d.map).map(d=>d.map.tenantId).sort();
 need(tenants.length>0&&new Set(tenants).size===tenants.length&&same(tenants,Object.keys(value.config.tenants).sort()),'COLD_OWNED_COMPLETE_TENANTS');
 const directory=join(c.workDirectory,'owned-session-'+randomUUID());await mkdir(directory,{recursive:false,mode:0o700});await privateDirectory(directory);
 const runtimeFile=join(directory,'intent-derived-reader.private.json');await privateNewFile(runtimeFile,canonical(value.config));
 const r={config:c,recoveryId,source:freeze(s.source),targetDirectory:s.details.targetDirectory,intentSha256:value.intentSha256,credentialSha256:s.details.review.credentialSha256,runtimeSha256:hash(value.config),runtimeFile,directory,tenants,peer:null,guards:[],guardBackends:null,phase:'CREATED',serverPort:null,clients:new Set(),frames:new WeakMap(),retired:[],busy:false,keeper:null,keepJob:null,keepFailure:null,closedProof:null};
 let root;try{root=await connect(r);r.serverPort=(await rootIdentity(r,root)).port;}finally{if(root)await end(r,root);}
 r.peer=await createOwnedWorkflowReaderPeerV1(reader,{peerTools,expectedRuntimeFile:runtimeFile,expectedServerPort:r.serverPort});
 const session=Object.freeze({
  async acquire(){need(!r.busy&&['CREATED','UNCERTAIN'].includes(r.phase),'COLD_OWNED_SESSION_PHASE');r.busy=true;try{
    await revalidate(r);await r.peer.acquire();
    if(!r.guards.length)for(const tenant of r.tenants){const guard=new FieldRecoveryAuthorityLock({host:c.account.host,port:c.account.port,bootstrapPassword:c.account.password},tenant);r.guards.push({tenant,guard});}
    for(const item of r.guards)if(!item.acquired){await item.guard.acquire();item.acquired=true;need(item.guard.authorityId===hash('postgres:'+r.source.inventory.identity.system_id),'COLD_OWNED_GUARD_AUTHORITY');}
    r.phase='HELD';const sql=await connect(r);try{await assertColdOwnedReviewPeersV1(sql,session,expectedContext(r));}finally{await end(r,sql);}
    r.keeper=setInterval(()=>{if(r.phase!=='HELD'||r.keepJob)return;r.keepJob=r.peer.probe().catch(e=>{r.keepFailure=e;}).finally(()=>{r.keepJob=null;});},30000);r.keeper.unref();
    return freeze({format:'COLD_OWNED_REVIEW_SESSION_HELD_V1',recoveryId,sourceHash:c.trust.sourceHash,intentSha256:r.intentSha256,credentialSha256:r.credentialSha256,readerLeaseId:r.peer.leaseId,guardCount:r.guards.length,allBusinessWritesClosed:true});
   }catch(e){r.phase='UNCERTAIN';throw e;}finally{r.busy=false;}},
  async close(){
   need(!r.busy,'COLD_OWNED_SESSION_BUSY');if(r.closedProof)return r.closedProof;r.busy=true;r.phase='CLOSING';if(r.keeper){clearInterval(r.keeper);r.keeper=null;}const errors=[];
   try{
    await r.keepJob;
    try{await r.peer.release();}catch(e){errors.push(e);}
    for(const item of r.guards.toReversed())try{await item.guard.close();}catch(e){errors.push(e);}
    for(const old of r.guardBackends??[])r.retired.push({pid:old.pid,started:old.started});
    let sql;try{sql=await connect(r);await retired(r,sql);const p=await assertOwnedWorkflowReaderPeerRetiredV1(sql,r.peer);r.closedProof=freeze({format:'COLD_OWNED_REVIEW_SESSION_RELEASED_V1',recoveryId,sourceHash:c.trust.sourceHash,readerLeaseId:r.peer.leaseId,originalReaderRetirement:p,originalGuardCount:r.guards.length,originalGuardsNormallyClosed:true,originalGuardBackendCount:r.guardBackends?.length??0,allOriginalGuardBackendsRetired:true});}catch(e){errors.push(e);}finally{if(sql)await end(r,sql);}
    for(const sql of[...r.clients])try{await end(r,sql);}catch(e){errors.push(e);}
    need(errors.length===0,'COLD_OWNED_SESSION_CLEANUP_UNCONFIRMED');r.phase='CLOSED';c.account.password='';c.authority.reader.clientSecret='';return r.closedProof;
   }catch(e){r.closedProof=null;r.phase='UNCERTAIN';throw e;}finally{r.busy=false;}
  },
  state(){return freeze({phase:r.phase,recoveryId,sourceHash:c.trust.sourceHash,intentSha256:r.intentSha256,readerLeaseId:r.peer.leaseId,guardCount:r.guards.length,ownedSqlClients:r.clients.size,keeperFailed:!!r.keepFailure});}
 });records.set(session,r);return session;
}
function expectedContext(r){return{trust:r.config.trust,recoveryId:r.recoveryId,source:r.source,targetDirectory:r.targetDirectory,credentialSha256:r.credentialSha256};}
/** Pure brand/context check before opening any store or SQL connection. */
export function assertColdOwnedReviewSessionBindingV1(session,{trust,recoveryId}){
 const r=records.get(session);need(r&&r.phase==='HELD'&&!r.keepFailure,'COLD_OWNED_SESSION_NOT_MINTED');
 need(same(trust,r.config.trust)&&recoveryId===r.recoveryId,'COLD_OWNED_CONTEXT_NOT_ORIGINAL');
 return freeze({recoveryId:r.recoveryId,sourceHash:r.config.trust.sourceHash,intentSha256:r.intentSha256});
}
/** Genuine guards and actual reader connections only, rechecked on both sides. */
export async function assertColdOwnedReviewPeersV1(client,session,expected){
 const r=records.get(session);need(r&&r.phase==='HELD'&&!r.keepFailure,'COLD_OWNED_SESSION_NOT_MINTED');context(r,expected);await revalidate(r);await rootIdentity(r,client);await retired(r,client);
 const readerWindow=await beginOwnedWorkflowReaderPeerSqlWindowV1(client,r.peer,{host:'127.0.0.1',port:r.serverPort,systemIdentifier:r.source.inventory.identity.system_id,directory:r.targetDirectory});
 const inspect=async()=>{
  const connections=await readOwnedWorkflowReaderPeerSqlWindowV1(client,readerWindow);
  const guards=[];
  for(const item of r.guards){
   need(item.acquired&&r.tenants.includes(item.tenant),'COLD_OWNED_GUARD_NOT_ORIGINAL');await item.guard.assertHeld();
   const key=Buffer.from(hash(item.tenant),'hex').readUInt32BE(0),rows=(await client.query("SELECT a.pid,extract(epoch FROM a.backend_start)::text AS started,a.usesysid::text AS role,a.datid::text AS db,a.application_name FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=2 AND l.mode='ExclusiveLock' AND l.granted AND l.database=(SELECT oid FROM pg_database WHERE datname='postgres') AND a.datid=l.database AND a.backend_type='client backend'",[String(family),String(key)])).rows;
   need(rows.length===1&&rows[0].role===r.source.inventory.identity.control_oid&&rows[0].application_name==='idms-field-recovery-control','COLD_OWNED_GUARD_BACKEND_CHANGED');guards.push(rows[0]);
  }
  need(guards.length===r.tenants.length&&new Set([...connections.map(v=>v.pid),...guards.map(v=>v.pid)]).size===connections.length+guards.length,'COLD_OWNED_COMPLETE_PEERS');
  return{connections,guards};
 };
 const before=await inspect(),allowed=[...before.connections.map(v=>v.pid),...before.guards.map(v=>v.pid)];
 if(r.guardBackends)need(same(r.guardBackends,before.guards),'COLD_OWNED_GUARD_BACKEND_CHANGED');else r.guardBackends=freeze(structuredClone(before.guards));
 const actual=(await client.query("SELECT pid FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid")).rows.map(v=>v.pid);
 need(actual.length===allowed.length&&actual.every(v=>allowed.includes(v)),'COLD_OWNED_OTHER_SQL_CLIENT');
 need(same(before,await inspect()),'COLD_OWNED_PEERS_CHANGED');const readerValidationWindow=await finishOwnedWorkflowReaderPeerSqlWindowV1(client,readerWindow);await revalidate(r);
 const evidenceFile=join(r.directory,'peers-'+randomUUID()+'.private.json');
 const evidence={format:'COLD_OWNED_REVIEW_PEER_EVIDENCE_V1',sourceHash:r.config.trust.sourceHash,controlId:r.config.trust.controlId,recoveryId:r.recoveryId,intentSha256:r.intentSha256,credentialSha256:r.credentialSha256,runtimeSha256:r.runtimeSha256,readerLeaseId:r.peer.leaseId,serverPort:r.serverPort,targetDirectory:r.targetDirectory,controlOid:r.source.inventory.identity.control_oid,guardOwners:r.guards.map(v=>({tenantId:v.tenant,...v.guard.ownerIdentity})),readerValidationWindow,peers:before,allOtherBackendPids:actual};
 await privateNewFile(evidenceFile,canonical(evidence));
 return freeze({format:'COLD_OWNED_REVIEW_PEERS_VERIFIED_V1',readerCount:before.connections.length,guardCount:before.guards.length,recoveryId:r.recoveryId,intentSha256:r.intentSha256,evidenceFile,evidenceSha256:hash(evidence)});
}
export async function captureColdOwnedReviewWorkflowsV1(client,session,expected){
 const r=records.get(session);need(r&&r.phase==='HELD','COLD_OWNED_SESSION_NOT_MINTED');const beforePeers=await assertColdOwnedReviewPeersV1(client,session,expected);
 const tenants=[];
 for(const tenantId of r.tenants){
  const result=await r.peer.capture(tenantId),snapshot=result.result.snapshot,reader=r.source.readerContract.readers.find(v=>v.facts.tenantId===tenantId);
  need(reader&&snapshot.tenantId===tenantId&&snapshot.authorityId===reader.facts.authorityId&&snapshot.readOnly===true&&snapshot.isolation==='repeatable read','COLD_OWNED_WORKFLOW_BINDING');
  const file=join(r.directory,'workflow-'+tenantId+'-'+randomUUID()+'.private.json'),bytes=canonical(snapshot);await privateNewFile(file,bytes);
  tenants.push({tenantId,authorityId:reader.facts.authorityId,caseCount:snapshot.cases.length,commandCount:snapshot.commandCount,snapshotSha256:hash(bytes),evidenceFile:file,originalReaderOperationEvidenceFile:result.evidenceFile});
 }
 const afterPeers=await assertColdOwnedReviewPeersV1(client,session,expected);
 return freeze({format:'COLD_OWNED_REVIEW_WORKFLOW_FACTS_V1',recoveryId:r.recoveryId,sourceHash:r.config.trust.sourceHash,sourceFullFactsSha256:r.source.fullFacts.sha256,intentSha256:r.intentSha256,readerLeaseId:r.peer.leaseId,guardCount:r.guards.length,beforePeers,afterPeers,tenants});
}
