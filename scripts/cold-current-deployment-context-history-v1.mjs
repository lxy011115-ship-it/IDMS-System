import {DatabaseSync} from 'node:sqlite';
import {canonical} from '../server/imports.ts';
import {readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {inspectColdCurrentDeploymentContextFileV1,recordColdCurrentDeploymentContextFileV1,revalidateColdCurrentDeploymentContextFileV1} from './cold-current-deployment-review-context-files-v5.mjs';
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const same=(a,b)=>canonical(a)===canonical(b);
/** Authenticated private history. No initializer, deadline refresh or live runtime capability is created. */
export async function readColdCurrentDeploymentContextHistoryPrivateV1(fileOwner,raw){
  need(raw&&Object.keys(raw).sort().join(',')==='db,details'&&raw.db instanceof DatabaseSync&&raw.db.isOpen&&raw.db.isTransaction,'CURRENT_DEPLOYMENT_HISTORY_TRANSACTION');
  const before=inspectColdCurrentDeploymentContextFileV1(fileOwner);need(before.recordAuthenticated,'CURRENT_DEPLOYMENT_HISTORY_RECORDED_OWNER_REQUIRED');
  const authenticated=await recordColdCurrentDeploymentContextFileV1(fileOwner,raw);need(authenticated.alreadyRecorded,'CURRENT_DEPLOYMENT_HISTORY_EXISTING_REQUIRED');
  const anchor=raw.details.currentDeploymentReviewContextFile,part=anchor.body.file,loaded=await readApplicationFileV1(part.file);let record;
  try{
    need(loaded.path===part.file&&loaded.sha256===part.sha256,'CURRENT_DEPLOYMENT_HISTORY_FILE');record=JSON.parse(loaded.bytes.toString('utf8'));need(canonical(record)===loaded.bytes.toString('utf8')&&record.intent.sha256===before.intentSha256&&record.intent.body.reviewId===before.reviewId&&record.intent.body.operationId===before.operationId,'CURRENT_DEPLOYMENT_HISTORY_CONTEXT');
    const row=raw.db.prepare('SELECT control_id,body,body_hash,phase,details,details_hash FROM cold_control WHERE id=1').get();need(row&&row.control_id===record.intent.body.controlId&&row.body_hash===record.intent.body.sourceHash&&hash(row.body)===row.body_hash&&row.phase==='REVIEW_READY_V3'&&hash(row.details)===row.details_hash,'CURRENT_DEPLOYMENT_HISTORY_SOURCE');
    const source=JSON.parse(row.body),saved=JSON.parse(row.details);need(canonical(source)===row.body&&same(saved.currentDeploymentReviewContextFile,anchor)&&same(saved.currentDeploymentReview,raw.details.currentDeploymentReview)&&hash(raw.details.review)===record.intent.body.originalIntentSha256,'CURRENT_DEPLOYMENT_HISTORY_ANCHORS');
    await revalidateColdCurrentDeploymentContextFileV1(fileOwner);const after=inspectColdCurrentDeploymentContextFileV1(fileOwner);need(after.recordAuthenticated&&after.intentSha256===before.intentSha256&&after.expiresAt===before.expiresAt,'CURRENT_DEPLOYMENT_HISTORY_OWNER_CHANGED');
    return{privateRecord:record,source,originalReview:structuredClone(raw.details.review),historicalDataOnly:true,currentAuthorizationGranted:false};
  }catch(error){if(record){record.journalKey='';record.readerCredentials.key='';for(const r of record.readerCredentials.readers){r.password='';r.token='';}}throw error;}finally{loaded.bytes.fill(0);}
}
