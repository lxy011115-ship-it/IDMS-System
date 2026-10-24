import {FieldMapIssuerV1} from '../server/field-map-issuer-v1.ts';
import {FieldMapTransactionsV1} from '../server/field-map-transaction-v1.ts';
import {prepareFieldLeaseIssuance} from '../server/field-lease-issue.ts';
import {fieldCurrentLeaseCheck} from '../server/field-current-check.ts';
import {fieldRegistrySnapshot} from '../server/field-registry.ts';
import {signFieldLease,verifyFieldLease} from '../integrations/field-lease.ts';
import {signFieldCheckRequest} from '../integrations/field-check.ts';
import {compileFieldRuntimeMapV1} from '../server/field-runtime-map-v1.ts';
import {fieldCurrentLeaseCheckMapV1} from '../server/field-map-lease-v1.ts';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {createOwnedPlatformPgQaV1} from './fixtures/owned-platform-pg-v1-qa.mjs';
import {stateMapSchemaSqlV4} from './state-map-schema-v4.mjs';
import {governanceConsoleSchemaSqlV4} from './governance-console-schema-v4.mjs';
import {runtimeWriteFenceSchemaSqlV1,restrictRuntimeWriteFenceActorsV1} from './runtime-write-fence-schema-v1.mjs';
import {wrapFencedSchemaV1} from './runtime-fence-provision-v1.mjs';
import {finalizeRuntimeWriteFenceV1} from './runtime-write-fence-control-v1.mjs';
import {inspectRuntimeWriteFenceCatalogV1} from './runtime-write-fence-catalog-v1.mjs';
import {inspectStateMapCatalog} from '../server/state-map-catalog-v1.ts';
import {inspectGovernanceJobCatalogV4} from '../server/governance-job-catalog-v4.ts';
import {DomainMapV4,DomainMapSnapshot} from '../server/domain-map-v4.ts';
import {PostgresStateMapV1} from '../server/state-map-sql-v1.ts';
import {GovernanceConsoleCommandServiceV6} from '../server/governance-console-command-v6.ts';
import {GovernanceJobStoreV4} from '../server/governance-console-store-v4.ts';
import {GovernanceJobCryptoV4} from '../server/governance-job-crypto-v4.ts';
import {startGovernanceHeartbeatV4} from '../server/governance-job-heartbeat-v4.ts';
import {encodeGovernanceCandidateV6} from '../server/governance-plan-v6.ts';
import {compileGovernanceConsoleV4,consoleHeadKeyV4} from '../server/governance-console-catalog-v4.ts';
import {telemetryDomainFormat} from '../server/telemetry-map-v4.ts';
import {readCurrentFieldAdmissionMapV1,readFieldAdmissionMapV1} from '../server/field-admission-map-v1.ts';
import {fieldAdmissionDecision} from '../server/field-admission.ts';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {fieldIssuanceFixture,fieldManifest} from './fixtures/field-issuance-model.mjs';
import {tenantSeed} from './database-migrations.mjs';
import {publicGovernedSource} from '../server/source-governance.ts';
import {registrySnapshot} from '../server/registry-history.ts';
import {reconstructDomainPayload} from '../server/domain-entities-v4.ts';

assert.equal(process.argv.length,3,'FIELD_MAP_EXPLICIT_PG_BIN');
const root=resolve('.'),nonce=randomBytes(6).toString('hex'),work=resolve('work/field-map-lease-v1-20261024',nonce),hash=b=>createHash('sha256').update(b).digest('hex');
await privateDirectory(work);
const report={format:'IDMS_FIELD_MAP_LEASE_NATIVE_V1',nonce,checks:[],jobs:[],passed:false,cleanupComplete:false,originalDatabaseContacted:false,platformIdentityAuthorityExecuted:false,currentMapIssuerExecuted:false,fieldMqttDataPathExecuted:false,allProductionDependenciesRegistered:false};
let cluster,admin,controlClient;const beats=new Set(),issuers=[];let originalQuery,queryHookInstalled=false;
const note=async name=>{report.checks.push(name);await writeFile(join(work,'current.private.json'),JSON.stringify(report));console.log(JSON.stringify({nonce,check:report.checks.length,name}));};
const quoted=n=>{assert(/^idms_fmapqa_[a-z0-9_]+$/.test(n));return '"'+n+'"';};
try{
  const baseline='docs/validation/field-map-lease-parent-v1.json';assert.equal(hash(await readFile(baseline)),'26113ae51044dd2d086e5f9a9b562de14e61c9fc7e327f7c262099ee2bc05f5e');
  const parent=JSON.parse(await readFile(baseline,'utf8'));assert.equal(parent.commit,'eefed165141dec26f4c9c341cd0997ef61491c55');assert.equal(parent.blobs.length,890);
  const pins=new Map();for(const p of parent.blobs){assert.equal(hash(await readFile(p.path)),p.sha256);pins.set(p.path,p.sha256);}
  const visited=new Set();async function visit(file){file=resolve(file);const p=relative(root,file).replaceAll('\\','/');assert(p&&!p.startsWith('..')&&!isAbsolute(p));if(visited.has(p))return;visited.add(p);assert(visited.size<2048);const bytes=await readFile(file);if(pins.has(p))assert.equal(hash(bytes),pins.get(p));else pins.set(p,hash(bytes));if(/\.(ts|mjs)$/.test(p))for(const m of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\(?\s*|new URL\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g))if(/\.(ts|mjs|sql)$/.test(m[1]))await visit(resolve(dirname(file),m[1]));}
  for(const p of ['scripts/verify-field-map-lease-v1.mjs','server/governance-console-worker-v6.ts','tests/field-map-lease-v1.test.mjs','server/field-map-issuer-v1.ts','scripts/verify-field-map-lease-cleanup-v1.mjs',baseline,'package.json','package-lock.json'])await visit(p);
  report.sourcePins=[...pins].map(([path,sha256])=>({path,sha256}));report.node={version:process.versions.node,sha256:hash(await readFile(process.execPath))};
  await privateNewFile(join(work,'native-input-pins.json'),JSON.stringify({nonce,node:report.node,sourcePins:report.sourcePins}));console.log(JSON.stringify({nativeStarted:true,nonce,pid:process.pid,sourcePins:pins.size,expectedChecks:13}));
  cluster=await createOwnedPlatformPgQaV1(process.argv[2]);report.postgres={work:cluster.work,source:cluster.source,port:cluster.authority.port,systemIdentifier:cluster.systemIdentifier};admin=await cluster.client();
  const base='idms_fmapqa_'+nonce,owner=base+'_owner',app=base+'_app',reader=base+'_reader',ingress=base+'_ingress',database=base+'_data',password=randomBytes(32).toString('base64url'),readPassword=randomBytes(32).toString('base64url'),ingressPassword=randomBytes(32).toString('base64url'),deployment=canonicalDigest({nonce,database});
  for(const [name,login,pw]of [[owner,false,null],[app,true,password],[reader,true,readPassword],[ingress,true,ingressPassword]])await admin.query('CREATE ROLE '+quoted(name)+' '+(login?"LOGIN PASSWORD '"+pw+"'":'NOLOGIN')+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
  await admin.query('CREATE DATABASE '+quoted(database)+' OWNER '+quoted(owner)+" TEMPLATE template0 ENCODING 'UTF8'");await admin.query('REVOKE ALL ON DATABASE '+quoted(database)+' FROM PUBLIC');await admin.query('GRANT CONNECT ON DATABASE '+quoted(database)+' TO '+[app,reader,ingress].map(quoted).join(','));
  const account={host:cluster.authority.host,port:cluster.authority.port,user:app,password,database},readAccount={...account,user:reader,password:readPassword},ingressAccount={...account,user:ingress,password:ingressPassword},controlAccount={...cluster.account,database};
  await privateNewFile(join(work,'accounts.private.json'),JSON.stringify({account,readAccount,ingressAccount,controlAccount,deployment}));
  controlClient=new pg.Client(controlAccount);await controlClient.connect();await controlClient.query('BEGIN');
  const fenceDeployment=randomUUID();await controlClient.query(await runtimeWriteFenceSchemaSqlV1({owner,control:cluster.account.user,deployment:fenceDeployment}));await restrictRuntimeWriteFenceActorsV1(controlClient,[app,reader,ingress]);
  await controlClient.query(wrapFencedSchemaV1(await stateMapSchemaSqlV4({tenant:'acme',owner,app,reader}),'state_map_v1','state_map_ddl_start_v1'));
  await controlClient.query(wrapFencedSchemaV1(await governanceConsoleSchemaSqlV4({tenant:'acme',owner,worker:app,ingress,deployment}),'governance_jobs_v4','governance_queue_ddl_start_v4'));await controlClient.query('COMMIT');
  report.fenceBinding=await finalizeRuntimeWriteFenceV1(controlAccount);
  const authorityId=randomUUID(),authorityHash=canonicalDigest({nonce,purpose:'QA_SQL_FENCE_STATE_ONLY_NO_IDENTITY_ATTESTATION'});
  async function setFence(state){const current=(await controlClient.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0];return(await controlClient.query('SELECT runtime_write_fence_v1.set_state_v1($1,$2,$3,$4,$5,$6,$7) AS value',[fenceDeployment,current.revision,randomUUID(),state,state==='OPEN'?authorityId:null,state==='OPEN'?1:null,state==='OPEN'?authorityHash:null])).rows[0].value;}
  await setFence('OPEN');
  const ids=(await controlClient.query('SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,$1::regrole::oid::text AS app_oid,$2::regrole::oid::text AS reader_oid,$3::regrole::oid::text AS ingress_oid',[app,reader,ingress])).rows[0];
  const binding={tenantId:'acme',databaseOid:ids.database_oid,roleOid:ids.app_oid,catalogHash:await inspectStateMapCatalog(controlClient)},readBinding={...binding,roleOid:ids.reader_oid},queueBinding={tenantId:'acme',databaseOid:ids.database_oid,roleOid:ids.app_oid,catalogHash:await inspectGovernanceJobCatalogV4(controlClient),deployment},ingressBinding={...queueBinding,roleOid:ids.ingress_oid};
  report.binding=binding;report.queueBinding=queueBinding;
  await note('fresh current state map V4, console queue V4 and finalized SQL write fence share one database');
  const f=fieldIssuanceFixture(),{audits,idempotency,...business}=f.store,payload=tenantSeed({version:2,business,audits,imports:f.imports,idempotency:[...idempotency]},'acme'),sources=[publicGovernedSource(f.sources[0])],anchor=canonicalDigest(payload),control={format:telemetryDomainFormat,tenantId:'acme',status:'ACTIVE',epoch:'1',legacySealKey:'0'.repeat(64),governanceAnchorDigest:anchor},consoleCatalog=compileGovernanceConsoleV4(payload,'acme',anchor),registry=registrySnapshot({format:1,tenantId:'acme',sources});
  const candidates=[...encodeGovernanceCandidateV6(payload,0,control,sources),...consoleCatalog.entries,{namespace:'domain_head',key:consoleHeadKeyV4,valueText:JSON.stringify(consoleCatalog.head)},{namespace:'domain_head',key:'registry',valueText:JSON.stringify({tenantId:'acme',revision:'1',hash:canonicalDigest(registry),configurationHash:canonicalDigest(registry)})}];
  const initial=new Map();for(const e of candidates){const k=e.namespace+'\0'+e.key;if(initial.has(k))assert.equal(initial.get(k).valueText,e.valueText);else initial.set(k,e);}
  const map=new DomainMapV4(account,binding),proofStore=new PostgresStateMapV1(readAccount,readBinding),rows=[...initial.values()];
  for(let at=0;at<rows.length;at+=24){const snapshot=await map.snapshot();let ops;try{ops=await Promise.all(rows.slice(at,at+24).map(async e=>({...e,expected:(await snapshot.state(e.namespace,e.key)).valueHash})));}finally{await snapshot.close();}await map.commit(snapshot.head,randomUUID(),ops);}
  const evidence={format:'IDMS_FIELD_MAP_LEASE_PROOFS_V1',nonce,profile:f.profile,publicKeyPem:f.keys.publicKey.export({type:'spki',format:'pem'}),initialPayload:payload,staged:[]};
  async function membership(head,keys){const proofs=[];for(const [namespace,key]of keys){const {proof}=await proofStore.proof(namespace,key,head);proofs.push({namespace,key,proof});}return{head,proofs};}
  async function current(capture){const s=await DomainMapSnapshot.open(readAccount,readBinding),keys=[];try{const at=Date.now()+100,result=await readCurrentFieldAdmissionMapV1(f.profile,at,null,(ns,k)=>{keys.push([ns,k]);return s.get(ns,k);});if(capture)evidence[capture]={at,result,...await membership(s.head,keys)};return result;}finally{await s.close();}}
  const first=await current('initial');assert(first.decision.allowed);assert.deepEqual(first.decision,fieldAdmissionDecision(f.store,f.imports,f.profile,Date.parse(first.decision.binding.evaluatedAt),null));report.initialMapEntries=rows.length;
  await note('bounded field admission is read from the current verified state root and matches the original rules');
  let authorityCurrent=true,hold=null;const guardPhases=[];
  const tx=new FieldMapTransactionsV1(account,binding,async phase=>{guardPhases.push(phase);if(phase==='PRECOMMIT'&&hold){const gate=hold;hold=null;gate.entered();await gate.released;}assert(authorityCurrent,'QA_AUTHORITY_NOT_CURRENT');});
  const makeIssuer=snapshot=>{const keys=new Map(snapshot.channels.map(c=>[c.profile.source.edgeId,f.requestKey])),issuer=new FieldMapIssuerV1(tx,snapshot,f.keys.privateKey,keys);issuers.push(issuer);return issuer;},issuer=makeIssuer(f.snapshot);
  const observation=await issuer.observe('field-map-native-'+nonce),observationHead=await map.head();assert(observation.changed&&observation.revision==='1');const repeat=await issuer.observe('field-map-native-'+nonce);assert.equal(repeat.changed,false);assert.equal(repeat.registryEventId,observation.registryEventId);assert(canonicalEqual(await map.head(),observationHead));
  await note('runtime registry observation and audit commit together and repeated configuration leaves the root unchanged');
  async function persisted(){const s=await DomainMapSnapshot.open(account,binding,{maintenance:true});try{return await reconstructDomainPayload('acme',(ns,k)=>s.get(ns,k));}finally{await s.close();}}
  const request=f.request(),lease=await issuer.issue(request),p=await persisted(),store={...p.business,audits:p.audits,idempotency:new Map(p.idempotency)};assert.deepEqual(prepareFieldLeaseIssuance(store,p.imports,request,f.snapshot),lease.body);verifyFieldLease(lease,f.keys.publicKey,{...f.profile.source,profileDigest:f.profileDigest,requestId:request.requestId},Date.now());
  const checkRequest=()=>signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:Date.now(),lease},f.requestKey),check=checkRequest(),headBeforeCheck=await map.head(),checked=await issuer.checkCurrent(check);assert(checked.body.allowed);assert.deepEqual(checked.body,fieldCurrentLeaseCheck(store,p.imports,check,f.snapshot,f.keys.publicKey,checked.body.checkedAtMs));assert(canonicalEqual(await map.head(),headBeforeCheck));
  evidence.issuance={request,lease,checkedRequest:check,checked,head:headBeforeCheck,payload:p};
  report.currentMapIssuerExecuted=true;await note('lease signature follows committed current-map issuance and its read-only check matches the original rules');
  const replayBefore=await map.head(),replayed=await issuer.issue(request);assert.deepEqual(replayed,lease);assert(canonicalEqual(await map.head(),replayBefore));const changed=f.request(request.requestedAtMs+1,request.requestId);await assert.rejects(issuer.issue(changed),/FIELD_LEASE_REQUEST_CONFLICT/);assert(canonicalEqual(await map.head(),replayBefore));
  await note('exact authenticated lease replay retains the original expiry while a changed request is rejected');
  const concurrent=await Promise.all([issuer.issue(f.request()),issuer.issue(f.request())]);assert.notEqual(concurrent[0].body.leaseId,concurrent[1].body.leaseId);assert.notEqual(concurrent[0].body.requestId,concurrent[1].body.requestId);const concurrentPayload=await persisted();for(const l of concurrent)assert.equal(concurrentPayload.audits.filter(a=>a.objectType==='FIELD_LEASE'&&a.objectId===l.body.requestId).length,1);
  await note('concurrent real SQL issuance serializes through CAS and preserves both distinct audit positions');
  function gate(){let entered,release;const enteredPromise=new Promise(r=>entered=r),released=new Promise(r=>release=r);hold={entered,released};return{enteredPromise,release};}
  const cancel=new AbortController(),cancelGate=gate(),cancelBefore=await map.head(),cancelRequest=f.request(),cancelled=issuer.issue(cancelRequest,cancel.signal);const cancelledResult=cancelled.then(()=>({ok:true}),error=>({ok:false,error}));await cancelGate.enteredPromise;cancel.abort();cancelGate.release();const cr=await cancelledResult;assert(!cr.ok&&cr.error.message==='FIELD_MAP_CANCELLED');assert(canonicalEqual(await map.head(),cancelBefore));
  await note('cancellation after actual SQL delta and before COMMIT rolls back issuance and returns no signature');
  const authorityGate=gate(),authorityBefore=await map.head(),authorityRequest=f.request(),denied=issuer.issue(authorityRequest);const deniedResult=denied.then(()=>({ok:true}),error=>({ok:false,error}));await authorityGate.enteredPromise;authorityCurrent=false;authorityGate.release();const ar=await deniedResult;assert(!ar.ok&&ar.error.message==='QA_AUTHORITY_NOT_CURRENT');assert(canonicalEqual(await map.head(),authorityBefore));authorityCurrent=true;
  await note('injected current-authority withdrawal before COMMIT rolls back the actual SQL transaction');
  const writes=new WeakSet();let loseReply=true,lostCommitReplies=0;originalQuery=pg.Client.prototype.query;pg.Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text,result=originalQuery.apply(this,args),owned=this.connectionParameters.database===database&&this.connectionParameters.application_name==='idms-field-map-v1';if(owned&&sql?.startsWith('SELECT state_map_v1.apply_delta_v1'))writes.add(this);if(owned&&sql==='COMMIT'&&writes.has(this)&&loseReply){loseReply=false;return result.then(()=>{lostCommitReplies++;throw Error('QA_COMMITTED_RESPONSE_LOST');});}return result;};queryHookInstalled=true;
  const unknownRequest=f.request(),resolvedLease=await issuer.issue(unknownRequest);assert.equal(lostCommitReplies,1);assert(!loseReply);pg.Client.prototype.query=originalQuery;queryHookInstalled=false;const resolvedPayload=await persisted();assert.equal(resolvedPayload.audits.filter(a=>a.objectType==='FIELD_LEASE'&&a.objectId===unknownRequest.requestId).length,1);const resolvedHead=await map.head();assert.deepEqual(await issuer.issue(unknownRequest),resolvedLease);assert(canonicalEqual(await map.head(),resolvedHead));report.committedReplyLossInjected=true;report.resolvedOriginalSqlReceipt=true;
  await note('lost response after real COMMIT resolves the original SQL receipt and never duplicates issuance');
  const cycleLease=await issuer.issue(f.request()),empty=makeIssuer(fieldRegistrySnapshot({...f.snapshot,channels:[]}));await empty.observe('field-map-empty-'+nonce);await assert.rejects(issuer.issue(f.request()),/FIELD_REGISTRY_STALE/);await issuer.observe('field-map-return-'+nonce);const cycleCheck=signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:Date.now(),lease:cycleLease},f.requestKey),cycle=await issuer.checkCurrent(cycleCheck),cyclePayload=await persisted();assert.equal(cycle.body.reason,'FIELD_LEASE_REGISTRY_CHANGED');assert.deepEqual(cycle.body,fieldCurrentLeaseCheck({...cyclePayload.business,audits:cyclePayload.audits},cyclePayload.imports,cycleCheck,f.snapshot,f.keys.publicKey,cycle.body.checkedAtMs));
  await note('registry replacement withdraws stale instances and restoring the same profile does not revive an old revision');
  const fenceBefore=await map.head();await setFence('CLOSED');await assert.rejects(issuer.issue(f.request()),/RUNTIME_FENCE_CLOSED/);assert(canonicalEqual(await map.head(),fenceBefore));await setFence('OPEN');const fence=await inspectRuntimeWriteFenceCatalogV1(controlClient);assert.equal(fence.catalogHash,report.fenceBinding.catalogHash);report.fenceCatalogUnchanged=true;
  await note('closed actual SQL write fence prevents current-map lease writes without changing its catalog or root');
  const queue=new GovernanceJobStoreV4(account,queueBinding),submit=new GovernanceJobStoreV4(ingressAccount,ingressBinding),ring={format:1,activeKeyId:'qa',keys:[{keyId:'qa',key:randomBytes(32).toString('base64url')}]},crypto=new GovernanceJobCryptoV4(ring,queueBinding);await privateNewFile(join(work,'queue-key.private.json'),JSON.stringify(ring));let stagedGroups=0;
  async function execute(command,context){
   const id=randomUUID(),commandId=randomUUID(),requestHash=canonicalDigest(command),job={id,actorId:context.actorId,commandId,requestHash},deadline=Date.now()+600000;
   await submit.enqueue(context.actorId,id,commandId,command.action,requestHash,crypto.seal(command,job,'COMMAND'),crypto.seal({kind:'BEARER',value:'QA-model-reference-no-OIDC-login'},job,'GRANT'),deadline);const claim=await queue.claim();assert(claim&&claim.id===id);const heartbeat=startGovernanceHeartbeatV4(account,queueBinding,claim);beats.add(heartbeat);
   const service=new GovernanceConsoleCommandServiceV6(account,binding,sources,{commit:async(head,key,ops)=>{heartbeat.assertLive();return queue.prepare(claim,binding,head,key,ops,deadline);},publish:async(branch,key)=>{heartbeat.assertLive();return(await queue.publish(claim,branch,key,deadline)).publication;},onPhase:async phase=>{if(phase==='STAGED'){await assert.rejects(issuer.issue(f.request()),/FIELD_ADMISSION_MAP_NOT_ACTIVE/);stagedGroups++;}}});
   try{const value=await service.execute(commandId,command,context),done=await queue.read(context.actorId,id);assert.equal(done.status,'COMMITTED');report.jobs.push({id,commandId,action:command.action,actorId:context.actorId,status:done.status});return value;}finally{await heartbeat.stop();beats.delete(heartbeat);assert.equal(heartbeat.threadId,-1);}
  }
  const paused=structuredClone(f.policy);paused.changeIntent='RETROSPECTIVE_CORRECTION';paused.changeReason='current-map runtime history QA';paused.entries[0].admission=null;
  const created=await execute({action:'TEMPLATE_CREATE',input:{templateKey:'issuer-qa-field',version:'1.0.1',industry:'current-map runtime QA',manifest:fieldManifest('field-channel-policy','fieldChannelPolicy',paused)}},f.author),submitted=await execute({action:'TEMPLATE_SUBMIT',id:created.id,input:{expectedRevision:created.revision,expectedDigest:created.contentDigest}},f.author),beforePause=await issuer.issue(f.request());
  await execute({action:'TEMPLATE_APPROVE',id:created.id,input:{expectedRevision:submitted.revision,expectedDigest:submitted.contentDigest,decision:'APPROVED',comment:'independent QA model approval'}},f.reviewer);assert.equal(report.jobs.length,3);assert(stagedGroups>=3);report.stagedIsolationGroups=stagedGroups;
  const pausedRequest=signFieldCheckRequest({format:'idms-field-lease-check-request-v1',requestId:randomUUID(),requestedAtMs:Date.now(),lease:beforePause},f.requestKey),pausedCheck=await issuer.checkCurrent(pausedRequest);assert.equal(pausedCheck.body.reason,'FIELD_APPROVAL_PAUSED');const finalPayload=await persisted();assert.deepEqual(pausedCheck.body,fieldCurrentLeaseCheck({...finalPayload.business,audits:finalPayload.audits},finalPayload.imports,pausedRequest,f.snapshot,f.keys.publicKey,pausedCheck.body.checkedAtMs));
  const finalSnapshot=await map.snapshot();try{
   const keys=new Map(),remember=(ns,key)=>keys.set(ns+'\0'+key,[ns,key]);
   for(const e of compileFieldRuntimeMapV1(finalPayload,'acme')){remember(e.namespace,e.key);assert.deepEqual(await finalSnapshot.get(e.namespace,e.key),JSON.parse(e.valueText));}
   const tracked={tenantId:finalSnapshot.tenantId,head:finalSnapshot.head,get:(ns,key)=>{remember(ns,key);return finalSnapshot.get(ns,key);},state:(ns,key)=>{remember(ns,key);return finalSnapshot.state(ns,key);}};
   assert.deepEqual(await fieldCurrentLeaseCheckMapV1(tracked,pausedRequest,f.snapshot,f.keys.publicKey,pausedCheck.body.checkedAtMs),pausedCheck.body);
   evidence.final={...await membership(finalSnapshot.head,[...keys.values()]),payload:finalPayload,snapshot:f.snapshot,lease:beforePause,request:pausedRequest,check:pausedCheck};
  }finally{await finalSnapshot.close();}
  await note('V6 queue publication preserves committed runtime history and pauses leases on the matching current root');
  report.guardCalls=guardPhases.reduce((all,p)=>(all[p]=(all[p]??0)+1,all),{});report.rejectedRequestIds=[cancelRequest.requestId,authorityRequest.requestId];for(const id of report.rejectedRequestIds)assert.equal(finalPayload.audits.filter(a=>a.objectType==='FIELD_LEASE'&&a.objectId===id).length,0);
  const evidenceBytes=JSON.stringify(evidence);await privateNewFile(join(work,'domain-proofs.private.json'),evidenceBytes);report.domainProofsSha256=hash(evidenceBytes);
}catch(error){report.failure={code:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:error.code??'FIELD_MAP_NATIVE_FAILED',messageSha256:hash(error.message)};await privateNewFile(join(work,'failure.private.json'),JSON.stringify({message:error.message,stack:error.stack,code:error.code??null}));process.exitCode=1;}
finally{
 const errors=[];if(queryHookInstalled){pg.Client.prototype.query=originalQuery;queryHookInstalled=false;}report.queryHookRestored=originalQuery===undefined||pg.Client.prototype.query===originalQuery;
 for(const issuer of issuers)try{await issuer.close();const s=issuer.state();assert(s.closed&&s.closing&&s.active===0&&s.keyCount===0);}catch{errors.push('ISSUER_CLOSE');}report.issuerTerminalStates=issuers.map(i=>i.state());
 for(const beat of beats)try{await beat.stop();}catch{errors.push('HEARTBEAT_CLOSE');}
 if(controlClient)try{await controlClient.end();}catch{errors.push('CONTROL_CLIENT_CLOSE');}if(admin)try{await admin.end();}catch{errors.push('ADMIN_CLOSE');}
 if(cluster)try{await cluster.stop();report.postgresCleanOffline=!!cluster.sourceControl;report.postgresProcesses=cluster.processes;assert(!cluster.active&&cluster.processes.every(p=>p.stopped));}catch{errors.push('POSTGRES_SMART_STOP');}
 for(const p of report.sourcePins??[])try{assert.equal(hash(await readFile(p.path)),p.sha256);}catch{errors.push('SOURCE_CHANGED');}
 report.cleanupErrors=errors;report.cleanupComplete=errors.length===0&&!!cluster?.sourceControl;if(report.cleanupComplete&&!report.failure){await note('all issuers clear their keys and drain owned SQL while PostgreSQL retires cleanly offline');report.passed=report.checks.length===13;}
 if(!report.passed)process.exitCode=1;await writeFile(join(work,'verification.private.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({nonce,passed:report.passed,checks:report.checks.length,cleanupComplete:report.cleanupComplete,cleanupErrorCount:errors.length,failure:report.failure??null,platformIdentityAuthorityExecuted:false,currentMapIssuerExecuted:report.currentMapIssuerExecuted,fieldMqttDataPathExecuted:false,allProductionDependenciesRegistered:false}));
}
