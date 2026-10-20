import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../../server/imports.ts';
import {readEntities} from '../../server/entity-repository.ts';
import {tenantWorkspace,workspacePayload} from '../../server/tenant-workspace.ts';
import {savePostgres} from '../../server/postgres-repository.ts';
import {createTemplate} from '../../server/catalog.ts';
import {CurrentRecoveryActor} from '../field-recovery-current-actor.mjs';
import {readCurrentRecoveryReview} from '../field-recovery-review.mjs';
import {openPublicationQaContext} from './field-activation-publication-context.mjs';
import {writePrivate} from '../keycloak-local.mjs';

export async function exerciseActivationOperation({directory,args,oracle,request,browserReview}){
 assert.equal(process.env.IDMS_FIELD_ACTIVATION_OPERATION_QA,'1');assert.equal(process.env.IDMS_FIELD_ACTIVATION_MATERIAL_QA,'1');assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);
 let c;let plan,expected;
 try{c=await openPublicationQaContext(args);const image=await readCurrentRecoveryReview(c);plan=image.review.plan;expected=image.facts.factsSha256;if(process.env.IDMS_FIELD_COMBINED_RECOVERY_QA==='1'){assert.equal(browserReview?.browserApprovedPlanId,plan.planId);assert.equal(browserReview?.browserApprovedFactsSha256,expected);assert.equal(browserReview?.actualBrowserAuthorSubmitAndIndependentReviewerApprove,true);}}finally{await c?.close();}
 const allowed=['--authority-config','--runtime-config','--target-runtime-config','--target-migration-config','--target-backup-config','--backup-file','--key-file','--control-file','--operation-id','--tenant','--registration-config','--material-configuration','--external-config','--access-token-file'];
 const common=Object.fromEntries(allowed.map(k=>[k,args[k]]));assert.ok(Object.values(common).every(Boolean));
 const token=async role=>writePrivate(args['--access-token-file'],await request(role));
 const start=(action,attemptId,{mode,overrides={}}={})=>{
  const fields={...common,'--action':action,'--attempt-id':attemptId,'--plan-id':plan.planId,...(action==='activate'?{'--expected-facts-sha256':expected}:{}),...overrides},argv=Object.entries(fields).flat();
  const child=fork(resolve(mode?'scripts/fixtures/field-activation-operation-probe.mjs':'scripts/field-activate.mjs'),argv,{windowsHide:true,env:{...process.env,NODE_ENV:'test',...(mode?{IDMS_FIELD_ACTIVATION_OPERATION_QA_MODE:mode,IDMS_FIELD_ACTIVATION_OPERATION_QA_DIRECTORY:directory}:{})},stdio:['ignore','pipe','pipe','ipc']});let stdout='',stderr='',wire,terminal=false;
  child.stdout.on('data',b=>stdout=(stdout+b).slice(-65536));child.stderr.on('data',b=>stderr=(stderr+b).slice(-4096));child.on('message',m=>{if(m.type==='WIRE_COMMIT_PROOF')wire=m;});
  const closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>{terminal=true;ok({code,signal,stdout,stderr,wire});});});
  return {child,closed,get terminal(){return terminal;}};
 };
 const run=async(action,id,options={})=>{const worker=start(action,id,options),timer=setTimeout(()=>worker.child.kill(),90000);try{const r=await worker.closed;if(r.code!==0&&options.fail!==true)throw Error('Activation CLI failed: '+r.stderr);assert.equal(r.code===0,options.fail!==true,r.stderr);return {...r,value:JSON.parse(r.code===0?r.stdout:r.stderr)};}finally{clearTimeout(timer);if(!worker.terminal){worker.child.kill();await worker.closed;}}};
 const before=await oracle(),heldId=randomUUID();
 await token('AUTHOR');await run('activate',heldId,{fail:true});assert.deepEqual(await oracle(),before);
 await assert.rejects(readFile(resolve(directory,'recovery.json.operations',args['--operation-id']+'.activation-publication-'+heldId+'.json')),e=>e.code==='ENOENT');
 await token('FOREIGN');await run('activate',heldId,{fail:true});assert.deepEqual(await oracle(),before);
 await token('REVIEWER');const wrong=await run('activate',heldId,{fail:true,overrides:{'--expected-facts-sha256':'0'.repeat(64)}});assert.equal(wrong.value.code,'FIELD_ACTIVATION_EXPECTED_APPROVAL_CHANGED');assert.deepEqual(await oracle(),before);
 const materialBytes=await readFile(args['--material-configuration']),invalidMaterials={...JSON.parse(materialBytes),format:'not-activation-materials'};await writeFile(args['--material-configuration'],canonical(invalidMaterials));try{await run('activate',randomUUID(),{fail:true});assert.equal(JSON.parse(await readFile(args['--control-file'])).state,'RESTORING');assert.deepEqual(await oracle(),before);}finally{await writeFile(args['--material-configuration'],materialBytes);}
 const held=start('activate',heldId,{mode:'HOLD_BEFORE_COMMIT'});let entered;
 try{
  entered=await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('Activation hold timed out')),60000);held.child.on('message',m=>{if(m.type==='BEFORE_COMMIT'){clearTimeout(timer);ok(m);}});held.closed.then(r=>{clearTimeout(timer);no(Error('Activation hold exited: '+r.stderr));});});
  assert.equal(JSON.parse(await readFile(args['--control-file'])).state,'ACTIVE');assert.deepEqual(await oracle({sequence:false}),{...before,seq:null});
 }finally{if(!held.terminal)held.child.kill();await held.closed;}
 const authority=JSON.parse(await readFile(args['--authority-config'])),target=JSON.parse(await readFile(args['--target-runtime-config'])),a=target.tenants.acme;
 const admin=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:a.database});await admin.connect();try{const limit=Date.now()+10000;while((await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[entered.backend])).rowCount){assert.ok(Date.now()<limit,'Actual killed backend must terminate');await new Promise(ok=>setTimeout(ok,20));}}finally{await admin.end();}
 assert.deepEqual(await oracle(),before);
 let revoked=false;
 try{await request('REVOKE_AUTHOR');revoked=true;const rejected=await run('recover',heldId,{fail:true});assert.equal(rejected.value.code,'FIELD_RECOVERY_ACTOR_REVOKED');assert.equal(JSON.parse(await readFile(args['--control-file'])).state,'ACTIVE');assert.deepEqual(await oracle(),before);}finally{if(revoked)await request('RESTORE_AUTHOR');}
 await token('REVIEWER');const restored=(await run('recover',heldId)).value;assert.equal(restored.state,'RESTORING');assert.equal(restored.newAttemptIdRequired,true);assert.deepEqual(await oracle(),before);
 assert.equal((await run('recover',heldId)).value.state,'RESTORING');assert.deepEqual(await oracle(),before);
 const committedId=randomUUID();await token('REVIEWER');const committed=await run('activate',committedId,{mode:'DROP_WIRE_COMMIT_REPLY'});
 const attemptFile=resolve(directory,'recovery.json.operations',args['--operation-id']+'.activation-attempt-'+committedId+'.json'),attemptBytes=await readFile(attemptFile),attempt=JSON.parse(attemptBytes);assert.equal(attempt.format,'idms-field-activation-attempt-v2');assert.equal(attempt.materialEvidence.activationGranted,false);assert.ok(attempt.materialEvidence.channels.every(c=>c.mqttTls.length===2&&c.mqttTls.every(p=>p.peerRequiresClientCertificate&&!p.mqttClientCreated)));
 assert.equal(committed.value.state,'ACTIVE');assert.equal(committed.wire?.actualStartupMatched,true);assert.equal(committed.wire?.actualActivationCommitQueryObserved,true);assert.equal(committed.wire?.actualServerCommitCompletionDiscarded,true);
 const legacy={...attempt,format:'idms-field-activation-attempt-v1'};delete legacy.materialEvidence;await writeFile(attemptFile,canonical(legacy));try{const denied=await run('recover',committedId,{fail:true});assert.equal(denied.value.code,'FIELD_ACTIVATION_MATERIAL_V2_REQUIRED');assert.equal(await readFile(attemptFile,'utf8'),canonical(legacy));}finally{await writeFile(attemptFile,attemptBytes);}
 const after=await oracle();assert.equal(after.fixed,before.fixed);assert.equal(after.audits.length,before.audits.length+2);assert.equal(BigInt(after.seq[0].last_value),BigInt(before.seq[0].last_value)+2n);
 const config=JSON.parse(await readFile(args['--external-config'])),identity=new CurrentRecoveryActor(config);let actor;
 try{actor=await identity.verify(await request('AUTHOR'),{purpose:'AUTHOR'});}finally{await identity.close();}
 const app=new pg.Client({host:target.host,port:target.port,...a});await app.connect();try{await app.query('BEGIN');await app.query('SELECT tenant_id FROM public.business_state WHERE tenant_id=$1 FOR UPDATE',['acme']);const loaded=await readEntities(app,'acme'),w=tenantWorkspace(loaded.payload);createTemplate(w.store,{templateKey:'activation-operation-'+randomUUID().replaceAll('-','').slice(0,10),version:'1.0.0',industry:'恢复后业务验证',manifest:{schemaVersion:1,minPlatformVersion:'0.1.0',modules:['maintenance'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},maintenance:{fields:[]}}},{tenantId:'acme',actorId:actor.actorId,actorType:'USER',authMode:'oidc',roles:actor.roles,scope:actor.scope,correlationId:randomUUID()},w.imports);await savePostgres(workspacePayload(w,'acme'),{tenantId:'acme',client:app,...loaded});await app.query('COMMIT');}finally{await app.end();}
 const advanced=await oracle();assert.equal(advanced.audits.length,after.audits.length+1);await token('REVIEWER');const repeated=(await run('recover',committedId)).value;assert.deepEqual(repeated.receipt,committed.value.receipt);assert.equal(repeated.alreadyRecorded,true);assert.equal(repeated.currentRevision,committed.value.receipt.revision+1);assert.deepEqual(await oracle(),advanced);
 const resultFile=resolve(directory,'recovery.json.operations',args['--operation-id']+'.activation-result-'+committedId+'.json'),bytes=await readFile(resultFile),bad={...JSON.parse(bytes),phaseSha256:'0'.repeat(64)};await writeFile(resultFile,canonical(bad));
 try{
  await request('REVOKE_AUTHOR');revoked=true;const denied=await run('recover',committedId,{fail:true});assert.equal(denied.value.code,'FIELD_RECOVERY_ACTOR_REVOKED');assert.equal(await readFile(resultFile,'utf8'),canonical(bad));
  await request('RESTORE_AUTHOR');revoked=false;await token('REVIEWER');const corrupt=await run('recover',committedId,{fail:true});assert.equal(corrupt.value.code,'FIELD_ACTIVATION_RESULT_CONFLICT');assert.equal(await readFile(resultFile,'utf8'),canonical(bad));
 }finally{if(revoked)await request('RESTORE_AUTHOR');await writeFile(resultFile,bytes);}
 assert.deepEqual(await oracle(),advanced);await token('REVIEWER');assert.deepEqual((await run('activate',committedId)).value.receipt,committed.value.receipt);assert.deepEqual(await oracle(),advanced);
 let activatedStream=null;if(process.env.IDMS_FIELD_ACTIVATION_STREAM_QA==='1'){const {exerciseActivatedArchiveStream}=await import('./field-activation-stream-checks.mjs');activatedStream=await exerciseActivatedArchiveStream({directory,args,request});await token('REVIEWER');const current=(await run('recover',committedId)).value;assert.deepEqual(current.receipt,committed.value.receipt);Object.assign(advanced,await oracle());}
 await request('ADVANCE_WORKFLOW');await token('REVIEWER');const drift=await run('recover',committedId,{fail:true});assert.match(drift.value.code,/^FIELD_RECOVERY_WORKFLOW_/);assert.deepEqual(await oracle(),advanced);assert.equal(JSON.parse(await readFile(args['--control-file'])).state,'ACTIVE');
 return {...(process.env.IDMS_FIELD_COMBINED_RECOVERY_QA==='1'?{actualExactBrowserApprovedPlanAndFactsUsedForFormalActivation:true}:{}),...(activatedStream?{activatedStream}:{}),actualFormalActivateAndRecoverCli:true,mandatoryMaterialAttemptV2:true,actualMaterialV2EvidenceBothPeerRolesAndLegacyDowngradeRefusal:true,actualInvalidMaterialPreparationAutomaticallyResolvedToFrozenRestoring:true,actualUnapprovedActorAndWrongFactsRefusedBeforePublication:true,actualControllerKilledAfterPublicationBeforeCommit:true,actualSqlBackendTerminationAndFullRollbackVerified:true,currentAuthorRevocationRefusesRearmAndRetainsActiveFrozenWindow:true,exactSameAttemptRearmAfterAuthenticatedFrozenFullFactsAndAncestors:true,repeatedPrecommitRecoveryPreservesAllSqlFacts:true,actualWireCommitCommandCompleteDiscarded:true,actualCommitUncertaintyResolvedFromFreshAuthenticatedDatabaseState:true,actualNormalApplicationDomainCommandAfterCommit:true,currentAuthorizedIdempotentReceiptAfterLegitimateBusinessAdvance:true,currentAuthorRevocationPrecedesCorruptIdempotentResult:true,corruptResultRefusedAndRetained:true,repeatActivateReturnsSameReceiptWithoutDuplicateSql:true,actualExternalWorkflowAdvanceRefusesCommittedReceiptWithoutWrites:true,newFieldStreamFollowingFormalActivationVerified:!!activatedStream,fieldRuntimeStarted:!!activatedStream,newFieldCodeDeployed:false,fieldCommissioned:false,productionAcceptance:false};
}
