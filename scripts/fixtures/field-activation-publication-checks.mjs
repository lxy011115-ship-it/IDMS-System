import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {canonical} from '../../server/imports.ts';
import {loadFieldPlatformConfig} from '../../server/field-config.ts';
import {readCurrentRecoveryReview} from '../field-recovery-review.mjs';
import {readReviewPhase} from '../field-recovery-review-record.mjs';
import {sourceSecurityFrame} from '../field-source-freeze-security.mjs';
import {sourceFreezeSha as sha} from '../field-source-freeze-policy.mjs';
import {FieldRecoveryAuthorityLock} from '../field-recovery-lock.mjs';
import {FieldActivationPublication} from '../field-activation-publication.mjs';
import {writePrivate} from '../keycloak-local.mjs';
import {openPublicationQaContext} from './field-activation-publication-context.mjs';
export async function exerciseActivationPublication({directory,args,oracle}){
 const before=await oracle(),attemptId=randomUUID(),input=resolve(directory,'activation-publication-probe.json');await writePrivate(input,JSON.stringify({args,attemptId}));
 const child=fork(resolve('scripts/fixtures/field-activation-publication-probe.mjs'),[input],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,NODE_ENV:'test'}});let stderr='',terminal=false;
 child.stderr.on('data',b=>stderr=(stderr+b).slice(-4096));const closed=new Promise(ok=>child.once('close',(code,signal)=>{terminal=true;ok({code,signal});}));
 let publication,guard,db,c;
 try{
  const staged=await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('Activation publication probe timed out')),45000);child.once('message',v=>{clearTimeout(timer);v.type==='PUBLISHED_UNCOMMITTED'?ok(v):no(Error('Unexpected publication message'));});child.once('error',e=>{clearTimeout(timer);no(e);});child.once('exit',()=>{clearTimeout(timer);no(Error('Publication probe exited: '+stderr));});});
  const [authority,target,migration]=await Promise.all(['--authority-config','--target-runtime-config','--target-migration-config'].map(key=>readFile(args[key],'utf8').then(JSON.parse))),a=target.tenants[args['--tenant']],m=migration.tenants[args['--tenant']];
  const actual=JSON.parse(await readFile(args['--control-file'],'utf8'));assert.equal(actual.state,'ACTIVE');assert.equal(sha(actual),staged.controlSha256);await assert.rejects(readFile(args['--control-file']+'.operation.lock'),e=>e.code==='ENOENT');
  db=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:a.database,connectionTimeoutMillis:5000,query_timeout:10000});db.on('error',()=>{});await db.connect();
  await sourceSecurityFrame(db,a,m.user,'FROZEN');assert.equal(sha(await readReviewPhase(db,a.database)),staged.phaseSha256);
  const held=(await db.query('SELECT state,xact_start IS NOT NULL AS transaction_open FROM pg_stat_activity WHERE pid=$1',[staged.backend])).rows[0];assert.equal(held?.state,'idle in transaction');assert.equal(held.transaction_open,true);
  for(const account of [a,m]){const client=new pg.Client({host:target.host,port:target.port,...account,connectionTimeoutMillis:4000});client.on('error',()=>{});try{await assert.rejects(client.connect(),e=>e.code==='28000');}finally{await client.end().catch(()=>{});}}
  const hidden=await oracle({sequence:false});assert.deepEqual({...hidden,seq:before.seq},before);
  assert.equal(child.kill(),true);await closed;const deadline=Date.now()+5000;while((await db.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[staged.backend])).rowCount){assert.ok(Date.now()<deadline,'Controller SQL backend still live');await new Promise(ok=>setTimeout(ok,20));}
  await sourceSecurityFrame(db,a,m.user,'FROZEN');assert.equal(sha(await readReviewPhase(db,a.database)),staged.phaseSha256);assert.deepEqual(await oracle(),before);
  guard=new FieldRecoveryAuthorityLock(authority,args['--tenant']);guard.setWorkspace(args['--control-file']);await guard.acquire();publication=new FieldActivationPublication(guard,args['--control-file']);const intent=await publication.load(args['--operation-id'],attemptId);assert.equal(sha(intent.approvalPhase),staged.phaseSha256);assert.equal((await publication.inspect()).released,true);
  const unknown=resolve(args['--control-file']+'.operations',args['--operation-id']+'.activation-unknown.json');await writeFile(unknown,'{}');try{await assert.rejects(publication.inspect(),e=>e.code==='FIELD_ACTIVATION_PUBLICATION_JOURNAL_INVALID');assert.equal(await readFile(unknown,'utf8'),'{}');}finally{await unlink(unknown);}
  const path=publication.path('publication'),bytes=await readFile(path),tampered={...intent,planSha256:'0'.repeat(64)};await writeFile(path,canonical(tampered));try{await assert.rejects(publication.rearmRestoring(),e=>e.code==='FIELD_ACTIVATION_PUBLICATION_INTENT_CHANGED');assert.equal(await readFile(path,'utf8'),canonical(tampered));assert.equal(JSON.parse(await readFile(args['--control-file'],'utf8')).state,'ACTIVE');}finally{await writeFile(path,bytes);}
  await sourceSecurityFrame(db,a,m.user,'FROZEN');assert.deepEqual(await readReviewPhase(db,a.database),intent.approvalPhase);
  const nativeMove=guard.nativeMove,activeBytes=await readFile(args['--control-file']);let injected=false;guard.nativeMove=async function(options){if(options.mode==='Publish'&&!injected){injected=true;await writeFile(args['--control-file'],canonical({...intent.after,changedAtMs:intent.after.changedAtMs+1}));}return nativeMove.call(this,options);};try{await assert.rejects(publication.rearmRestoring(),e=>e.code==='FIELD_RECOVERY_NATIVE_MOVE_UNCONFIRMED');assert.equal(injected,true);assert.equal(JSON.parse(await readFile(args['--control-file'],'utf8')).changedAtMs,intent.after.changedAtMs+1);assert.deepEqual(JSON.parse(await readFile(args['--control-file']+'.operation.lock','utf8')),JSON.parse(await readFile(resolve(args['--control-file']+'.operations',args['--operation-id']+'.intent.json'),'utf8')));}finally{guard.nativeMove=nativeMove;await writeFile(args['--control-file'],activeBytes);}
  await publication.rearmRestoring();assert.equal((await publication.inspect()).markerPresent,true);assert.equal(JSON.parse(await readFile(args['--control-file'],'utf8')).state,'RESTORING');await assert.rejects(loadFieldPlatformConfig(args['--registration-config']));
  await publication.close();publication=null;await guard.close();guard=null;await db.end();db=null;
  c=await openPublicationQaContext(args);const image=await readCurrentRecoveryReview(c);assert.equal(image.facts.factsSha256,staged.factsSha256);assert.equal(sha(image.phase),staged.phaseSha256);await c.close();c=null;assert.deepEqual(await oracle(),before);
  return {actualPreviouslyApprovedV2PlanAndAuthenticatedRestoredTarget:true,immutablePublicationIntentBeforeNativeActiveMove:true,nativeWriteThroughActiveAndExactOriginalMarkerRelease:true,normalLoaderReadsActiveButActualAppAndMigratorLoginStillRefused:true,observerStillSeesFrozenCatalogAndApprovedPhase:true,...(process.env.IDMS_FIELD_ACTIVATION_TRANSACTION_QA==='1'?{actualNewRegistrationAndActivationAuditPhasePreparedInSameTransaction:true,actualCurrentReviewerAuthorWorkflowAndMaterialRecheckedAfterNativePublish:true,allBusinessTablesRootAndAuditsStillInvisibleBeforeCommit:true,actualSequenceAndAllAuditRowsRolledBackAfterControllerTermination:true}:{allTablesRootAuditAndSequenceUnchangedInUncommittedWindow:true}),actualPublishingControllerTerminatedAndSqlBackendTerminal:true,actualCatalogRollbackAfterControllerTermination:true,unknownActivationFileRefusedAndRetained:true,tamperedPublicationIntentRefusedAndRetained:true,actualNativeControlCasLossRejectedWithoutRepair:true,markerRemainsClosedAfterRearmCasLoss:true,exactSameAttemptNativeMarkerRearmAndRestoringCas:true,fullArchiveRestoreAndReviewAncestorChainReverifiedAfterRearm:true,allFactsUnchangedAfterNativeRecovery:true,formalFinalActivationCommitNotPerformed:true,currentExternalIdentityAndTlsChecksNotPartOfThisPrimitiveTest:true,fieldActivated:false,productionAcceptance:false};
 }finally{if(!terminal)child.kill();await closed;await c?.close();await db?.end().catch(()=>{});await publication?.close();await guard?.close();assert.equal(terminal,true);}
}
