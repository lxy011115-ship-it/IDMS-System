import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname,join,resolve} from 'node:path';
import {privateNewFile} from '../scripts/backup-support.mjs';
import {canonical} from '../server/imports.ts';
import {reviewSourceHashV1 as hash} from '../scripts/workflow-review-source-facts-v1.mjs';
import {readColdPlanJournalV1,submitColdPlanJournalV1} from '../scripts/cold-review-plan-journal-v1.mjs';
import {RuntimeColdReadOnlyPreparationV11} from '../scripts/runtime-cold-review-prepare-v13.mjs';
import {coldPlanJournalInputQaV1} from './fixtures/cold-plan-journal-input-v1.mjs';
import {coldReadonlyInputQaV3,coldReviewUnitIdV3 as recoveryId} from './fixtures/cold-readonly-review-input-v3.mjs';

async function fixture(t){const f=await coldPlanJournalInputQaV1();t.after(()=>f.close());return f;}
const args=f=>({db:f.db,details:f.details,context:f.context,credentials:f.credentials});
const submit=(f,current,planId=randomUUID(),expectedHeadSha256=null)=>submitColdPlanJournalV1({...args(f),current,request:{planId,expectedHeadSha256}});

test('a committed submission persists a signed sibling anchor and leaves the original intent unchanged',async t=>{
 const f=await fixture(t),before=canonical(f.details.review),current=await f.current();f.begin();const result=await submit(f,current);f.commit();
 assert.equal(result.revision,1);assert.equal(result.alreadyRecorded,false);assert.equal(result.plan.approvalGranted,false);assert.equal(result.plan.formalFieldActivationGranted,false);assert.equal(Date.parse(result.plan.expiresAt)-Date.parse(result.plan.createdAt),1800000);assert.equal(canonical(f.details.review),before);
 f.reopen();f.begin();const persisted=await readColdPlanJournalV1(args(f));assert.equal(persisted.headSha256,result.planSha256);assert.equal(persisted.records.length,1);assert.deepEqual(persisted.head.tenants[0].contributorIds,['acme-author','acme-contributor']);f.rollback();
});
test('the same head request replays after a fresh observation without inserting or extending its lifetime',async t=>{
 const f=await fixture(t),id=randomUUID();f.begin();const first=await submit(f,await f.current(),id);f.commit();const expires=first.plan.expiresAt;
 f.begin();const replay=await submit(f,await f.current(),id);assert(replay.alreadyRecorded);assert.equal(replay.planSha256,first.planSha256);assert.equal(replay.plan.expiresAt,expires);assert.equal(f.db.prepare('SELECT count(*) AS n FROM cold_review_plans_v1').get().n,1);f.commit();
});
test('all actual prior authors remain in the signed contributor lineage after authorship changes',async t=>{
 const f=await fixture(t);f.begin();const first=await submit(f,await f.current());f.commit();
 f.begin();const second=await submit(f,await f.current({swap:true}),randomUUID(),first.planSha256);f.commit();assert.equal(second.plan.tenants[0].authorId,'acme-contributor');assert.deepEqual(second.plan.tenants[0].contributorIds,['acme-author','acme-contributor']);
 f.begin();const third=await submit(f,await f.current({extraAuthor:true}),randomUUID(),second.planSha256);assert.deepEqual(third.plan.tenants[0].contributorIds,['acme-author','acme-contributor','acme-later-author']);f.commit();
});
test('omitting any prior contributor rejects without changing the durable head',async t=>{
 const f=await fixture(t);f.begin();const first=await submit(f,await f.current());f.commit();
 f.begin();await assert.rejects(submit(f,await f.current({omit:true}),randomUUID(),first.planSha256),/COLD_PLAN_CONTRIBUTOR_OMITTED/);assert.equal(f.details.planJournal.body.headSha256,first.planSha256);assert.equal(f.db.prepare('SELECT count(*) AS n FROM cold_review_plans_v1').get().n,1);f.rollback();
});
test('a contributor or author cannot be an independently observed reviewer',async t=>{
 const f=await fixture(t);f.begin();await assert.rejects(submit(f,await f.current({reviewerIsContributor:true})),/COLD_ACTORS_INDEPENDENT_REVIEWER/);f.rollback();
});
test('stale parent, changed replay author, superseded UUID and changed workflow semantics reject',async t=>{
 const f=await fixture(t),id=randomUUID();f.begin();const first=await submit(f,await f.current(),id);f.commit();
 f.begin();await assert.rejects(submit(f,await f.current(),randomUUID(),null),/COLD_PLAN_HEAD_CAS/);await assert.rejects(submit(f,await f.current({swap:true}),id),/COLD_PLAN_REPLAY_PARTICIPANTS_OR_INPUTS_CHANGED/);await assert.rejects(submit(f,await f.current({workflowSeed:'changed'}),randomUUID(),first.planSha256),/COLD_PLAN_SEMANTICS_CHANGED/);f.rollback();
 f.begin();const second=await submit(f,await f.current(),randomUUID(),first.planSha256);f.commit();f.begin();await assert.rejects(submit(f,await f.current(),id),/COLD_PLAN_REPLAY_NOT_CURRENT/);assert.equal(f.details.planJournal.body.headSha256,second.planSha256);f.rollback();
});
test('rollback atomically removes first table creation and subsequent row/anchor changes',async t=>{
 const f=await fixture(t);f.begin();await submit(f,await f.current());f.rollback();f.reopen();f.begin();assert.deepEqual(await readColdPlanJournalV1(args(f)),{records:[],head:null,revision:0,headSha256:null});f.rollback();
 f.begin();const first=await submit(f,await f.current());f.commit();f.begin();await submit(f,await f.current({swap:true}),randomUUID(),first.planSha256);f.rollback();f.reopen();f.begin();const r=await readColdPlanJournalV1(args(f));assert.equal(r.revision,1);assert.equal(r.headSha256,first.planSha256);f.rollback();
});
test('a new actual process reopens and authenticates the committed SQLite lineage',async t=>{
 const f=await fixture(t);f.begin();const first=await submit(f,await f.current());f.commit();f.reopen();
 const result=await promisify(execFile)(process.execPath,['scripts/fixtures/cold-plan-journal-reopen-v1-qa.mjs',f.fixtureFile],{windowsHide:true,maxBuffer:1024**2});const value=JSON.parse(result.stdout);assert.equal(value.revision,1);assert.equal(value.headSha256,first.planSha256);assert.equal(value.liveAuthenticationPerformed,false);assert.equal(value.approvalGranted,false);
});
test('a fresh process verifies separate original control and observation directories within one case',async t=>{
 const f=await coldPlanJournalInputQaV1({nestedStore:true});t.after(()=>f.close());f.begin();const first=await submit(f,await f.current());f.commit();f.reopen();
 const input=join(dirname(f.storeFile),'reopen-v2.private.json');await privateNewFile(input,canonical({format:'COLD_PLAN_JOURNAL_REOPEN_INPUT_V2',context:f.context,credentials:f.credentials,storeFile:f.storeFile}));
 const result=await promisify(execFile)(process.execPath,['scripts/fixtures/cold-plan-journal-reopen-v2-qa.mjs',input],{windowsHide:true,maxBuffer:1024**2});const value=JSON.parse(result.stdout);assert.equal(value.revision,1);assert.equal(value.headSha256,first.planSha256);assert.equal(value.liveAuthenticationPerformed,false);
});
test('the process reader rejects observation path escape and a mismatching original trust store',async t=>{
 const f=await coldPlanJournalInputQaV1({nestedStore:true});t.after(()=>f.close());
 for(const kind of['escape','trust']){const context=structuredClone(f.context);if(kind==='escape')context.workDirectory=resolve(f.directory,'../outside-case');else context.trust.storeFile=join(f.directory,'wrong.sqlite');
  const input=join(dirname(f.storeFile),'reopen-invalid-'+kind+'.private.json');await privateNewFile(input,canonical({format:'COLD_PLAN_JOURNAL_REOPEN_INPUT_V2',context,credentials:f.credentials,storeFile:f.storeFile}));
  await assert.rejects(promisify(execFile)(process.execPath,['scripts/fixtures/cold-plan-journal-reopen-v2-qa.mjs',input],{windowsHide:true,maxBuffer:1024**2}),e=>e.code===1);
 }
});
test('altered row hashes, signatures and a foreign credential key reject',async t=>{
 const f=await fixture(t);f.begin();await submit(f,await f.current());f.commit();
 f.begin();const row=f.db.prepare('SELECT body FROM cold_review_plans_v1 WHERE revision=1').get(),body=JSON.parse(row.body);body.approvalGranted=true;const changed=canonical(body);f.db.prepare('UPDATE cold_review_plans_v1 SET body=?,body_sha256=? WHERE revision=1').run(changed,hash(changed));await assert.rejects(readColdPlanJournalV1(args(f)),/COLD_PLAN_SIGNATURE/);f.rollback();
 f.begin();const credentials={...f.credentials,key:randomBytes(32).toString('hex')},context={...f.context,credentialSha256:hash(credentials)};await assert.rejects(readColdPlanJournalV1({...args(f),credentials,context}),/COLD_PLAN_SIGNATURE/);f.rollback();
});
test('a signed lineage cannot be attached to another original source context',async t=>{
 const f=await fixture(t);f.begin();await submit(f,await f.current());f.commit();
 const source=structuredClone(f.context.source);source.fullFacts.sha256=hash('different-original-full-facts');const sourceHash=hash(source),credentials={...f.credentials,sourceHash},context={...f.context,source,trust:{...f.context.trust,sourceHash},credentialSha256:hash(credentials)};
 f.begin();await assert.rejects(readColdPlanJournalV1({...args(f),context,credentials}),/COLD_PLAN_ANCHOR_BINDING/);f.rollback();
});
test('deleted ancestry, an altered anchor and unregistered schema objects reject',async t=>{
 const f=await fixture(t);f.begin();const first=await submit(f,await f.current());f.commit();f.begin();await submit(f,await f.current({swap:true}),randomUUID(),first.planSha256);f.commit();
 f.begin();f.db.exec('DELETE FROM cold_review_plans_v1 WHERE revision=1');await assert.rejects(readColdPlanJournalV1(args(f)),/COLD_PLAN_LINEAGE_LIMIT/);f.rollback();
 f.begin();f.details.planJournal.body.headSha256='a'.repeat(64);await assert.rejects(readColdPlanJournalV1(args(f)),/COLD_PLAN_SIGNATURE/);f.rollback();
 f.begin();f.db.exec('CREATE TRIGGER unexpected_plan_trigger AFTER INSERT ON cold_review_plans_v1 BEGIN SELECT 1; END');await assert.rejects(readColdPlanJournalV1(args(f)),/COLD_PLAN_SCHEMA_CHANGED/);f.rollback();
});
test('changed original observation bytes and expired fresh evidence reject',async t=>{
 const f=await fixture(t),current=await f.current();f.begin();await submit(f,current);f.commit();await appendFile(current.observation.evidenceFile,' ');f.begin();await assert.rejects(readColdPlanJournalV1(args(f)),/COLD_PLAN_OBSERVATION_CHANGED/);f.rollback();
 const other=await fixture(t);other.begin();await assert.rejects(submit(other,await other.current({ageMs:60000})),/COLD_PLAN_OBSERVATION_EXPIRED/);other.rollback();
});
test('all64 revisions are verified and a65th plan rejects without truncation',async t=>{
 const f=await fixture(t),current=await f.current();let parent=null;
 for(let i=0;i<64;i++){f.begin();const row=await submit(f,current,randomUUID(),parent);parent=row.planSha256;f.commit();}
 f.begin();const journal=await readColdPlanJournalV1(args(f));assert.equal(journal.records.length,64);assert.equal(journal.headSha256,parent);await assert.rejects(submit(f,current,randomUUID(),parent),/COLD_PLAN_LINEAGE_LIMIT/);f.rollback();
});
test('persistence requires the existing transaction and forbids approval fields in a submission request',async t=>{
 const f=await fixture(t);await assert.rejects(readColdPlanJournalV1(args(f)),/COLD_PLAN_EXISTING_TRANSACTION_REQUIRED/);f.begin();await assert.rejects(submitColdPlanJournalV1({...args(f),current:await f.current(),request:{planId:randomUUID(),expectedHeadSha256:null,approved:true}}),/COLD_PLAN_REQUEST/);f.rollback();
});
test('the real coordinator rejects injected authorization and forged sessions before opening a store',async()=>{
 const {config}=coldReadonlyInputQaV3(),p=new RuntimeColdReadOnlyPreparationV11(config),raw={recoveryId,session:{},participants:[],planId:randomUUID(),expectedHeadSha256:null};
 assert.throws(()=>p.submitCurrentPlan(raw),/COLD_OWNED_SESSION_NOT_MINTED/);
 for(const extra of[{approved:true},{actorId:'caller'},{execute:()=>true},{expectedHeadSha256:'invalid'}])assert.throws(()=>p.submitCurrentPlan({...raw,...extra}),/COLD_PLAN_REQUEST/);
 assert.deepEqual(p.state(),{busy:false,closed:false,ownedSqlClients:0});await p.close();
});
test('reading a plan requires the original session and cannot accept current-identity or approval claims',async()=>{
 const {config}=coldReadonlyInputQaV3(),p=new RuntimeColdReadOnlyPreparationV11(config),raw={recoveryId,session:{}};
 assert.throws(()=>p.inspectCurrentPlan(raw),/COLD_OWNED_SESSION_NOT_MINTED/);
 for(const extra of[{approved:true},{currentOidcReviewerVerified:true},{participants:[]},{execute:()=>true}])assert.throws(()=>p.inspectCurrentPlan({...raw,...extra}),/COLD_PLAN_STATUS_REQUEST/);
 assert.deepEqual(p.state(),{busy:false,closed:false,ownedSqlClients:0});await p.close();
});
