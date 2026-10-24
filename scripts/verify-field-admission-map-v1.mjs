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
import {GovernanceConsoleCommandServiceV5} from '../server/governance-console-command-v5.ts';
import {GovernanceJobStoreV4} from '../server/governance-console-store-v4.ts';
import {GovernanceJobCryptoV4} from '../server/governance-job-crypto-v4.ts';
import {startGovernanceHeartbeatV4} from '../server/governance-job-heartbeat-v4.ts';
import {encodeGovernanceCandidateV5} from '../server/governance-plan-v5.ts';
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
const root=resolve('.'),nonce=randomBytes(6).toString('hex'),work=resolve('work/field-admission-map-v1-20261024',nonce),hash=b=>createHash('sha256').update(b).digest('hex');
await privateDirectory(work);
const report={format:'IDMS_FIELD_ADMISSION_MAP_NATIVE_V1',nonce,checks:[],jobs:[],passed:false,cleanupComplete:false,originalDatabaseContacted:false,platformIdentityAuthorityExecuted:false,fieldIssuerOrMqttDataPathExecuted:false,allProductionDependenciesRegistered:false};
let cluster,admin,controlClient;const beats=new Set();
const note=async name=>{report.checks.push(name);await writeFile(join(work,'current.private.json'),JSON.stringify(report));console.log(JSON.stringify({nonce,check:report.checks.length,name}));};
const quoted=n=>{assert(/^idms_fmapqa_[a-z0-9_]+$/.test(n));return '"'+n+'"';};
try{
  const baseline='docs/validation/field-domain-map-parent-v1.json';assert.equal(hash(await readFile(baseline)),'9570a67da3d0f0b0976b9e1a38749be1fa600630cb0c21f18571025e1b907284');
  const parent=JSON.parse(await readFile(baseline,'utf8'));assert.equal(parent.commit,'d7fb5a9d775d40a10dfe538cf400356233a1c4b7');assert.equal(parent.blobs.length,877);
  const pins=new Map();for(const p of parent.blobs){assert.equal(hash(await readFile(p.path)),p.sha256);pins.set(p.path,p.sha256);}
  const visited=new Set();async function visit(file){file=resolve(file);const p=relative(root,file).replaceAll('\\','/');assert(p&&!p.startsWith('..')&&!isAbsolute(p));if(visited.has(p))return;visited.add(p);assert(visited.size<2048);const bytes=await readFile(file);if(pins.has(p))assert.equal(hash(bytes),pins.get(p));else pins.set(p,hash(bytes));if(/\.(ts|mjs)$/.test(p))for(const m of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\(?\s*|new URL\s*\(\s*)['"](\.[^'"\r\n]+)['"]/g))if(/\.(ts|mjs|sql)$/.test(m[1]))await visit(resolve(dirname(file),m[1]));}
  for(const p of ['scripts/verify-field-admission-map-v1.mjs','server/governance-console-worker-v5.ts','tests/field-admission-map-v1.test.mjs',baseline,'package.json','package-lock.json'])await visit(p);
  report.sourcePins=[...pins].map(([path,sha256])=>({path,sha256}));report.node={version:process.versions.node,sha256:hash(await readFile(process.execPath))};
  await privateNewFile(join(work,'native-input-pins.json'),JSON.stringify({nonce,node:report.node,sourcePins:report.sourcePins}));console.log(JSON.stringify({nativeStarted:true,nonce,pid:process.pid,sourcePins:pins.size,expectedChecks:7}));
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
  const candidates=[...encodeGovernanceCandidateV5(payload,0,control,sources),...consoleCatalog.entries,{namespace:'domain_head',key:consoleHeadKeyV4,valueText:JSON.stringify(consoleCatalog.head)},{namespace:'domain_head',key:'registry',valueText:JSON.stringify({tenantId:'acme',revision:'1',hash:canonicalDigest(registry),configurationHash:canonicalDigest(registry)})}];
  const initial=new Map();for(const e of candidates){const k=e.namespace+'\0'+e.key;if(initial.has(k))assert.equal(initial.get(k).valueText,e.valueText);else initial.set(k,e);}
  const map=new DomainMapV4(account,binding),proofStore=new PostgresStateMapV1(readAccount,readBinding),rows=[...initial.values()];
  for(let at=0;at<rows.length;at+=24){const snapshot=await map.snapshot();let ops;try{ops=await Promise.all(rows.slice(at,at+24).map(async e=>({...e,expected:(await snapshot.state(e.namespace,e.key)).valueHash})));}finally{await snapshot.close();}await map.commit(snapshot.head,randomUUID(),ops);}
  const evidence={format:'IDMS_FIELD_ADMISSION_MAP_PROOFS_V1',nonce,profile:f.profile,initialPayload:payload,staged:[]};
  async function membership(head,keys){const proofs=[];for(const [namespace,key]of keys){const {proof}=await proofStore.proof(namespace,key,head);proofs.push({namespace,key,proof});}return{head,proofs};}
  async function current(capture){const s=await DomainMapSnapshot.open(readAccount,readBinding),keys=[];try{const at=Date.now()+100,result=await readCurrentFieldAdmissionMapV1(f.profile,at,null,(ns,k)=>{keys.push([ns,k]);return s.get(ns,k);});if(capture)evidence[capture]={at,result,...await membership(s.head,keys)};return result;}finally{await s.close();}}
  const first=await current('initial');assert(first.decision.allowed);assert.deepEqual(first.decision,fieldAdmissionDecision(f.store,f.imports,f.profile,Date.parse(first.decision.binding.evaluatedAt),null));report.initialMapEntries=rows.length;
  await note('bounded field admission is read from the current verified state root and matches the original rules');
  const queue=new GovernanceJobStoreV4(account,queueBinding),submit=new GovernanceJobStoreV4(ingressAccount,ingressBinding),ring={format:1,activeKeyId:'qa',keys:[{keyId:'qa',key:randomBytes(32).toString('base64url')}]},crypto=new GovernanceJobCryptoV4(ring,queueBinding);await privateNewFile(join(work,'queue-key.private.json'),JSON.stringify(ring));
  let stagedChecks=0,lastService,lastCommand,lastCommandId,lastContext,lastResult;
  async function execute(command,context){
    const id=randomUUID(),commandId=randomUUID(),requestHash=canonicalDigest(command),job={id,actorId:context.actorId,commandId,requestHash},deadline=Date.now()+600000,stagedBefore=stagedChecks;
    await submit.enqueue(context.actorId,id,commandId,command.action,requestHash,crypto.seal(command,job,'COMMAND'),crypto.seal({kind:'BEARER',value:'QA-model-reference-no-OIDC-login'},job,'GRANT'),deadline);
    const claim=await queue.claim();assert(claim&&claim.id===id);const heartbeat=startGovernanceHeartbeatV4(account,queueBinding,claim);beats.add(heartbeat);
    const service=new GovernanceConsoleCommandServiceV5(account,binding,sources,{commit:async(head,key,ops)=>{heartbeat.assertLive();return queue.prepare(claim,binding,head,key,ops,deadline);},publish:async(branch,key)=>{heartbeat.assertLive();return(await queue.publish(claim,branch,key,deadline)).publication;},onPhase:async phase=>{
      if(phase==='STAGED'){
        const s=await DomainMapSnapshot.open(readAccount,readBinding);try{const before=await s.get('domain_head','control');assert.equal(before.status,'UPDATING');await assert.rejects(readCurrentFieldAdmissionMapV1(f.profile,Date.now()+100,null,(ns,key)=>s.get(ns,key)),/FIELD_ADMISSION_MAP_NOT_ACTIVE/);const historical=await readFieldAdmissionMapV1(f.profile,Date.now()+100,null,before.governanceAnchorDigest,(ns,key)=>s.get(ns,key));assert.equal(historical.head.compiledPayloadDigest,before.governanceAnchorDigest);evidence.staged.push({commandId,action:command.action,...await membership(s.head,[['domain_head','control'],['field_admission',historical.head.profileDigest]])});stagedChecks++;}finally{await s.close();}
      }
    }});
    try{const result=await service.execute(commandId,command,context),completed=await queue.read(context.actorId,id);assert.equal(completed.status,'COMMITTED');assert(canonicalEqual(result,completed.result));const stagedGroups=stagedChecks-stagedBefore;assert(stagedGroups>0,'FIELD_MAP_COMMAND_WITHOUT_STAGED_ISOLATION');report.jobs.push({id,commandId,action:command.action,actorId:context.actorId,status:completed.status,publicationId:completed.publicationId,stagedGroups});lastService=service;lastCommand=command;lastCommandId=commandId;lastContext=context;lastResult=result;return result;}
    finally{await heartbeat.stop();beats.delete(heartbeat);assert.equal(heartbeat.threadId,-1);}
  }
  const paused=structuredClone(f.policy);paused.changeIntent='RETROSPECTIVE_CORRECTION';paused.changeReason='same-map field admission publication QA';paused.entries[0].admission=null;
  const created=await execute({action:'TEMPLATE_CREATE',input:{templateKey:'issuer-qa-field',version:'1.0.1',industry:'current state map QA',manifest:fieldManifest('field-channel-policy','fieldChannelPolicy',paused)}},f.author);
  const submitted=await execute({action:'TEMPLATE_SUBMIT',id:created.id,input:{expectedRevision:created.revision,expectedDigest:created.contentDigest}},f.author);
  await execute({action:'TEMPLATE_APPROVE',id:created.id,input:{expectedRevision:submitted.revision,expectedDigest:submitted.contentDigest,decision:'APPROVED',comment:'independent reviewer for current state map'}},f.reviewer);
  assert.equal(report.jobs.length,3);assert.equal(stagedChecks,report.jobs.reduce((n,j)=>n+j.stagedGroups,0));report.stagedIsolationChecks=stagedChecks;
  await note('three staged queue candidates withdraw runtime admission until atomic publication');
  const after=await current('final');assert.equal(after.decision.allowed,false);assert.equal(after.decision.reason,'FIELD_APPROVAL_PAUSED');assert.notEqual(after.control.governanceAnchorDigest,anchor);
  const snapshot=await DomainMapSnapshot.open(account,binding,{maintenance:true});let finalPayload;try{finalPayload=await reconstructDomainPayload('acme',(ns,key)=>snapshot.get(ns,key));assert.equal(canonicalDigest(finalPayload),after.control.governanceAnchorDigest);const field=finalPayload.business.templates.find(t=>t.id===created.id);assert.equal(field.publishedBy,f.reviewer.actorId);assert.notEqual(field.publishedBy,f.author.actorId);}finally{await snapshot.close();}
  evidence.finalPayload=finalPayload;const finalStore={...finalPayload.business,audits:finalPayload.audits,idempotency:new Map(finalPayload.idempotency)};assert.deepEqual(after.decision,fieldAdmissionDecision(finalStore,finalPayload.imports,f.profile,Date.parse(after.decision.binding.evaluatedAt),null));report.finalAnchor=after.control.governanceAnchorDigest;
  await note('independent-model approval publishes the paused field decision and matching governance anchor together');
  const replayBefore=await map.head();assert(canonicalEqual(await lastService.execute(lastCommandId,lastCommand,lastContext),lastResult));const replayAfter=await map.head();assert(canonicalEqual(replayAfter,replayBefore));evidence.replay={before:replayBefore,after:replayAfter,result:lastResult};
  await note('replaying the committed governance command leaves the current root and receipt unchanged');
  await setFence('CLOSED');const blockedSnapshot=await map.snapshot();let blockedOperation;try{blockedOperation=await blockedSnapshot.operation('field_admission','write-fence-negative',{qa:true});}finally{await blockedSnapshot.close();}
  await assert.rejects(map.commit(blockedSnapshot.head,randomUUID(),[blockedOperation]),/RUNTIME_FENCE_CLOSED/);const blockedHead=await map.head();assert(canonicalEqual(blockedHead,replayBefore));evidence.closedFenceHead=blockedHead;await setFence('OPEN');assert.equal((await current()).decision.allowed,false);
  const fence=await inspectRuntimeWriteFenceCatalogV1(controlClient);assert.equal(fence.catalogHash,report.fenceBinding.catalogHash);report.fenceCatalogUnchanged=true;
  await note('closed SQL write fence rejects field-root changes and reopens without rebaselining');
  const evidenceBytes=JSON.stringify(evidence);await privateNewFile(join(work,'domain-proofs.private.json'),evidenceBytes);report.domainProofsSha256=hash(evidenceBytes);
}catch(error){report.failure={code:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:error.code??'FIELD_MAP_NATIVE_FAILED',messageSha256:hash(error.message)};await privateNewFile(join(work,'failure.private.json'),JSON.stringify({message:error.message,stack:error.stack,code:error.code??null}));process.exitCode=1;}
finally{
  const errors=[];for(const beat of beats)try{await beat.stop();}catch{errors.push('HEARTBEAT_CLOSE');}
  if(controlClient)try{await controlClient.end();}catch{errors.push('CONTROL_CLIENT_CLOSE');}
  if(admin)try{await admin.end();}catch{errors.push('ADMIN_CLOSE');}
  if(cluster)try{await cluster.stop();report.postgresCleanOffline=!!cluster.sourceControl;report.postgresProcesses=cluster.processes;assert(!cluster.active&&cluster.processes.every(p=>p.stopped));}catch{errors.push('POSTGRES_SMART_STOP');}
  for(const p of report.sourcePins??[])try{assert.equal(hash(await readFile(p.path)),p.sha256);}catch{errors.push('SOURCE_CHANGED');}
  report.cleanupErrors=errors;report.cleanupComplete=errors.length===0&&!!cluster?.sourceControl;
  if(report.cleanupComplete&&!report.failure){await note('all owned SQL connections and heartbeat threads retired and PostgreSQL clean offline');report.passed=report.checks.length===7;}
  if(!report.passed)process.exitCode=1;await writeFile(join(work,'verification.private.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({nonce,passed:report.passed,checks:report.checks.length,cleanupComplete:report.cleanupComplete,cleanupErrorCount:errors.length,failure:report.failure??null,allProductionDependenciesRegistered:false}));
}
