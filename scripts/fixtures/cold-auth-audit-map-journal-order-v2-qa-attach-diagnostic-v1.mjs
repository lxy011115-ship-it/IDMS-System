import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {decodeJwt} from 'jose';
import {canonical} from '../../server/imports.ts';
import {authorityJsonV1} from '../../server/identity-authority-live-v1.ts';
import {readRuntimeColdReviewV3} from '../runtime-cold-readonly-control-v5.mjs';
import {reviewSourceHashV1 as hash} from '../workflow-review-source-facts-v1.mjs';
import {privateNewFile} from '../backup-support.mjs';
import {createPlatformFieldAdminQaV1} from './platform-field-admin-v1-qa.mjs';
import {exerciseColdCurrentActorsQaV3} from './cold-current-actors-v3-qa.mjs';
import {exerciseColdAuthAuditMapLiveQaV2} from './cold-auth-audit-map-live-v2-qa-attach-diagnostic-v1.mjs';

/** Real owned native extension: live OIDC, original held Flowable and durable control-store plans. */
export async function exerciseColdAuthAuditMapJournalQaV2(o){
 await exerciseColdCurrentActorsQaV3(o);
 await exerciseColdAuthAuditMapLiveQaV2(o);
 const{control,ownedSession,config,recoveryId,identity,site,work,runtime,origin,save,note,report}=o,read=async p=>JSON.parse(await readFile(p,'utf8'));
 const fixture=await read(join(work,'current-actors-identity.private.json')),privateIdentity=await read(join(work,'identity.private.json')),api=createPlatformFieldAdminQaV1({issuer:identity.runtime.issuer,admin:privateIdentity.admin}),users=fixture.users,realm=identity.realm;
 const original=await readRuntimeColdReviewV3(config.trust),intentHash=hash(original.details.review),sourceHash=hash(original.source),plan1=randomUUID(),plan2=randomUUID();
 const assertOriginal=async()=>{const v=await readRuntimeColdReviewV3(config.trust);assert.equal(v.phase,'REVIEW_READY_V3');assert.equal(hash(v.source),sourceHash);assert.equal(hash(v.details.review),intentHash);assert.equal(ownedSession.state().phase,'HELD');assert.equal(v.details.review.businessAdmissionGranted,false);return v;};
 const login=async u=>{const token=await authorityJsonV1(identity.runtime.issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:fixture.humanClient,username:u.username,password:u.password,scope:'openid'})});assert(decodeJwt(token.access_token).exp-decodeJwt(token.access_token).iat>=590);return token.access_token;};
 const participants=async({swap=false,omit=false}={})=>{const rows=[];for(const tenant of['acme','sandbox'])rows.push({configuration:{format:'idms-field-recovery-external-config-v1',tenantId:tenant,auth:{...site.auth,clientId:fixture.humanClient},identityReader:{...fixture.reader,loginClientUuid:fixture.humanClientUuid},workflow:{baseUrl:origin,recoveryReadToken:runtime.tenants[tenant].recoveryReadToken,authorityId:runtime.tenants[tenant].recoveryAuthorityId,definitionSha256:runtime.tenants[tenant].bpmnSha256}},authorAccessToken:await login(users[tenant][swap?'contributor':'author']),contributorAccessTokens:omit?[]:[await login(users[tenant][swap?'author':'contributor'])],reviewerAccessToken:await login(users[tenant].reviewer)});return rows;};
 const submit=(planId,expectedHeadSha256,rows)=>control.submitCurrentPlan({recoveryId,session:ownedSession,participants:rows,planId,expectedHeadSha256});
 const inspect=()=>control.inspectCurrentPlan({recoveryId,session:ownedSession});
 const verifySubmission=(v,id,revision)=>{assert.equal(v.format,'COLD_CURRENT_PLAN_SUBMISSION_STATUS_V1');assert(v.planSubmitted&&v.currentOidcReviewerVerified&&v.durablePlanContributorsVerified&&v.independentReviewersVerified&&!v.reviewApproved&&!v.formalFieldActivationGranted&&!v.fullGoalComplete);assert.equal(v.currentPlanSubmission.plan.planId,id);assert.equal(v.currentPlanSubmission.revision,revision);assert.equal(v.currentPlanSubmission.plan.approvalGranted,false);assert.equal(v.currentPlanSubmission.plan.formalFieldActivationGranted,false);assert.equal(v.currentPlanSubmission.plan.intentSha256,intentHash);assert.equal(v.currentPlanSubmission.plan.sourceHash,sourceHash);for(const t of v.currentPlanSubmission.plan.tenants){assert.equal(t.contributorIds.length,2);assert(!t.contributorIds.includes(t.observedIndependentReviewerId));}};
 const empty=await inspect();assert.equal(empty.format,'COLD_CURRENT_PLAN_STATUS_V1');assert(empty.planLineageVerified&&!empty.currentOidcReviewerVerified&&!empty.durablePlanContributorsVerified&&!empty.reviewApproved&&!empty.formalFieldActivationGranted);assert.deepEqual(empty.currentPlanStatus,{revision:0,headSha256:null,plan:null});await save('plan-journal-empty-live.private.json',empty);await assertOriginal();
 note('the original held session reads an empty durable plan lineage after complete source and SQL verification without treating history reads as current authentication or approval');

 const first=await submit(plan1,null,await participants());verifySubmission(first,plan1,1);assert.equal(first.currentPlanSubmission.alreadyRecorded,false);await save('plan-journal-first-live.private.json',first);
 const replay=await submit(plan1,null,await participants());verifySubmission(replay,plan1,1);assert(replay.currentPlanSubmission.alreadyRecorded);assert.equal(replay.currentPlanSubmission.planSha256,first.currentPlanSubmission.planSha256);assert.equal(replay.currentPlanSubmission.plan.expiresAt,first.currentPlanSubmission.plan.expiresAt);await save('plan-journal-replay-live.private.json',replay);await assertOriginal();
 note('actual current authors and contributors submit a signed durable plan inside the original coordinator transaction; fresh actual authentication replays the same plan and lifetime without a second revision');

 const second=await submit(plan2,first.currentPlanSubmission.planSha256,await participants({swap:true}));verifySubmission(second,plan2,2);assert.equal(second.currentPlanSubmission.alreadyRecorded,false);assert.equal(second.currentPlanSubmission.plan.parentSha256,first.currentPlanSubmission.planSha256);
 for(const t of second.currentPlanSubmission.plan.tenants){assert.equal(t.authorId,users[t.tenantId].contributor.id);assert.deepEqual(t.contributorIds,[users[t.tenantId].author.id,users[t.tenantId].contributor.id].sort());assert.equal(t.observedIndependentReviewerId,users[t.tenantId].reviewer.id);}
 await save('plan-journal-second-live.private.json',second);await assertOriginal();
 note('a second actual author submission supersedes the first through head CAS and signed ancestry; every prior actual author and declared coauthor remains freshly verified and excluded from reviewing');

 const rejected=[];const deny=async(name,request,pattern)=>{await assert.rejects(request,pattern);rejected.push(name);const v=await assertOriginal();assert.equal(v.details.planJournal.body.revision,2);assert.equal(v.details.planJournal.body.headSha256,second.currentPlanSubmission.planSha256);};
 await deny('prior contributor omitted',submit(randomUUID(),second.currentPlanSubmission.planSha256,await participants({swap:true,omit:true})),/COLD_PLAN_CONTRIBUTOR_OMITTED/);
 await deny('stale expected parent',submit(randomUUID(),first.currentPlanSubmission.planSha256,await participants({swap:true})),/COLD_PLAN_HEAD_CAS/);
 await deny('same UUID replay author changed',submit(plan2,first.currentPlanSubmission.planSha256,await participants()),/COLD_PLAN_REPLAY_PARTICIPANTS_OR_INPUTS_CHANGED/);
 const authorRole=await api(realm+'/roles/tenant-admin'),rows=await participants({swap:true});
 try{await api(realm+'/users/'+users.acme.author.id+'/role-mappings/realm','DELETE',[authorRole]);await deny('actual ancestor contributor authorization revoked',submit(randomUUID(),second.currentPlanSubmission.planSha256,rows),/FIELD_RECOVERY_ACTOR_REVOKED/);}finally{await api(realm+'/users/'+users.acme.author.id+'/role-mappings/realm','POST',[authorRole]);}
 const db=new DatabaseSync(config.trust.storeFile,{allowExtension:false});let oldSignature;
 try{db.exec('BEGIN IMMEDIATE');const row=db.prepare('SELECT signature FROM cold_review_plans_v1 WHERE revision=2 AND plan_id=?').get(plan2);assert(row);oldSignature=row.signature;assert.equal(db.prepare('UPDATE cold_review_plans_v1 SET signature=? WHERE revision=2 AND plan_id=?').run('0'.repeat(64),plan2).changes,1);db.exec('COMMIT');
  await deny('actual persisted signature tampered',inspect(),/COLD_PLAN_SIGNATURE/);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');if(oldSignature){db.exec('BEGIN IMMEDIATE');assert.equal(db.prepare('UPDATE cold_review_plans_v1 SET signature=? WHERE revision=2 AND plan_id=?').run(oldSignature,plan2).changes,1);db.exec('COMMIT');}db.close();}
 await save('plan-journal-negative-cases.json',{cases:rejected,allRejected:true,unchangedRevision:2,unchangedHeadSha256:second.currentPlanSubmission.planSha256,originalIntentUnchanged:true,reviewApproved:false,formalFieldActivationGranted:false});
 note('actual plan requests reject omitted ancestral contributors, stale CAS, a changed replay author, live ancestor-role revocation and a real control-store signature alteration without changing the durable head or original intent');

 const final=await inspect();assert.equal(final.currentPlanStatus.revision,2);assert.equal(final.currentPlanStatus.headSha256,second.currentPlanSubmission.planSha256);assert.deepEqual(final.currentPlanStatus.plan,second.currentPlanSubmission.plan);assert(final.planLineageVerified&&!final.currentOidcReviewerVerified&&!final.durablePlanContributorsVerified&&!final.reviewApproved&&!final.formalFieldActivationGranted);await save('plan-journal-final-live.private.json',final);
 const current=await assertOriginal(),credentials=await read(current.details.review.credentialFile),input=join(dirname(config.trust.storeFile),'plan-journal-reopen.private.json');await privateNewFile(input,canonical({format:'COLD_PLAN_JOURNAL_REOPEN_INPUT_V2',context:{trust:config.trust,source:current.source,recoveryId,intentSha256:intentHash,credentialSha256:current.details.review.credentialSha256,workDirectory:config.workDirectory},credentials,storeFile:config.trust.storeFile}));
 const reopened=JSON.parse((await promisify(execFile)(process.execPath,['scripts/fixtures/cold-plan-journal-reopen-v2-qa.mjs',input],{windowsHide:true,maxBuffer:1024**2})).stdout);assert.equal(reopened.revision,2);assert.equal(reopened.headSha256,second.currentPlanSubmission.planSha256);assert.equal(reopened.liveAuthenticationPerformed,false);assert(!reopened.approvalGranted&&!reopened.formalFieldActivationGranted);await save('plan-journal-process-reopen.json',reopened);
 report.planJournal={format:'COLD_PLAN_JOURNAL_LIVE_QA_V1',actualOriginalCoordinatorSubmissionVerified:true,actualContributorsDerivedFromSignedLineage:true,actualAuthorChangeVerified:true,freshReplayWithoutNewRevision:true,completeOriginalIntentUnchanged:true,actualAncestorRoleRevocationRejected:true,actualPersistedSignatureTamperRejected:true,actualProcessReopenVerified:true,historyReadDoesNotClaimCurrentIdentity:true,sourceHash,intentSha256:intentHash,plan1,plan2,revision:2,headSha256:second.currentPlanSubmission.planSha256,negativeCaseCount:rejected.length,positiveFullFactCaptures:5,currentActorPlanObservations:3,additionalHeldWorkflowCaptures:8,reviewApproved:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 note('a fresh actual Node process authenticates the full durable plan history and final held-session read verifies the same head; historical lineage verification grants neither current identity nor human approval or activation');
}
