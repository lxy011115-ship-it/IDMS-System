import {fieldManifest} from './fixtures/field-issuance-model.mjs';
import {FieldMapTransactionsV2} from '../server/field-map-transaction-v2.ts';
import {FieldMapReceiverV1} from '../server/field-map-receiver-v1.ts';
import {prepareEmptyFieldMapIntakeV1} from '../server/field-map-intake-bootstrap-v1.ts';
import {fieldMapStorageV1,fieldMapReceiptKeyV1,fieldMapPointKeyV1,inspectFieldMapReceiptV1} from '../server/field-map-receive-v1.ts';
import {readFieldMapPointPageV1} from '../server/field-map-point-query-v1.ts';
import {signFieldEvent,verifyFieldEvent,fieldEventDigest,verifyFieldAck} from '../integrations/field-event.ts';
import {fieldIntakeDecision} from '../server/field-intake-decision.ts';
import {fieldIntakeDecisionMapV1,inspectHistoricalIntakeDecisionMapV1} from '../server/field-map-intake-decision-v1.ts';
import {fieldPointBody} from '../server/field-receive.ts';
import {stable} from '../integrations/telemetry.ts';
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
import {telemetryDomainFormat,auditPositionKey} from '../server/telemetry-map-v4.ts';
import {readCurrentFieldAdmissionMapV1,readFieldAdmissionMapV1} from '../server/field-admission-map-v1.ts';
import {fieldAdmissionDecision} from '../server/field-admission.ts';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {fieldEventFixture} from './fixtures/field-event-model.mjs';
import {tenantSeed} from './database-migrations.mjs';
import {publicGovernedSource} from '../server/source-governance.ts';
import {registrySnapshot} from '../server/registry-history.ts';
import {reconstructDomainPayload} from '../server/domain-entities-v4.ts';

assert.equal(process.argv.length,3,'FIELD_MAP_EXPLICIT_PG_BIN');
const root=resolve('.'),nonce=randomBytes(6).toString('hex'),work=resolve('work/field-map-intake-v1-20261024',nonce),hash=b=>createHash('sha256').update(b).digest('hex');
await privateDirectory(work);
const report={format:'IDMS_FIELD_MAP_INTAKE_NATIVE_V1',nonce,checks:[],jobs:[],passed:false,cleanupComplete:false,originalDatabaseContacted:false,platformIdentityAuthorityExecuted:false,currentMapIntakeExecuted:false,realOpcuaReadExecuted:false,realMtlsMqttExecuted:false,declaredWitnessModel:true,allProductionDependenciesRegistered:false};
let cluster,admin,controlClient;const beats=new Set(),receivers=[];let originalQuery,queryHookInstalled=false;
const note=async name=>{report.checks.push(name);await writeFile(join(work,'current.private.json'),JSON.stringify(report));console.log(JSON.stringify({nonce,check:report.checks.length,name}));};
const quoted=n=>{assert(/^idms_fmapqa_[a-z0-9_]+$/.test(n));return '"'+n+'"';};
try{
  const baseline='docs/validation/field-map-intake-parent-v1.json';assert.equal(hash(await readFile(baseline)),'3582af1ac2dbbf4ba750c53f4f99371d3ca10314a6619bacdfe31d2517c1d200');
  const parent=JSON.parse(await readFile(baseline,'utf8'));assert.equal(parent.commit,'ff20abbe5eb1c438fcea17784dbaa4340ae2e1d9');assert.equal(parent.blobs.length,907);
  const pins=new Map();for(const p of parent.blobs){assert.equal(hash(await readFile(p.path)),p.sha256);pins.set(p.path,p.sha256);}
  const visited=new Set();async function visit(file){file=resolve(file);const p=relative(root,file).replaceAll('\\','/');assert(p&&!p.startsWith('..')&&!isAbsolute(p));if(visited.has(p))return;visited.add(p);assert(visited.size<2048);const bytes=await readFile(file);if(pins.has(p))assert.equal(hash(bytes),pins.get(p));else pins.set(p,hash(bytes));if(/\.(ts|mjs)$/.test(p))for(const m of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\(?\s*|new URL\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g))if(/\.(ts|mjs|sql)$/.test(m[1]))await visit(resolve(dirname(file),m[1]));}
  for(const p of ['scripts/verify-field-map-intake-v1.mjs','server/governance-console-worker-v6.ts','tests/field-map-intake-v1.test.mjs','server/field-map-receiver-v1.ts','scripts/verify-field-map-intake-cleanup-v1.mjs',baseline,'package.json','package-lock.json'])await visit(p);
  report.sourcePins=[...pins].map(([path,sha256])=>({path,sha256}));report.node={version:process.versions.node,sha256:hash(await readFile(process.execPath))};
  await privateNewFile(join(work,'native-input-pins.json'),JSON.stringify({nonce,node:report.node,sourcePins:report.sourcePins}));console.log(JSON.stringify({nativeStarted:true,nonce,pid:process.pid,sourcePins:pins.size,expectedChecks:15}));
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
  const f=fieldEventFixture(),{audits,idempotency,...business}=f.store,payload=tenantSeed({version:2,business,audits,imports:f.imports,idempotency:[...idempotency]},'acme'),sources=[publicGovernedSource(f.sources[0])],anchor=canonicalDigest(payload),control={format:telemetryDomainFormat,tenantId:'acme',status:'ACTIVE',epoch:'1',legacySealKey:'0'.repeat(64),governanceAnchorDigest:anchor},consoleCatalog=compileGovernanceConsoleV4(payload,'acme',anchor),registry=registrySnapshot({format:1,tenantId:'acme',sources});
  const candidates=[...encodeGovernanceCandidateV6(payload,0,control,sources),...consoleCatalog.entries,{namespace:'domain_head',key:consoleHeadKeyV4,valueText:JSON.stringify(consoleCatalog.head)},{namespace:'domain_head',key:'registry',valueText:JSON.stringify({tenantId:'acme',revision:'1',hash:canonicalDigest(registry),configurationHash:canonicalDigest(registry)})}];
  const initial=new Map();for(const e of candidates){const k=e.namespace+'\0'+e.key;if(initial.has(k))assert.equal(initial.get(k).valueText,e.valueText);else initial.set(k,e);}
  const map=new DomainMapV4(account,binding),proofStore=new PostgresStateMapV1(readAccount,readBinding),rows=[...initial.values()];
  for(let at=0;at<rows.length;at+=24){const snapshot=await map.snapshot();let ops;try{ops=await Promise.all(rows.slice(at,at+24).map(async e=>({...e,expected:(await snapshot.state(e.namespace,e.key)).valueHash})));}finally{await snapshot.close();}await map.commit(snapshot.head,randomUUID(),ops);}
  const evidence={format:'IDMS_FIELD_MAP_INTAKE_PROOFS_V1',nonce,profile:f.profile,publicKeyPem:f.keys.publicKey.export({type:'spki',format:'pem'}),initialPayload:payload,staged:[]};
  async function membership(head,keys){const proofs=[];for(const [namespace,key]of keys){const {proof}=await proofStore.proof(namespace,key,head);proofs.push({namespace,key,proof});}return{head,proofs};}
  async function current(capture){const s=await DomainMapSnapshot.open(readAccount,readBinding),keys=[];try{const at=Date.now()+100,result=await readCurrentFieldAdmissionMapV1(f.profile,at,null,(ns,k)=>{keys.push([ns,k]);return s.get(ns,k);});if(capture)evidence[capture]={at,result,...await membership(s.head,keys)};return result;}finally{await s.close();}}
  const first=await current('initial');assert(first.decision.allowed);assert.deepEqual(first.decision,fieldAdmissionDecision(f.store,f.imports,f.profile,Date.parse(first.decision.binding.evaluatedAt),null));report.initialMapEntries=rows.length;
  await note('bounded field admission is read from the current verified state root and matches the original rules');
  let authorityCurrent=true,hold=null;const tx=new FieldMapTransactionsV2(account,binding,async phase=>{if(phase==='PRECOMMIT'&&hold){const g=hold;hold=null;g.entered();await g.released;}assert(authorityCurrent,'QA_AUTHORITY_NOT_CURRENT');}),storage=fieldMapStorageV1(binding),verificationKeys=new Map([[f.snapshot.leaseKeyId,f.keys.publicKey]]);
  assert((await prepareEmptyFieldMapIntakeV1(tx)).changed);const preparedHead=await map.head();assert.equal((await prepareEmptyFieldMapIntakeV1(tx)).changed,false);assert(canonicalEqual(await map.head(),preparedHead));
  await privateNewFile(join(work,'event.bin'),f.eventKey);evidence.snapshot=f.snapshot;evidence.storage=storage;evidence.acknowledgements=[];const allEvents=new Map(),receiptKeys=new Set(),rolledBack=[];
  const makeReceiver=()=>{const r=new FieldMapReceiverV1(tx,f.snapshot,f.keys.privateKey,new Map([[f.profile.source.edgeId,f.eventKey]]));receivers.push(r);return r;};let receiver=makeReceiver();
  await note('explicit intake preparation proves empty audited history and repeated preparation preserves the root');
  const clone=(e,patch)=>{const {signature,...body}=e;return signFieldEvent({...body,...patch},f.eventKey,f.profile,f.keys.publicKey);};
  async function receive(event,r=receiver,signal){allEvents.set(fieldEventDigest(event),event);const ack=await r.receiveMqtt(f.profile.transport.topics.telemetry,Buffer.from(stable(event)),signal);assert(ack);verifyFieldAck(ack,f.keys.publicKey,event,Date.now());evidence.acknowledgements.push(ack);receiptKeys.add(fieldMapReceiptKeyV1(event));return ack;}
  async function persisted(){const s=await DomainMapSnapshot.open(account,binding,{maintenance:true});try{return await reconstructDomainPayload('acme',(ns,k)=>s.get(ns,k));}finally{await s.close();}}
  async function page(){const s=await DomainMapSnapshot.open(readAccount,readBinding);try{const p=await readFieldMapPointPageV1(s,f.profile.source.deviceCode,storage,verificationKeys,{limit:16});report.lastPointReadStats={...s.stats};return p;}finally{await s.close();}}
  const event=f.events()[0],ack=await receive(event);assert.equal(ack.body.status,'STORED');report.currentMapIntakeExecuted=true;const afterFirst=await persisted(),audit=afterFirst.audits.find(a=>a.eventId===ack.body.receiptAuditId),original=fieldIntakeDecision({...afterFirst.business,audits:afterFirst.audits},afterFirst.imports,f.profile,f.snapshot,event,f.keys.publicKey,Date.parse(audit.businessTime));assert.deepEqual(audit.metadata.decision,original);const firstPage=await page();assert.equal(firstPage.items.length,1);assert.deepEqual(firstPage.items[0].point,fieldPointBody(event,audit));
  const invalidHead=await map.head();assert.equal(await receiver.receiveMqtt(f.profile.transport.topics.telemetry,Buffer.from('{}')),null);assert(canonicalEqual(await map.head(),invalidHead));
  await note('actual SQL stores the signed declared event and its audit receipt point and query indexes atomically');
  const replayHead=await map.head(),replay=await receive(event);assert.equal(replay.body.receiptAuditId,ack.body.receiptAuditId);assert.equal(replay.body.receiptAt,ack.body.receiptAt);assert(canonicalEqual(await map.head(),replayHead));
  await note('lost business acknowledgement can be replayed using the original receipt without a new point or audit');
  const conflicts=[clone(event,{sequenceNo:2,witness:{...event.witness,readId:randomUUID()}}),clone(event,{eventId:randomUUID(),witness:{...event.witness,readId:randomUUID()}}),clone(event,{eventId:randomUUID(),sequenceNo:3})];
  for(const [i,e]of conflicts.entries()){const a=await receive(e);assert.equal(a.body.reason,['FIELD_EVENT_ID_CONFLICT','FIELD_SEQUENCE_CONFLICT','FIELD_READ_ID_CONFLICT'][i]);}assert.equal((await page()).items.length,1);
  await note('event sequence and read conflicts retain their original priority and persist rejection receipts without points');
  const second=f.events()[1],parallel=[clone(event,{eventId:randomUUID(),sequenceNo:10,witness:{...event.witness,readId:randomUUID()}}),clone(second,{eventId:randomUUID(),sequenceNo:11,witness:{...second.witness,readId:randomUUID()}})],concurrent=await Promise.all(parallel.map(e=>receive(e)));assert(concurrent.every(a=>a.body.status==='STORED'));assert.equal((await page()).items.length,3);
  await note('concurrent actual transactions preserve both distinct points through CAS replan and stable reverse query pages');
  function gate(){let entered,release;const enteredPromise=new Promise(r=>entered=r),released=new Promise(r=>release=r);hold={entered,released};return{enteredPromise,release};}
  const cancelledEvent=clone(event,{eventId:randomUUID(),sequenceNo:20,witness:{...event.witness,readId:randomUUID()}}),cancelGate=gate(),cancel=new AbortController(),cancelHead=await map.head(),cancelled=receive(cancelledEvent,receiver,cancel.signal).then(()=>({ok:true}),error=>({ok:false,error}));await cancelGate.enteredPromise;cancel.abort();cancelGate.release();const cr=await cancelled;assert(!cr.ok&&cr.error.message==='FIELD_MAP_CANCELLED');assert(canonicalEqual(await map.head(),cancelHead));rolledBack.push(cancelledEvent);
  await note('cancellation after real SQL delta and before COMMIT leaves no receipt point or audit and produces no ACK');
  const authorityEvent=clone(event,{eventId:randomUUID(),sequenceNo:21,witness:{...event.witness,readId:randomUUID()}}),authorityGate=gate(),authorityHead=await map.head(),denied=receive(authorityEvent).then(()=>({ok:true}),error=>({ok:false,error}));await authorityGate.enteredPromise;authorityCurrent=false;authorityGate.release();const ar=await denied;assert(!ar.ok&&ar.error.message==='QA_AUTHORITY_NOT_CURRENT');authorityCurrent=true;assert(canonicalEqual(await map.head(),authorityHead));rolledBack.push(authorityEvent);
  await note('injected authority withdrawal before COMMIT rolls back the actual intake transaction');
  const writes=new WeakSet();let lose=true,lost=0;originalQuery=pg.Client.prototype.query;pg.Client.prototype.query=function(...args){const sql=typeof args[0]==='string'?args[0]:args[0]?.text,result=originalQuery.apply(this,args),owned=this.connectionParameters.database===database&&this.connectionParameters.application_name==='idms-field-map-v1';if(owned&&sql?.startsWith('SELECT state_map_v1.apply_delta_v1'))writes.add(this);if(owned&&sql==='COMMIT'&&writes.has(this)&&lose){lose=false;return result.then(()=>{lost++;throw Error('QA_COMMITTED_RESPONSE_LOST');});}return result;};queryHookInstalled=true;
  const recoveredEvent=clone(event,{eventId:randomUUID(),sequenceNo:30,witness:{...event.witness,readId:randomUUID()}}),recovered=await receive(recoveredEvent);assert.equal(lost,1);assert.equal(recovered.body.status,'STORED');pg.Client.prototype.query=originalQuery;queryHookInstalled=false;const recoveredHead=await map.head();assert.equal((await receive(recoveredEvent)).body.receiptAuditId,recovered.body.receiptAuditId);assert(canonicalEqual(await map.head(),recoveredHead));report.committedReplyLossInjected=true;
  await note('a lost client result after actual COMMIT resolves the original SQL receipt before signing the business ACK');
  const closingEvent=clone(event,{eventId:randomUUID(),sequenceNo:40,witness:{...event.witness,readId:randomUUID()}}),closingGate=gate(),closingHead=await map.head(),inFlight=receive(closingEvent).then(()=>({ok:true}),error=>({ok:false,error}));await closingGate.enteredPromise;const closing=receiver.close();assert(receiver.state().closing&&!receiver.state().closed&&receiver.state().active===1);closingGate.release();const closed=await inFlight;assert(!closed.ok&&closed.error.message==='FIELD_MAP_CANCELLED');await closing;assert(receiver.state().closed&&receiver.state().active===0&&receiver.state().keyCount===0);assert(canonicalEqual(await map.head(),closingHead));rolledBack.push(closingEvent);receiver=makeReceiver();
  await note('receiver close waits for a held SQL transaction to roll back and clears its event keys before returning');
  const blockedEvent=clone(event,{eventId:randomUUID(),sequenceNo:50,witness:{...event.witness,readId:randomUUID()}}),fenceHead=await map.head();await setFence('CLOSED');await assert.rejects(receive(blockedEvent),/RUNTIME_FENCE_CLOSED/);assert(canonicalEqual(await map.head(),fenceHead));await setFence('OPEN');const fence=await inspectRuntimeWriteFenceCatalogV1(controlClient);assert.equal(fence.catalogHash,report.fenceBinding.catalogHash);report.fenceCatalogUnchanged=true;rolledBack.push(blockedEvent);
  await note('the closed SQL write fence refuses intake without changing the root or returning an ACK');
  const queue=new GovernanceJobStoreV4(account,queueBinding),submit=new GovernanceJobStoreV4(ingressAccount,ingressBinding),ring={format:1,activeKeyId:'qa',keys:[{keyId:'qa',key:randomBytes(32).toString('base64url')}]},crypto=new GovernanceJobCryptoV4(ring,queueBinding);await privateNewFile(join(work,'queue-key.private.json'),JSON.stringify(ring));let staged=0;
  async function execute(command,context){const id=randomUUID(),commandId=randomUUID(),requestHash=canonicalDigest(command),job={id,actorId:context.actorId,commandId,requestHash},deadline=Date.now()+600000;await submit.enqueue(context.actorId,id,commandId,command.action,requestHash,crypto.seal(command,job,'COMMAND'),crypto.seal({kind:'BEARER',value:'QA-model-reference-no-OIDC-login'},job,'GRANT'),deadline);const claim=await queue.claim();assert(claim&&claim.id===id);const heartbeat=startGovernanceHeartbeatV4(account,queueBinding,claim);beats.add(heartbeat);const service=new GovernanceConsoleCommandServiceV6(account,binding,sources,{commit:async(head,key,ops)=>{heartbeat.assertLive();return queue.prepare(claim,binding,head,key,ops,deadline);},publish:async(branch,key)=>{heartbeat.assertLive();return(await queue.publish(claim,branch,key,deadline)).publication;},onPhase:async phase=>{if(phase==='STAGED'){await assert.rejects(receive(event),/FIELD_ADMISSION_MAP_NOT_ACTIVE/);staged++;}}});try{const value=await service.execute(commandId,command,context),done=await queue.read(context.actorId,id);assert.equal(done.status,'COMMITTED');report.jobs.push({id,commandId,action:command.action,actorId:context.actorId,status:done.status});return value;}finally{await heartbeat.stop();beats.delete(heartbeat);assert.equal(heartbeat.threadId,-1);}}
  const paused=structuredClone(f.policy);paused.changeIntent='RETROSPECTIVE_CORRECTION';paused.entries[0].admission=null;const created=await execute({action:'TEMPLATE_CREATE',input:{templateKey:'issuer-qa-field',version:'1.0.2',industry:'current-map intake QA',manifest:fieldManifest('field-channel-policy','fieldChannelPolicy',paused)}},f.author),submitted=await execute({action:'TEMPLATE_SUBMIT',id:created.id,input:{expectedRevision:created.revision,expectedDigest:created.contentDigest}},f.author);await execute({action:'TEMPLATE_APPROVE',id:created.id,input:{expectedRevision:submitted.revision,expectedDigest:submitted.contentDigest,decision:'APPROVED',comment:'independent QA model'}},f.reviewer);assert(staged>=3);evidence.governedPayload=await persisted();const rejected=await receive(event);assert.equal(rejected.body.reason,'FIELD_APPROVAL_PAUSED');assert.notEqual(rejected.body.receiptAuditId,ack.body.receiptAuditId);assert.equal((await page()).items.length,4);report.stagedIsolationGroups=staged;
  await note('V6 approval withdraws intake before replay while committed historical points remain queryable');
  let marker;const ms=await map.snapshot();try{marker=await ms.state('domain_head','field_intake');}finally{await ms.close();}await map.commit(ms.head,randomUUID(),[{namespace:'domain_head',key:'field_intake',expected:marker.valueHash,valueText:null}]);await assert.rejects(prepareEmptyFieldMapIntakeV1(tx),/FIELD_MAP_LEGACY_INTAKE_REQUIRES_MIGRATION/);const missing=await map.snapshot();let restore;try{restore=await missing.operation('domain_head','field_intake',marker.value);}finally{await missing.close();}await map.commit(missing.head,randomUUID(),[restore]);report.markerLossIsolatedQa=true;
  await note('missing intake indexes with existing field audit history cannot be silently initialized as an empty dataset');
  const finalPayload=await persisted(),final=await map.snapshot();try{
   const members=new Map(),remember=(ns,key)=>members.set(ns+'\0'+key,[ns,key]),tracked={tenantId:final.tenantId,head:final.head,get:(ns,key)=>{remember(ns,key);return final.get(ns,key);},state:(ns,key)=>{remember(ns,key);return final.state(ns,key);}};
   const queried=await readFieldMapPointPageV1(tracked,f.profile.source.deviceCode,storage,verificationKeys,{limit:16});assert.equal(queried.items.length,4);
   for(const receiptKey of receiptKeys){const state=await tracked.state('receipt',receiptKey);if(state.present)await inspectFieldMapReceiptV1(tracked,state.value,f.keys.publicKey,storage);}
   for(const acknowledgement of evidence.acknowledgements){const a=await tracked.get('audit',acknowledgement.body.receiptAuditId);await tracked.get('audit_order',auditPositionKey(a.metadata.auditPosition));}
   for(const e of rolledBack){assert.equal((await tracked.state('receipt',fieldMapReceiptKeyV1(e))).present,false);assert.equal((await tracked.state('blob',fieldMapPointKeyV1(e.eventId))).present,false);assert.equal((await tracked.state('field_event',e.eventId)).present,false);}
   await tracked.get('domain_head','audit');evidence.final={...await membership(final.head,[...members.values()]),payload:finalPayload,page:queried};evidence.events=[...allEvents.values()];evidence.rolledBack=rolledBack;evidence.receiptKeys=[...receiptKeys];report.finalReadStats={...final.stats};report.finalMembershipProofs=members.size;
  }finally{await final.close();}
  const proofBytes=JSON.stringify(evidence);await privateNewFile(join(work,'domain-proofs.private.json'),proofBytes);report.domainProofsSha256=hash(proofBytes);
}catch(error){report.failure={code:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:error.code??'FIELD_MAP_NATIVE_FAILED',messageSha256:hash(error.message)};await privateNewFile(join(work,'failure.private.json'),JSON.stringify({message:error.message,stack:error.stack,code:error.code??null}));process.exitCode=1;}
finally{
 const errors=[];if(queryHookInstalled){pg.Client.prototype.query=originalQuery;queryHookInstalled=false;}report.queryHookRestored=originalQuery===undefined||pg.Client.prototype.query===originalQuery;
 for(const r of receivers)try{await r.close();const s=r.state();assert(s.closed&&s.closing&&s.active===0&&s.keyCount===0);}catch{errors.push('RECEIVER_CLOSE');}report.receiverTerminalStates=receivers.map(r=>r.state());
 for(const beat of beats)try{await beat.stop();}catch{errors.push('HEARTBEAT_CLOSE');}if(controlClient)try{await controlClient.end();}catch{errors.push('CONTROL_CLIENT_CLOSE');}if(admin)try{await admin.end();}catch{errors.push('ADMIN_CLOSE');}
 if(cluster)try{await cluster.stop();report.postgresCleanOffline=!!cluster.sourceControl;report.postgresProcesses=cluster.processes;assert(!cluster.active&&cluster.processes.every(p=>p.stopped));}catch{errors.push('POSTGRES_SMART_STOP');}
 for(const p of report.sourcePins??[])try{assert.equal(hash(await readFile(p.path)),p.sha256);}catch{errors.push('SOURCE_CHANGED');}report.cleanupErrors=errors;report.cleanupComplete=errors.length===0&&!!cluster?.sourceControl;
 if(report.cleanupComplete&&!report.failure){await note('receivers clear keys and drain all owned SQL and heartbeat resources before PostgreSQL retires cleanly offline');report.passed=report.checks.length===15;}
 if(!report.passed)process.exitCode=1;await writeFile(join(work,'verification.private.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({nonce,passed:report.passed,checks:report.checks.length,cleanupComplete:report.cleanupComplete,cleanupErrorCount:errors.length,failure:report.failure??null,currentMapIntakeExecuted:report.currentMapIntakeExecuted,realOpcuaReadExecuted:false,realMtlsMqttExecuted:false,platformIdentityAuthorityExecuted:false,allProductionDependenciesRegistered:false}));
}
