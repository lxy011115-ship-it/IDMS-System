import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,createPublicKey,createHmac,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical} from '../../server/imports.ts';
import {verifyStateProof,stateKey} from '../../server/state-map-v1.ts';
import {readFieldMapPointPageV1} from '../../server/field-map-point-query-v1.ts';
import {fieldMapReceiptKeyV1,fieldMapPointKeyV1} from '../../server/field-map-receive-v1.ts';
import {verifyFieldEvent,verifyFieldAck,fieldEventDigest} from '../../integrations/field-event.ts';
import {stable} from '../../integrations/telemetry.ts';
import {readApplicationRegistryV2} from '../runtime-application-registry-v2.mjs';
import {fieldSiteChildRetirementV1} from '../runtime-field-site-retirement-v1.mjs';

const json=async p=>JSON.parse(await readFile(p,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const cleanExit=e=>assert(e.code===0&&e.signal===null&&!e.spawnFailed);

async function brokerProof(directory,proof,rootPid,requestId){
 assert.equal(proof.format,'IDMS_MQTT_BROKER_NORMAL_STOP_V1');
 assert(proof.normalClose&&!proof.genericKillUsed&&proof.controlDelivered);
 if(requestId)assert.equal(proof.requestId,requestId);
 cleanExit(proof.actualOwnedProcessExit);
 assert(proof.actualOwnedProcessExit.stdoutClosed&&proof.actualOwnedProcessExit.stderrClosed);
 const launch=await json(join(directory,'launch-intent.private.json'));
 const bound=await json(join(directory,'bound.private.json'));
 const control=await json(join(directory,'stop-control.private.json'));
 assert.equal(launch.parentPid,rootPid);assert.equal(launch.owner,proof.owner);
 assert.equal(bound.owner,proof.owner);assert.equal(bound.pid,proof.pid);
 assert.deepEqual(bound.identity,proof.identity);
 assert.equal(control.owner,proof.owner);assert.equal(control.requestId,proof.requestId);
 assert(control.delivered);assert.equal(proof.helperAttempts,1);
 if(process.platform==='win32')assert(control.completed&&control.nativeExitCode===0&&proof.windowsOriginalHandleWaitCompleted);
 else assert(proof.linuxSigintHandlerObservedBeforeStop&&control.signal==='SIGINT');
 assert.deepEqual(await json(join(directory,'normal-stop-proof.json')),proof);
 return {port:bound.port,owner:proof.owner,pid:proof.pid};
}

async function edgeProof(resource,rootPid,requestId){
 const p=resource.proof;assert(p.normalStop&&p.localDrained&&p.actualExitAndOutputAndIpcClosed&&p.pinsUnchanged&&!p.genericKillUsed);
 cleanExit(p.exit);assert.equal(p.pid,resource.pid);assert.equal(p.requestId,requestId);
 for(const k of ['ready','lockHeld','spoolOpen','readerActive','httpActive','mqttActive','leaseWatching','ackWaiterActive'])assert.equal(p.localState[k],false);
 const launch=await json(join(resource.directory,'launch.private.json'));
 const stop=await json(join(resource.directory,'stop-intent.json'));
 assert.equal(launch.parentPid,rootPid);assert.equal(launch.owner,p.owner);
 assert.equal(stop.pid,p.pid);assert.equal(stop.owner,p.owner);assert.equal(stop.requestId,requestId);
 assert.deepEqual(await json(join(resource.directory,'terminal-proof.json')),p);
 for(const pin of launch.pins)assert.equal(hash(await readFile(pin.path)),pin.sha256);
}

async function applicationProof(resource,group){
 const p=resource.proof;
 assert(p.normalFullGroup&&p.allOwnedTerminalProven&&p.allOwnedResourcesRetired&&!p.genericKillUsed);
 cleanExit(p.exit);assert.equal(p.pid,resource.pid);
 assert.equal(p.membersCreated,9);assert.equal(p.membersNormalExit,9);
 assert.deepEqual(await json(join(resource.directory,'terminal-proof.json')),p);
 const stop=await json(join(resource.directory,'stop-intent.json'));
 assert.equal(stop.pid,p.pid);assert.equal(stop.requestId,group.requestId);
 const registry=await readApplicationRegistryV2(await json(join(group.registryDirectory,'trust.json')));
 assert(registry.lifecycle.groupReady&&registry.lifecycle.terminal);
 assert.equal(registry.header.ownerPid,p.pid);
 assert.equal(registry.events.at(-1).event,'GROUP_CLOSED');
 const created=registry.events.find(e=>e.event==='CREATED');
 const started=registry.events.find(e=>e.event==='START_AUTHORIZED');
 const siteReady=registry.events.find(e=>e.event==='READY'&&e.componentId==='site');
 const retired=registry.events.find(e=>e.event==='RETIRED');
 assert(created.sequence<started.sequence&&started.sequence<siteReady.sequence&&siteReady.sequence<retired.sequence);
 assert(registry.events.filter(e=>e.event==='STOP_INTENT'&&e.componentId!=='site').every(e=>e.sequence>retired.sequence));
 const ready=registry.events.filter(e=>e.event==='READY');assert.equal(ready.length,9);
 for(const member of ready){
  const envelope=await json(join(group.registryDirectory,member.componentId+'-launch.private.json'));
  const result=await json(join(group.registryDirectory,member.componentId+'-result.private.json'));
  const exit=registry.events.find(e=>e.event==='EXIT'&&e.componentId===member.componentId);
  assert.equal(result.pid,member.pid);assert.equal(exit.pid,member.pid);cleanExit(exit);
  assert.equal(result.parentPid,p.pid);assert(result.normalClose);
  assert.equal(result.requestId,group.requestId);
  assert.equal(result.challengeSha256,hash(envelope.challenge));
  assert.equal(result.configSha256,member.configSha256);
  if(member.kind==='SITE'){
   const computed=fieldSiteChildRetirementV1(result,{ownerId:registry.header.ownerId,componentId:member.componentId,pid:member.pid,parentPid:p.pid,configSha256:member.configSha256,manifestSha256:hash(canonical(registry.header.manifest)),challenge:envelope.challenge,enabled:true,requestId:group.requestId});
   assert.deepEqual(computed,retired.proof);
  }
 }
 assert(registry.events.filter(e=>e.event==='STOP_INTENT').every(e=>e.requestId===group.requestId));
 return retired.proof.counts;
}

async function stateAnchor(file,nonce){
 const a=await json(file);assert.equal(a.nonce,nonce);
 const key=createPublicKey(a.publicKeyPem),tenant=a.profile.source.tenantId,members=new Map();
 for(const item of a.proofs){const id=item.namespace+'\0'+item.key;assert(!members.has(id));members.set(id,verifyStateProof(item.proof,a.head,stateKey(tenant,item.namespace,item.key)));}
 const source={tenantId:tenant,head:a.head,state:async(ns,k)=>{const v=members.get(ns+'\0'+k);assert(v,'PLATFORM_FIELD_PROOF_MEMBER_MISSING');return structuredClone(v);},get:async function(ns,k){const v=await this.state(ns,k);assert(v.present);return v.value;}};
 const page=await readFieldMapPointPageV1(source,a.profile.source.deviceCode,a.storage,new Map([[a.registry.leaseKeyId,key]]),{limit:16});
 assert.deepEqual(page,a.page);assert.equal(page.items.length,a.profile.points.length*4);
 for(const pending of a.retained.pending){const event=JSON.parse(pending.payload);assert.equal((await source.state('receipt',fieldMapReceiptKeyV1(event))).present,false);assert.equal((await source.state('blob',fieldMapPointKeyV1(event.eventId))).present,false);}
 return {a,key,page,members,source};
}

/** Offline recomputation from actual native evidence. No product processes or SQL are started. */
export async function inspectPlatformFieldIndependentQaV1({work,nonce,report:r,managerPage}){
 const stage=r.platformFieldDependencies;
 assert.deepEqual(stage,await json(join(work,'platform-field-result.private.json')));
 assert.equal(stage.format,'PLATFORM_FIELD_CONTROLLER_NATIVE_V1');assert.equal(stage.nonce,nonce);
 assert.equal(stage.checks.length,6);assert.deepEqual(stage.cleanupErrors,[]);
 assert(!stage.formalFieldActivationGranted&&!stage.allProductionDependenciesRegistered&&!stage.fullGoalComplete);
 assert.deepEqual(stage.generations.map(e=>e.label),['normal','cancel']);
 assert(stage.siteWaitedForOwnerSql);assert.equal(stage.blockedOwner.application_name,'idms-field-map-owner-v1');assert.equal(stage.blockedOwner.wait_event_type,'Lock');
 assert.equal(stage.blockedResult.phase,'BLOCKED');
 assert.deepEqual(stage.blockedResult.blocked,[{id:'business',errorCode:'PG_LIFECYCLE_CLIENTS_REMAIN'}]);
 assert.equal(stage.blockedPgBeforeRetry.helperAttempts,0);assert(stage.blockedPgBeforeRetry.stopIntentAbsent);
 const owners=new Set(),processes=new Set(),brokerBindings=[],siteCounts=[];
 for(const group of stage.generations){
  assert.deepEqual(group,await json(join(work,'platform-field-'+group.label+'.private.json')));
  const result=group.result;assert(result.normal&&result.allOwnedResourcesRetired&&result.phase==='CLOSED');
  assert(!result.formalFieldActivationGranted&&result.fieldEnabled&&!result.journalFailed);
  assert.equal(result.requestId,group.requestId);assert.equal(result.componentsCreated,8);assert.deepEqual(result.blocked,[]);
  assert.equal(result.fullyReady,group.label==='normal');assert.equal(result.startupCancelled,group.label==='cancel');
  assert(!owners.has(result.owner));owners.add(result.owner);
  const intent=await json(join(group.controllerDirectory,'launch-intent.json'));
  const config=await json(group.configurationFile);
  assert.equal(intent.format,'IDMS_PLATFORM_DEPENDENCY_LAUNCH_V3');assert.equal(intent.owner,result.owner);
  assert.equal(intent.configurationSha256,hash(canonical(config)));assert(config.field.enabled);
  for(const pin of intent.pins)assert.equal(hash(await readFile(pin.path)),pin.sha256);
  const events=await Promise.all((await readdir(group.controllerDirectory)).filter(n=>/^\d{6}\.private\.json$/.test(n)).sort().map(n=>json(join(group.controllerDirectory,n))));
  events.forEach((e,i)=>{assert.equal(e.sequence,i+1);assert.equal(e.owner,result.owner);});
  const created=events.filter(e=>e.event==='COMPONENT_CREATED'),retired=events.filter(e=>e.event==='COMPONENT_RETIRED');
  assert.deepEqual(created.map(e=>({id:e.id,kind:e.kind})),intent.componentOrder);
  assert.deepEqual(group.resources.map(e=>({id:e.id,kind:e.kind})),intent.componentOrder);
  assert.deepEqual(created.map(e=>e.kind),['POSTGRES','POSTGRES','IDENTITY','WORKFLOW','PREDICTOR','BROKER','APPLICATIONS','EDGE']);
  assert.deepEqual(retired.map(e=>e.id),created.map(e=>e.id).reverse());
  assert(events.filter(e=>e.event==='STOP_INTENT').every(e=>e.requestId===group.requestId));
  assert.equal(events.filter(e=>e.event==='PLATFORM_READY').length,group.label==='normal'?1:0);
  assert.equal(events.filter(e=>e.event==='STOP_BLOCKED').length,group.label==='normal'?1:0);
  for(const resource of group.resources){
   assert(Number.isInteger(resource.pid)&&resource.pid>0);
   // Windows may reuse a PID after a prior original process has fully retired.
   const processIdentity=resource.directory+'\0'+resource.pid;assert(!processes.has(processIdentity));processes.add(processIdentity);
   const create=created.find(e=>e.id===resource.id),retire=retired.find(e=>e.id===resource.id);
   assert.equal(create.pid,resource.pid);assert.equal(retire.pid,resource.pid);assert(retire.normal);
   assert.equal(retire.proofSha256,hash(canonical(resource.proof)));
   assert.deepEqual(await json(join(group.controllerDirectory,resource.id+'-retirement.private.json')),resource.proof);
   const p=resource.proof;
   if(resource.kind==='APPLICATIONS')siteCounts.push(await applicationProof(resource,group));
   else if(resource.kind==='EDGE')await edgeProof(resource,r.rootPid,group.requestId);
   else if(resource.kind==='BROKER')brokerBindings.push(await brokerProof(resource.directory,p,r.rootPid,group.requestId));
   else if(resource.kind==='PREDICTOR'){
    assert(p.normalClose&&p.allOwnedTerminalProven&&p.serverClosed&&!p.genericKillUsed);cleanExit(p.exit);
    assert.equal(p.requestId,group.requestId);assert.equal(p.pid,resource.pid);
    assert.equal(p.stats.active,0);assert.equal(p.stats.started,p.stats.finished+p.stats.aborted);
    assert.deepEqual(await json(join(resource.directory,'terminal-proof.json')),p);
   }else{
    assert.deepEqual(await json(join(resource.directory,'normal-stop-proof.json')),p);cleanExit(p.terminal);
    const launch=await json(join(resource.directory,'launch-intent.json'));
    assert.equal(launch.binding.owner,p.binding.owner);assert.equal(launch.binding.deployment,p.binding.deployment);
    if(resource.kind==='POSTGRES'){
     assert.equal(p.binding.pid,resource.pid);
     assert.equal(p.format,'IDMS_POSTGRES_NORMAL_STOP_PROOF_V1');assert.equal(p.requestId,group.requestId);
     assert(p.helperReplyConfirmed&&!p.genericKillUsed);cleanExit(p.helper);
     assert.equal(p.mode,'smart');assert.equal(p.otherClientsBefore,0);assert.equal(p.preparedTransactionsBefore,0);
     assert.equal(p.terminal.pid,resource.pid);assert.equal(p.terminal.owner,p.binding.owner);
     const stop=await json(join(resource.directory,'stop-intent.json'));assert.equal(stop.requestId,group.requestId);
     assert.deepEqual(stop.binding,p.binding);
    }else{
     assert.deepEqual(p.binding,{...resource.binding,requestId:p.binding.requestId});
     const bound=await json(join(resource.directory,'bound.json'));assert.equal(Number(bound.pid),resource.pid);assert.equal(bound.start,p.binding.start);
     assert(p.helperReplyConfirmed&&!p.targetSignalSent);assert.equal(p.completed.phase,'STOP_COMPLETED');
     assert.equal(Number(p.completed.pid),resource.pid);assert.equal(p.pid,resource.pid);
     assert.deepEqual(await json(join(resource.directory,'exit-observation.json')),p.exitObservation);
     if(resource.kind==='WORKFLOW')assert(p.gracefulWebCompleted&&p.poolCallbacksLogged);
     else assert(p.quarkusBlockingExitReturned&&!p.agentCallsSystemExit);
    }
   }
  }
  if(group.label==='normal'){
   const pg=group.resources.find(e=>e.id==='business');assert.equal(pg.pid,stage.blockedPgBeforeRetry.pid);
   assert.equal(pg.directory,stage.blockedPgBeforeRetry.directory);assert.deepEqual(pg.binding,stage.blockedPgBeforeRetry.binding);
   const blocked=events.find(e=>e.event==='STOP_BLOCKED');assert.equal(blocked.id,'business');
   assert(retired.filter(e=>e.id!=='business').every(e=>e.sequence<blocked.sequence));
   assert(blocked.sequence<retired.find(e=>e.id==='business').sequence);
  }
 }
 const unrelated=await brokerProof(stage.unrelatedDirectory,stage.unrelatedStop,r.rootPid);
 assert(stage.unrelatedLiveAfterBothCloses.ownListener&&stage.unrelatedLiveAfterBothCloses.eventAvailable);
 assert.equal(stage.unrelatedLiveAfterBothCloses.owner,unrelated.owner);assert.equal(stage.unrelatedLiveAfterBothCloses.pid,unrelated.pid);
 for(const own of brokerBindings){assert.notEqual(own.owner,unrelated.owner);assert.notEqual(own.port,unrelated.port);}
 const first=await stateAnchor(join(work,'platform-field-proofs.private.json'),nonce);
 const current=await stateAnchor(join(work,'platform-field-after-cancel-proofs.private.json'),nonce);
 assert.equal(first.a.format,'PLATFORM_FIELD_PROOFS_V1');assert.equal(current.a.format,'PLATFORM_FIELD_AFTER_CANCEL_PROOFS_V1');
 assert.deepEqual(current.page.items.map(x=>[x.point.id,x.receipt.auditEventId]),first.page.items.map(x=>[x.point.id,x.receipt.auditEventId]));
 for(const old of managerPage.items)assert.equal(current.page.items.find(x=>x.point.id===old.point.id).receipt.auditEventId,old.receipt.auditEventId);
 assert.equal(stage.finalPointCount,current.page.items.length);assert.equal(stage.currentMembershipProofs,first.members.size);
 assert.deepEqual(stage.fieldPointReceiptSetExpectedAfterStartupCancel,current.page.items.map(x=>[x.point.id,x.receipt.auditEventId]));
 assert(r.platformFieldAfterCancel.fieldPointReceiptSetUnchanged&&r.platformFieldAfterCancel.pendingPointsStillAbsent);
 assert.equal(r.platformFieldAfterCancel.currentMembershipProofs,current.members.size);
 const eventKey=await readFile(join(work,'field-site-materials/event.bin')),coverage=new Set();let signatures=0,finalAckRows=0;
 try{
  const events=new Map();for(const item of current.page.items){const event=verifyFieldEvent(item.receipt.envelope,eventKey,current.a.profile,current.key);events.set(fieldEventDigest(event),event);}
  function ack(raw){const event=events.get(raw.body.eventDigest);assert(event);const verified=verifyFieldAck(raw,current.key,event,raw.body.signedAtMs),item=current.page.items.find(x=>x.point.id===event.eventId);assert.equal(verified.body.status,'STORED');assert.equal(verified.body.receiptAuditId,item.receipt.auditEventId);coverage.add(event.eventId);signatures++;return event;}
  const archive=await json(join(work,'field-site-proofs.private.json'));for(const raw of archive.acks)ack(raw);
  for(const label of ['manager-spool-snapshot','edge-spool']){
   const directory=join(work,'field-site-materials',label),files=(await readdir(directory)).filter(n=>/^stream-[a-f0-9]{64}\.sqlite$/.test(n));assert.equal(files.length,1);
   const db=new DatabaseSync(join(directory,files[0]),{readOnly:true});
   try{
    assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0],'ok');
    const metadata=Object.fromEntries(db.prepare('SELECT name,value FROM metadata ORDER BY name').all().map(x=>[x.name,x.value])),{state_mac,...meta}=metadata;
    const mac=createHmac('sha256',eventKey).update('idms:field-spool-state:1\n'+stable(meta)+'\n');
    const pending=db.prepare('SELECT * FROM pending ORDER BY sequence_no').all();
    assert.equal(pending.length,current.a.profile.points.length);
    if(label==='edge-spool'){
     assert.equal(Number(metadata.sequence),current.a.retained.sequence);
     assert.equal(Number(metadata.sequence),stage.afterReplay.sequence+current.a.profile.points.length);
     assert.deepEqual(pending.map(x=>x.event_id),current.a.retained.pending.map(x=>x.event_id));
    }
    for(const row of pending){const event=verifyFieldEvent(JSON.parse(row.payload),eventKey,current.a.profile,current.key);assert.equal(event.eventId,row.event_id);assert.equal(event.sequenceNo,row.sequence_no);assert.equal(fieldEventDigest(event),row.digest);assert.equal(event.streamId,metadata.binding_digest);mac.update('P'+stable({...row,payload:hash(row.payload)})+'\n');}
    const acknowledged=db.prepare('SELECT * FROM acknowledged ORDER BY sequence_no').all();assert.equal(acknowledged.length,current.a.profile.points.length);
    for(const row of acknowledged){const event=ack(JSON.parse(row.ack));assert.equal(event.eventId,row.event_id);mac.update('A'+stable({...row,ack:hash(row.ack)})+'\n');}
    if(label==='edge-spool')finalAckRows=acknowledged.length;
    assert(timingSafeEqual(mac.digest(),Buffer.from(state_mac,'hex')));
   }finally{db.close();}
  }
  assert.deepEqual(coverage,new Set(current.page.items.map(x=>x.point.id)));
 }finally{eventKey.fill(0);}
 assert.equal(r.coreCleanupPostgres.length,2);for(const cleanup of r.coreCleanupPostgres){cleanExit(cleanup.proof.terminal);assert(cleanup.proof.helperReplyConfirmed);assert.deepEqual(await json(join(cleanup.directory,'normal-stop-proof.json')),cleanup.proof);}
 return {controllerGenerations:2,actualDeclaredResourcesPerGeneration:8,actualApplicationChildrenPerGeneration:9,controllerReverseRetirementsVerified:true,sameRequestBlockedRetryVerified:true,startupCancellationVerified:true,unrelatedBrokerIsolationVerified:true,currentRootProofs:current.members.size,currentStoredPoints:current.page.items.length,currentPointAckCoverage:coverage.size,verifiedAckSignatureOccurrences:signatures,finalRetainedAckRows:finalAckRows,finalSpoolStateMacVerified:true,siteHostRetirements:siteCounts.map(c=>c.hostConnectionsRetired),siteOwnerRetirements:siteCounts.map(c=>c.ownerConnectionsRetired),formalFieldActivationGranted:false,allProductionDependenciesRegistered:false,fullGoalComplete:false};
}
