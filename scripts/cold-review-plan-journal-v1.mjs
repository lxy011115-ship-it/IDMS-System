import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute,dirname,basename} from 'node:path';
import {canonical} from '../server/imports.ts';
import {assertColdActorIndependenceV1} from './cold-current-actors-v2.mjs';
import {assertColdReviewInputsV1} from './cold-review-inputs-v1.mjs';
import {reviewSourceNeedV1 as need,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

const table='cold_review_plans_v1';
const schema='CREATE TABLE cold_review_plans_v1(revision INTEGER PRIMARY KEY,plan_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,body_sha256 TEXT NOT NULL UNIQUE,signature TEXT NOT NULL)';
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f]/.test(v),same=(a,b)=>canonical(a)===canonical(b),sorted=v=>[...v].sort();
const recordKeys=['format','controlId','sourceHash','sourceFullFactsSha256','recoveryId','intentSha256','credentialSha256','planId','revision','parentSha256','createdAt','expiresAt','purpose','tenants','observation','contributorsProvenance','approvalGranted','formalFieldActivationGranted'];
const tenantKeys=['tenantId','authorId','contributorIds','observedIndependentReviewerId','externalConfigSha256','sourceMapFactsSha256','sourcePayloadSha256','reviewInputsSha256','publishedPoliciesSha256','workflowSnapshotSha256'];
function binding(context,credentials){
 need(context?.trust?.format==='RUNTIME_COLD_REVIEW_TRUST_V3'&&context.source?.format==='RUNTIME_COLD_REVIEW_SOURCE_V3'&&hash(context.source)===context.trust.sourceHash&&context.source.controlId===context.trust.controlId&&uuid(context.recoveryId)&&hex(context.intentSha256)&&hex(context.credentialSha256)&&isAbsolute(context.workDirectory),'COLD_PLAN_CONTEXT');
 need(credentials?.format==='COLD_REVIEW_READERS_PRIVATE_V3'&&credentials.controlId===context.trust.controlId&&credentials.sourceHash===context.trust.sourceHash&&credentials.recoveryId===context.recoveryId&&hex(credentials.key)&&hash(credentials)===context.credentialSha256,'COLD_PLAN_CREDENTIAL_BINDING');
 return{controlId:context.trust.controlId,sourceHash:context.trust.sourceHash,sourceFullFactsSha256:context.source.fullFacts.sha256,recoveryId:context.recoveryId,intentSha256:context.intentSha256,credentialSha256:context.credentialSha256};
}
function signature(credentials,purpose,body){
 const key=createHmac('sha256',Buffer.from(credentials.key,'hex')).update('IDMS_COLD_REVIEW_PLAN_JOURNAL_V1\n').digest();
 try{return createHmac('sha256',key).update(purpose+'\n'+canonical(body)).digest('hex');}finally{key.fill(0);}
}
function authenticate(credentials,purpose,body,sig){need(hex(sig)&&timingSafeEqual(Buffer.from(signature(credentials,purpose,body),'hex'),Buffer.from(sig,'hex')),'COLD_PLAN_SIGNATURE');}
function schemaState(db){
 const objects=db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY name').all(table);
 if(!objects.length)return false;
 need(objects.length===3&&objects.some(o=>o.type==='table'&&o.name===table&&o.sql===schema)&&[1,2].every(n=>objects.some(o=>o.type==='index'&&o.name==='sqlite_autoindex_'+table+'_'+n&&o.sql===null)),'COLD_PLAN_SCHEMA_CHANGED');return true;
}
function observationBinding(o,context,fresh){
 const {evidenceFile,sha256,...body}=o??{},b=binding(context,context.credentials);
 need(o?.format==='COLD_CURRENT_ACTORS_OBSERVATION_V1'&&hex(sha256)&&hash(body)===sha256&&Object.entries(b).filter(([k])=>k!=='credentialSha256').every(([k,v])=>o[k]===v),'COLD_PLAN_OBSERVATION_BINDING');
 need(typeof evidenceFile==='string'&&isAbsolute(evidenceFile)&&dirname(evidenceFile)===context.workDirectory&&/^actors-observation-[a-f0-9-]{36}\.private\.json$/.test(basename(evidenceFile)),'COLD_PLAN_OBSERVATION_PATH');
 const from=Date.parse(o.capturedFrom),at=Date.parse(o.capturedAt),until=Date.parse(o.expiresAt);
 need(Number.isFinite(from)&&Number.isFinite(at)&&Number.isFinite(until)&&from<=at&&at-from<=30000&&at<until&&until<=at+30000&&(!fresh||Date.now()<until&&at<=Date.now()+5000),'COLD_PLAN_OBSERVATION_EXPIRED');
 need(o.currentOidcReviewerVerified&&o.independentReviewersVerified&&o.declaredContributorsCurrentVerified&&!o.durablePlanContributorsVerified&&!o.approvalGranted&&!o.formalFieldActivationGranted&&!o.fullGoalComplete&&!o.externalWorkflowHttpUsed&&o.workflowReadTransport==='ORIGINAL_OWNED_READER'&&Array.isArray(o.workflowCaptures)&&o.workflowCaptures.length===2,'COLD_PLAN_OBSERVATION_AUTHORITY');
 const tenants=context.source.fullFacts.databases.filter(d=>d.map).map(d=>d.map.tenantId);
 need(Array.isArray(o.actors)&&o.actors.length>0&&o.actors.length<=32&&same(sorted(o.actors.map(a=>a.tenantId)),sorted(tenants))&&new Set(tenants).size===tenants.length&&o.beforeActorsSha256===hash(o.actors)&&o.afterActorsSha256===hash(o.actors),'COLD_PLAN_TENANT_INVENTORY');
 let people=0;for(const row of o.actors){assertColdActorIndependenceV1(row);people+=2+row.contributors.length;need(people<=64&&row.contributors.length<=16,'COLD_PLAN_PARTICIPANT_LIMIT');need(hex(row.externalConfigSha256),'COLD_PLAN_EXTERNAL_CONFIG');}
 return o;
}
async function evidence(ref,context,fresh=false,expected=null){
 need(exact(ref,['evidenceFile','sha256','capturedAt','expiresAt']),'COLD_PLAN_OBSERVATION_REFERENCE');
 const path=ref.evidenceFile;need(typeof path==='string'&&isAbsolute(path)&&dirname(path)===context.workDirectory&&/^actors-observation-[a-f0-9-]{36}\.private\.json$/.test(basename(path)),'COLD_PLAN_OBSERVATION_PATH');
 const before=await lstat(path);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=16*1024**2,'COLD_PLAN_OBSERVATION_FILE');
 const bytes=await readFile(path),stored=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));need(canonical(stored)===bytes.toString('utf8')&&stored.sha256===ref.sha256&&stored.capturedAt===ref.capturedAt&&stored.expiresAt===ref.expiresAt,'COLD_PLAN_OBSERVATION_CHANGED');
 const o=observationBinding({...stored,evidenceFile:path},context,fresh);if(expected)need(same(o,expected),'COLD_PLAN_OBSERVATION_CHANGED');
 const after=await lstat(path);need(after.isFile()&&!after.isSymbolicLink()&&after.nlink===1&&after.dev===before.dev&&after.ino===before.ino&&after.size===before.size&&hash(await readFile(path))===hash(bytes),'COLD_PLAN_OBSERVATION_CHANGED');return o;
}
function tenantPeople(o){return o.actors.map(row=>({tenantId:row.tenantId,authorId:row.author.actorId,contributorIds:sorted([row.author.actorId,...row.contributors.map(a=>a.actorId)]),observedIndependentReviewerId:row.reviewer.actorId,externalConfigSha256:row.externalConfigSha256})).sort((a,b)=>a.tenantId.localeCompare(b.tenantId));}
function lineage(tenants,prior){
 need(tenants.length>0&&tenants.length<=32&&same(tenants.map(t=>t.tenantId),sorted(tenants.map(t=>t.tenantId))),'COLD_PLAN_TENANT_INVENTORY');
 for(const t of tenants){need(text(t.tenantId)&&text(t.authorId)&&text(t.observedIndependentReviewerId)&&Array.isArray(t.contributorIds)&&t.contributorIds.length>0&&t.contributorIds.length<=17&&t.contributorIds.every(text)&&same(t.contributorIds,sorted([...new Set(t.contributorIds)]))&&t.contributorIds.includes(t.authorId)&&!t.contributorIds.includes(t.observedIndependentReviewerId),'COLD_PLAN_INDEPENDENCE');
  if(prior){const before=prior.find(p=>p.tenantId===t.tenantId);need(before&&before.contributorIds.every(id=>t.contributorIds.includes(id)),'COLD_PLAN_CONTRIBUTOR_OMITTED');}
 }
}
function semantics(context,current){
 const {observation:o,fullFactsCheck:f,reviewConsistency:c}=current;
 need(f?.sourceFullFactsSha256===context.source.fullFacts.sha256&&o.fullFactsCheckSha256===hash(f)&&c?.workflowOrderInventoryVerified&&o.reviewConsistencySha256===c.sha256&&c.sourceHash===context.trust.sourceHash&&c.recoveryId===context.recoveryId&&c.intentSha256===context.intentSha256,'COLD_PLAN_CURRENT_FACTS');
 const people=tenantPeople(o),maps=context.source.fullFacts.databases.filter(d=>d.map);
 need(f.maps.length===maps.length&&c.tenants.length===maps.length,'COLD_PLAN_TENANT_INVENTORY');
 return people.map(p=>{const original=maps.find(d=>d.map.tenantId===p.tenantId).map,m=f.maps.find(m=>m.tenantId===p.tenantId),w=c.tenants.find(t=>t.tenantId===p.tenantId);need(m&&w,'COLD_PLAN_CURRENT_FACTS');
  assertColdReviewInputsV1(m.reviewInputs,{tenantId:p.tenantId,sourceFullFactsSha256:context.source.fullFacts.sha256,sourceMapFactsSha256:original.facts.factsSha256,payloadSha256:original.facts.payloadSha256});
  need(w.reviewInputsSha256===m.reviewInputs.sha256&&o.workflowCaptures.every(capture=>capture.sourceHash===context.trust.sourceHash&&capture.recoveryId===context.recoveryId&&capture.intentSha256===context.intentSha256&&capture.readerLeaseId===o.readerLeaseId&&capture.tenants.find(t=>t.tenantId===p.tenantId)?.snapshotSha256===w.workflowSnapshotSha256),'COLD_PLAN_CURRENT_FACTS');
  return{...p,sourceMapFactsSha256:original.facts.factsSha256,sourcePayloadSha256:original.facts.payloadSha256,reviewInputsSha256:m.reviewInputs.sha256,publishedPoliciesSha256:hash(m.reviewInputs.policies),workflowSnapshotSha256:w.workflowSnapshotSha256};
 });
}

/** Persistence contract only. The original preparer owns live authentication and its SQLite transaction. */
export async function readColdPlanJournalV1({db,details,context,credentials}){
 need(db?.isTransaction===true,'COLD_PLAN_EXISTING_TRANSACTION_REQUIRED');const b=binding(context,credentials),ctx={...context,credentials},present=schemaState(db),anchor=details.planJournal;
 if(!present&&!anchor)return{records:[],head:null,revision:0,headSha256:null};
 need(present&&exact(anchor,['body','signature']),'COLD_PLAN_ANCHOR_MISSING');authenticate(credentials,'ANCHOR',anchor.body,anchor.signature);
 need(exact(anchor.body,['format',...Object.keys(b),'revision','headSha256'])&&anchor.body.format==='COLD_REVIEW_PLAN_ANCHOR_V1'&&Object.entries(b).every(([k,v])=>anchor.body[k]===v),'COLD_PLAN_ANCHOR_BINDING');
 const rows=db.prepare('SELECT revision,plan_id,body,body_sha256,signature FROM cold_review_plans_v1 ORDER BY revision').all();need(rows.length>0&&rows.length<=64&&rows.length===anchor.body.revision,'COLD_PLAN_LINEAGE_LIMIT');
 const records=[];let prior=null;
 for(const row of rows){need(typeof row.body==='string'&&Buffer.byteLength(row.body)<=128*1024&&hex(row.body_sha256)&&hash(row.body)===row.body_sha256,'COLD_PLAN_RECORD_CHANGED');const body=JSON.parse(row.body);need(canonical(body)===row.body,'COLD_PLAN_RECORD_CHANGED');authenticate(credentials,'PLAN',body,row.signature);
  need(exact(body,recordKeys)&&body.format==='COLD_REVIEW_PLAN_SUBMISSION_V1'&&Object.entries(b).every(([k,v])=>body[k]===v)&&uuid(body.planId)&&body.planId===row.plan_id&&body.revision===row.revision&&body.revision===records.length+1&&body.parentSha256===(prior?.sha256??null)&&body.purpose==='RESTORE_ORIGINAL_SYSTEM_READ_ONLY_SUBMISSION'&&body.contributorsProvenance==='AUTHENTICATED_SUBMISSION_LINEAGE_AND_DECLARED_COAUTHORS'&&body.approvalGranted===false&&body.formalFieldActivationGranted===false,'COLD_PLAN_LINEAGE_CHANGED');
  const at=Date.parse(body.createdAt),until=Date.parse(body.expiresAt);need(Number.isFinite(at)&&until===at+1800000&&at>=Date.parse(body.observation?.capturedAt)&&at<Date.parse(body.observation?.expiresAt)&&(!prior||at>=Date.parse(prior.body.createdAt)),'COLD_PLAN_TIMESTAMP');
  const original=await evidence(body.observation,ctx);need(same(body.tenants.map(({tenantId,authorId,contributorIds,observedIndependentReviewerId,externalConfigSha256})=>({tenantId,authorId,contributorIds,observedIndependentReviewerId,externalConfigSha256})),tenantPeople(original)),'COLD_PLAN_PARTICIPANTS_CHANGED');
  lineage(body.tenants,prior?.body.tenants);for(const t of body.tenants){const original=context.source.fullFacts.databases.find(d=>d.map?.tenantId===t.tenantId)?.map;need(exact(t,tenantKeys)&&original&&t.sourceMapFactsSha256===original.facts.factsSha256&&t.sourcePayloadSha256===original.facts.payloadSha256&&['reviewInputsSha256','publishedPoliciesSha256','workflowSnapshotSha256','externalConfigSha256'].every(k=>hex(t[k])),'COLD_PLAN_SEMANTICS_CHANGED');if(prior){const old=prior.body.tenants.find(p=>p.tenantId===t.tenantId);for(const k of['sourceMapFactsSha256','sourcePayloadSha256','reviewInputsSha256','publishedPoliciesSha256','workflowSnapshotSha256','externalConfigSha256'])need(t[k]===old[k],'COLD_PLAN_SEMANTICS_CHANGED');}}
  const record={body,sha256:row.body_sha256};records.push(record);prior=record;
 }
 need(anchor.body.headSha256===prior.sha256,'COLD_PLAN_HEAD_CHANGED');return{records,head:prior.body,revision:records.length,headSha256:prior.sha256};
}

/** No COMMIT here: the original coordinator atomically commits the row and signed sibling anchor. */
export async function submitColdPlanJournalV1({db,details,context,credentials,request,current}){
 need(exact(request,['planId','expectedHeadSha256'])&&uuid(request.planId)&&(request.expectedHeadSha256===null||hex(request.expectedHeadSha256)),'COLD_PLAN_REQUEST');
 const b=binding(context,credentials),ctx={...context,credentials},o=current?.observation;observationBinding(o,ctx,true);
 const ref={evidenceFile:o.evidenceFile,sha256:o.sha256,capturedAt:o.capturedAt,expiresAt:o.expiresAt};await evidence(ref,ctx,true,o);
 const journal=await readColdPlanJournalV1({db,details,context,credentials}),tenants=semantics(context,current);lineage(tenants,journal.head?.tenants);
 if(journal.head)for(const t of tenants){const before=journal.head.tenants.find(p=>p.tenantId===t.tenantId);for(const k of['sourceMapFactsSha256','sourcePayloadSha256','reviewInputsSha256','publishedPoliciesSha256','workflowSnapshotSha256','externalConfigSha256'])need(t[k]===before[k],'COLD_PLAN_SEMANTICS_CHANGED');}
 need(Date.now()<Date.parse(o.expiresAt),'COLD_PLAN_OBSERVATION_EXPIRED');const duplicate=journal.records.find(r=>r.body.planId===request.planId);
 if(duplicate){need(duplicate.sha256===journal.headSha256&&request.expectedHeadSha256===duplicate.body.parentSha256,'COLD_PLAN_REPLAY_NOT_CURRENT');need(Date.now()<Date.parse(duplicate.body.expiresAt),'COLD_PLAN_EXPIRED');need(same(tenants,duplicate.body.tenants),'COLD_PLAN_REPLAY_PARTICIPANTS_OR_INPUTS_CHANGED');return{plan:duplicate.body,planSha256:duplicate.sha256,revision:journal.revision,alreadyRecorded:true,currentObservationSha256:o.sha256};}
 need(request.expectedHeadSha256===journal.headSha256,'COLD_PLAN_HEAD_CAS');need(journal.revision<64,'COLD_PLAN_LINEAGE_LIMIT');
 const createdAt=new Date().toISOString(),body={format:'COLD_REVIEW_PLAN_SUBMISSION_V1',...b,planId:request.planId,revision:journal.revision+1,parentSha256:journal.headSha256,createdAt,expiresAt:new Date(Date.parse(createdAt)+1800000).toISOString(),purpose:'RESTORE_ORIGINAL_SYSTEM_READ_ONLY_SUBMISSION',tenants,observation:ref,contributorsProvenance:'AUTHENTICATED_SUBMISSION_LINEAGE_AND_DECLARED_COAUTHORS',approvalGranted:false,formalFieldActivationGranted:false},bytes=canonical(body);need(Buffer.byteLength(bytes)<=128*1024,'COLD_PLAN_RECORD_LIMIT');
 if(!journal.revision)db.exec(schema);
 const planSha256=hash(bytes);db.prepare('INSERT INTO cold_review_plans_v1(revision,plan_id,body,body_sha256,signature) VALUES(?,?,?,?,?)').run(body.revision,body.planId,bytes,planSha256,signature(credentials,'PLAN',body));
 const anchor={format:'COLD_REVIEW_PLAN_ANCHOR_V1',...b,revision:body.revision,headSha256:planSha256};details.planJournal={body:anchor,signature:signature(credentials,'ANCHOR',anchor)};
 return{plan:body,planSha256,revision:body.revision,alreadyRecorded:false,currentObservationSha256:o.sha256};
}
