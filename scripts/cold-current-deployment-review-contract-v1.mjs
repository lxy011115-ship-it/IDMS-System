import {DatabaseSync} from 'node:sqlite';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {dirname,isAbsolute,resolve} from 'node:path';
import {canonical} from '../server/imports.ts';
import {coldRegistrationSourceInventoryV2} from './cold-registration-source-inventory-v2.mjs';
import {validateColdFieldSourceV1} from './cold-field-source-v1.mjs';
import {createColdReviewCredentialsV3,validateColdReviewCredentialsV3} from './runtime-cold-review-credentials-v3.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

export const currentDeploymentReviewPurposeV1='CURRENT_DEPLOYMENT_DIAGNOSTIC_REVIEW_V1';
const purpose=currentDeploymentReviewPurposeV1,initializations=new WeakMap();
const table='cold_current_deployment_review_intents_v1';
const schema='CREATE TABLE cold_current_deployment_review_intents_v1(id INTEGER PRIMARY KEY CHECK(id=1),review_id TEXT NOT NULL UNIQUE,operation_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,body_sha256 TEXT NOT NULL UNIQUE,signature TEXT NOT NULL)';
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const absolute=v=>typeof v==='string'&&v.length<=4096&&isAbsolute(v)&&resolve(v)===v&&!/[\u0000-\u001f\u007f]/.test(v);
const normalPath=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
const same=(a,b)=>canonical(a)===canonical(b);
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const contextKeys=['trust','source','originalReview','targetDirectory','host','port','deploymentSha256','programInventorySha256'];
const intentKeys=['format','purpose','controlId','sourceHash','sourceFullFactsSha256','sourceInventorySha256','originalReviewId','originalIntentSha256','originalResultSha256','reviewId','operationId','targetDirectory','host','port','deploymentSha256','programInventorySha256','readerCredentialsSha256','journalKeySha256','createdAt','expiresAt','programStartupGranted','mqttApplicationProbeGranted','businessWritesEnabled','formalFieldActivationGranted'];

/** Historical binding only. Live SQL, identity, ownership and approval remain coordinator work. */
function contextBinding(context){
  need(exact(context,contextKeys),'CURRENT_DEPLOYMENT_CONTEXT');const {trust,source,originalReview:old}=context;
  need(exact(trust,['format','controlId','sourceHash','storeFile'])&&trust.format==='RUNTIME_COLD_REVIEW_TRUST_V3'&&uuid(trust.controlId)&&hex(trust.sourceHash)&&absolute(trust.storeFile)&&source?.controlId===trust.controlId&&hash(source)===trust.sourceHash,'CURRENT_DEPLOYMENT_SOURCE_BINDING');
  const inventory=coldRegistrationSourceInventoryV2(source,{sourceHash:trust.sourceHash,controlDirectory:dirname(trust.storeFile)});validateColdFieldSourceV1(source,source.fieldSource,dirname(trust.storeFile));
  need(old?.format==='COLD_READONLY_REVIEW_INTENT_V3'&&old.controlId===trust.controlId&&old.sourceHash===trust.sourceHash&&uuid(old.recoveryId)&&hex(old.credentialSha256)&&old.businessAdmissionGranted===false&&old.result?.format==='COLD_READONLY_REVIEW_RESULT_V3'&&old.result.recoveryId===old.recoveryId&&old.result.credentialSha256===old.credentialSha256&&old.result.businessAdmissionGranted===false&&old.result.fullFactsCheck?.sourceFullFactsSha256===source.fullFacts.sha256,'CURRENT_DEPLOYMENT_ORIGINAL_REVIEW');
  need(absolute(context.targetDirectory)&&normalPath(context.targetDirectory)!==normalPath(source.inventory.identity.directory)&&context.host==='127.0.0.1'&&Number.isInteger(context.port)&&context.port>1024&&context.port<=65535&&hex(context.deploymentSha256)&&hex(context.programInventorySha256),'CURRENT_DEPLOYMENT_FIXED_CONFIGURATION');
  return{controlId:trust.controlId,sourceHash:trust.sourceHash,sourceFullFactsSha256:source.fullFacts.sha256,sourceInventorySha256:inventory.sha256,originalReviewId:old.recoveryId,originalIntentSha256:hash(old),originalResultSha256:hash(old.result),targetDirectory:context.targetDirectory,host:context.host,port:context.port,deploymentSha256:context.deploymentSha256,programInventorySha256:context.programInventorySha256};
}
function signature(privateRecord,domain,body){
  need(hex(privateRecord.journalKey),'CURRENT_DEPLOYMENT_PRIVATE_KEY');const key=Buffer.from(privateRecord.journalKey,'hex');
  try{return createHmac('sha256',key).update('IDMS_CURRENT_DEPLOYMENT_REVIEW_CONTRACT_V1\n'+domain+'\n'+canonical(body)).digest('hex');}finally{key.fill(0);}
}
function authenticated(privateRecord,domain,body,value){need(hex(value)&&timingSafeEqual(Buffer.from(signature(privateRecord,domain,body),'hex'),Buffer.from(value,'hex')),'CURRENT_DEPLOYMENT_SIGNATURE');}
function validTime(body){const from=Date.parse(body.createdAt),until=Date.parse(body.expiresAt);need(Number.isSafeInteger(from)&&Number.isSafeInteger(until)&&new Date(from).toISOString()===body.createdAt&&new Date(until).toISOString()===body.expiresAt&&until===from+1800000,'CURRENT_DEPLOYMENT_TIME');return{from,until};}

/**
 * Data-only private contract plus a one-use STORAGE initializer. Neither value
 * authorizes a HELD session, SQL, MQTT CONNECT, program launch or business writes.
 */
export function createColdCurrentDeploymentReviewContractV1(context,request){
  const binding=contextBinding(context);
  need(exact(request,['purpose','reviewId','operationId','expectedSourceHash','expectedOriginalIntentSha256','expectedOriginalResultSha256','expectedDeploymentSha256','expectedProgramInventorySha256'])&&request.purpose===purpose&&uuid(request.reviewId)&&uuid(request.operationId)&&request.reviewId!==binding.originalReviewId,'CURRENT_DEPLOYMENT_REQUEST');
  for(const [key,expected]of Object.entries({expectedSourceHash:binding.sourceHash,expectedOriginalIntentSha256:binding.originalIntentSha256,expectedOriginalResultSha256:binding.originalResultSha256,expectedDeploymentSha256:binding.deploymentSha256,expectedProgramInventorySha256:binding.programInventorySha256}))need(request[key]===expected,'CURRENT_DEPLOYMENT_EXPECTED_BINDING');
  const readerCredentials=createColdReviewCredentialsV3(context.source,context.trust,{recoveryId:request.reviewId,host:context.host,port:context.port}),bytes=randomBytes(32),journalKey=bytes.toString('hex');bytes.fill(0);
  need(journalKey!==readerCredentials.key&&!/^0+$/.test(journalKey),'CURRENT_DEPLOYMENT_PRIVATE_KEY');const now=Date.now(),body={format:'COLD_CURRENT_DEPLOYMENT_REVIEW_INTENT_V1',purpose,...binding,reviewId:request.reviewId,operationId:request.operationId,readerCredentialsSha256:hash(readerCredentials),journalKeySha256:hash(Buffer.from(journalKey,'hex')),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString(),programStartupGranted:false,mqttApplicationProbeGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false};
  const privateRecord={format:'COLD_CURRENT_DEPLOYMENT_REVIEW_PRIVATE_V1',purpose,intent:{body,sha256:hash(body),signature:''},readerCredentials,journalKey};privateRecord.intent.signature=signature(privateRecord,'INTENT',body);
  const initialization=Object.freeze({});initializations.set(initialization,{context:structuredClone(context),privateRecord:structuredClone(privateRecord),used:false,closed:false});
  return{privateRecord,initialization};
}

/** Historical authentication of a PRIVATE record. No current runtime authority is inferred. */
export function validateColdCurrentDeploymentReviewContractV1(raw,context,expectedIntentSha256){
  const binding=contextBinding(context);need(hex(expectedIntentSha256)&&exact(raw,['format','purpose','intent','readerCredentials','journalKey'])&&raw.format==='COLD_CURRENT_DEPLOYMENT_REVIEW_PRIVATE_V1'&&raw.purpose===purpose&&hex(raw.journalKey)&&!/^0+$/.test(raw.journalKey)&&exact(raw.intent,['body','sha256','signature']),'CURRENT_DEPLOYMENT_PRIVATE_CONTRACT');
  const body=raw.intent.body;need(exact(body,intentKeys)&&body.format==='COLD_CURRENT_DEPLOYMENT_REVIEW_INTENT_V1'&&body.purpose===purpose&&Object.entries(binding).every(([key,value])=>body[key]===value)&&uuid(body.reviewId)&&uuid(body.operationId)&&body.reviewId!==binding.originalReviewId&&body.programStartupGranted===false&&body.mqttApplicationProbeGranted===false&&body.businessWritesEnabled===false&&body.formalFieldActivationGranted===false,'CURRENT_DEPLOYMENT_INTENT_BINDING');
  need(raw.intent.sha256===expectedIntentSha256&&hash(body)===expectedIntentSha256&&body.journalKeySha256===hash(Buffer.from(raw.journalKey,'hex')),'CURRENT_DEPLOYMENT_INTENT_HASH');
  const readers=validateColdReviewCredentialsV3(raw.readerCredentials,context.source,context.trust,body.reviewId);need(hash(readers)===body.readerCredentialsSha256&&raw.journalKey!==readers.key,'CURRENT_DEPLOYMENT_READER_BINDING');validTime(body);authenticated(raw,'INTENT',body,raw.intent.signature);return structuredClone(raw);
}

/** Freshness is separate from historical authentication, and grants no I/O capability. */
export function assertFreshColdCurrentDeploymentReviewIntentV1(raw,context,expectedIntentSha256){
  const value=validateColdCurrentDeploymentReviewContractV1(raw,context,expectedIntentSha256),{from,until}=validTime(value.intent.body),now=Date.now();need(now>=from&&now<until,'CURRENT_DEPLOYMENT_INTENT_EXPIRED');return structuredClone(value.intent.body);
}
function transaction(db){need(db instanceof DatabaseSync&&db.isOpen&&db.isTransaction===true,'CURRENT_DEPLOYMENT_ORIGINAL_TRANSACTION_REQUIRED');}
function originalDetails(details,binding){need(details&&Object.getPrototypeOf(details)===Object.prototype&&hash(details.review)===binding.originalIntentSha256,'CURRENT_DEPLOYMENT_ORIGINAL_INTENT_CHANGED');}
function schemaPresent(db){
  const objects=db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY name').all(table);if(!objects.length)return false;
  need(objects.length===4&&objects.some(row=>row.type==='table'&&row.name===table&&row.sql===schema)&&[1,2,3].every(index=>objects.some(row=>row.type==='index'&&row.name==='sqlite_autoindex_'+table+'_'+index&&row.sql===null)),'CURRENT_DEPLOYMENT_JOURNAL_SCHEMA');return true;
}
function anchorBody(record){const b=record.intent.body;return{format:'COLD_CURRENT_DEPLOYMENT_REVIEW_ANCHOR_V1',purpose,controlId:b.controlId,sourceHash:b.sourceHash,reviewId:b.reviewId,operationId:b.operationId,intentSha256:record.intent.sha256,readerCredentialsSha256:b.readerCredentialsSha256};}

/** Existing records are REQUIRED. Missing row + missing anchor is never a virgin read. */
export function readColdCurrentDeploymentReviewIntentV1(raw){
  need(exact(raw,['db','details','context','privateRecord','expectedIntentSha256']),'CURRENT_DEPLOYMENT_READ_REQUEST');transaction(raw.db);const record=validateColdCurrentDeploymentReviewContractV1(raw.privateRecord,raw.context,raw.expectedIntentSha256),body=record.intent.body;originalDetails(raw.details,body);
  need(schemaPresent(raw.db)&&exact(raw.details.currentDeploymentReview,['body','signature']),'CURRENT_DEPLOYMENT_RECORDED_INTENT_REQUIRED');const anchor=raw.details.currentDeploymentReview;need(same(anchor.body,anchorBody(record)),'CURRENT_DEPLOYMENT_ANCHOR_BINDING');authenticated(record,'ANCHOR',anchor.body,anchor.signature);
  const rows=raw.db.prepare('SELECT id,review_id,operation_id,body,body_sha256,signature FROM cold_current_deployment_review_intents_v1 ORDER BY id').all();need(rows.length===1,'CURRENT_DEPLOYMENT_INTENT_ROWS');const row=rows[0];need(row.id===1&&row.review_id===body.reviewId&&row.operation_id===body.operationId&&row.body===canonical(body)&&row.body_sha256===record.intent.sha256,'CURRENT_DEPLOYMENT_RECORDED_INTENT_CHANGED');authenticated(record,'JOURNAL_ROW',body,row.signature);
  return{intent:structuredClone(body),intentSha256:record.intent.sha256,recorded:true,historicalDataOnly:true,ownedRuntimeSessionMinted:false,programStartupGranted:false,mqttApplicationProbeGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false};
}

/**
 * Only the fresh in-process storage initializer may create this separate record.
 * It is consumed before mutation. A failed/unknown write can subsequently be
 * authenticated by read, but missing storage cannot be silently recreated.
 * The original coordinator alone commits this row with its sibling anchor.
 */
export function initializeColdCurrentDeploymentReviewIntentV1(raw){
  need(exact(raw,['db','details','initialization']),'CURRENT_DEPLOYMENT_INITIALIZE_REQUEST');const owner=initializations.get(raw.initialization);need(owner&&!owner.closed,'CURRENT_DEPLOYMENT_INITIALIZER_NOT_MINTED');transaction(raw.db);const record=owner.privateRecord,body=record.intent.body;originalDetails(raw.details,body);
  if(owner.used)return{...readColdCurrentDeploymentReviewIntentV1({db:raw.db,details:raw.details,context:owner.context,privateRecord:record,expectedIntentSha256:record.intent.sha256}),alreadyRecorded:true};
  assertFreshColdCurrentDeploymentReviewIntentV1(record,owner.context,record.intent.sha256);need(!schemaPresent(raw.db)&&!Object.hasOwn(raw.details,'currentDeploymentReview'),'CURRENT_DEPLOYMENT_INITIAL_STORE_NOT_EMPTY');owner.used=true;
  raw.db.exec(schema);raw.db.prepare('INSERT INTO cold_current_deployment_review_intents_v1(id,review_id,operation_id,body,body_sha256,signature) VALUES(1,?,?,?,?,?)').run(body.reviewId,body.operationId,canonical(body),record.intent.sha256,signature(record,'JOURNAL_ROW',body));const anchor=anchorBody(record);raw.details.currentDeploymentReview={body:anchor,signature:signature(record,'ANCHOR',anchor)};
  return{...readColdCurrentDeploymentReviewIntentV1({db:raw.db,details:raw.details,context:owner.context,privateRecord:record,expectedIntentSha256:record.intent.sha256}),alreadyRecorded:false};
}

export function closeColdCurrentDeploymentReviewInitializationV1(handle){
  const owner=initializations.get(handle);need(owner,'CURRENT_DEPLOYMENT_INITIALIZER_NOT_MINTED');if(owner.closed)return;owner.closed=true;owner.privateRecord.journalKey='';for(const reader of owner.privateRecord.readerCredentials.readers){reader.password='';reader.token='';}owner.context=null;owner.privateRecord=null;
}
