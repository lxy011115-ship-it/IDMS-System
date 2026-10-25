import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {canonical} from '../../server/imports.ts';
import {privateDirectory,privateNewFile} from '../../scripts/backup-support.mjs';
import {reviewSourceHashV1 as hash} from '../../scripts/workflow-review-source-facts-v1.mjs';
import {coldReviewInputsV1} from '../../scripts/cold-review-inputs-v1.mjs';

/** Persistence fixtures only: identity records here are data, never real OIDC authentication evidence. */
export async function coldPlanJournalInputQaV1({nestedStore=false}={}){
 const directory=resolve('work/cold-plan-journal-tests',randomUUID());await privateDirectory(directory);
 const storeDirectory=nestedStore?join(directory,'cold-control'):directory,workDirectory=nestedStore?join(directory,'review-private'):directory;await privateDirectory(storeDirectory);await privateDirectory(workDirectory);
 const storeFile=join(storeDirectory,'control.sqlite'),controlId=randomUUID(),recoveryId=randomUUID(),tenants=['acme','sandbox'];
 const payload={business:{workOrders:[],templates:[]}},source={format:'RUNTIME_COLD_REVIEW_SOURCE_V3',controlId,fullFacts:{sha256:hash('unit-full-facts'),databases:tenants.map(t=>({map:{tenantId:t,facts:{factsSha256:hash('unit-map-'+t),payloadSha256:hash(payload)}}}))}};
 const sourceHash=hash(source),trust={format:'RUNTIME_COLD_REVIEW_TRUST_V3',controlId,sourceHash,storeFile},credentials={format:'COLD_REVIEW_READERS_PRIVATE_V3',controlId,sourceHash,recoveryId,key:randomBytes(32).toString('hex'),readers:[]};
 const originalIntent={format:'COLD_READONLY_REVIEW_INTENT_V3',recoveryId,sourceHash,controlId,credentialSha256:hash(credentials),businessAdmissionGranted:false};
 const context={trust,source,recoveryId,intentSha256:hash(originalIntent),credentialSha256:hash(credentials),workDirectory};
 let details={review:originalIntent},db=new DatabaseSync(storeFile);db.exec('CREATE TABLE cold_control(id INTEGER PRIMARY KEY,details TEXT NOT NULL)');db.prepare('INSERT INTO cold_control VALUES(1,?)').run(canonical(details));
 const fixtureFile=join(storeDirectory,'reopen.private.json');await privateNewFile(fixtureFile,canonical({format:'COLD_PLAN_JOURNAL_REOPEN_INPUT_V1',context,credentials,storeFile}));
 const result={directory,storeFile,fixtureFile,context,credentials,originalIntent,
  get db(){return db;},get details(){return details;},
  begin(){db.exec('BEGIN IMMEDIATE');},
  commit(){db.prepare('UPDATE cold_control SET details=? WHERE id=1').run(canonical(details));db.exec('COMMIT');},
  rollback(){db.exec('ROLLBACK');details=JSON.parse(db.prepare('SELECT details FROM cold_control WHERE id=1').get().details);},
  reopen(){db.close();db=new DatabaseSync(storeFile);details=JSON.parse(db.prepare('SELECT details FROM cold_control WHERE id=1').get().details);},
  close(){if(db.isTransaction)db.exec('ROLLBACK');db.close();},
  async current({swap=false,omit=false,extraAuthor=false,reviewerIsContributor=false,workflowSeed='original',ageMs=0}={}){
   const maps=source.fullFacts.databases.map(d=>({tenantId:d.map.tenantId,reviewInputs:coldReviewInputsV1({payload,tenantId:d.map.tenantId,sourceFullFactsSha256:source.fullFacts.sha256,sourceMapFactsSha256:d.map.facts.factsSha256,payloadSha256:hash(payload)})}));
   const fullFactsCheck={sourceFullFactsSha256:source.fullFacts.sha256,maps},readerLeaseId=randomUUID(),actors=tenants.map(tenantId=>{const a=tenantId+'-author',b=tenantId+'-contributor',authorId=extraAuthor?tenantId+'-later-author':swap?b:a,ids=omit?[]:extraAuthor?[a,b]:[swap?a:b];return{tenantId,externalConfigSha256:hash('unit-config-'+tenantId),author:{tenantId,purpose:'AUTHOR',actorId:authorId},contributors:ids.map(actorId=>({tenantId,purpose:'AUTHOR',actorId})),reviewer:{tenantId,purpose:'REVIEWER',actorId:reviewerIsContributor?a:tenantId+'-reviewer'}};});
   const comparisons=maps.map(m=>({tenantId:m.tenantId,reviewInputsSha256:m.reviewInputs.sha256,workflowSnapshotSha256:hash(workflowSeed+'-workflow-'+m.tenantId)}));
   const consistencyBody={format:'COLD_OWNED_REVIEW_CONSISTENCY_V1',sourceHash,sourceFullFactsSha256:source.fullFacts.sha256,recoveryId,intentSha256:context.intentSha256,readerLeaseId,tenants:comparisons,workflowOrderInventoryVerified:true},reviewConsistency={...consistencyBody,sha256:hash(consistencyBody)};
   const now=Date.now()-ageMs,body={format:'COLD_CURRENT_ACTORS_OBSERVATION_V1',controlId,sourceHash,sourceFullFactsSha256:source.fullFacts.sha256,recoveryId,intentSha256:context.intentSha256,readerLeaseId,fullFactsCheckSha256:hash(fullFactsCheck),reviewConsistencySha256:reviewConsistency.sha256,actors,beforeActorsSha256:hash(actors),afterActorsSha256:hash(actors),capturedFrom:new Date(now-1000).toISOString(),capturedAt:new Date(now).toISOString(),expiresAt:new Date(now+25000).toISOString(),workflowReadTransport:'ORIGINAL_OWNED_READER',externalWorkflowHttpUsed:false,currentOidcReviewerVerified:true,independentReviewersVerified:true,declaredContributorsCurrentVerified:true,durablePlanContributorsVerified:false,approvalGranted:false,formalFieldActivationGranted:false,fullGoalComplete:false,workflowCaptures:[0,1].map(()=>({sourceHash,recoveryId,intentSha256:context.intentSha256,readerLeaseId,tenants:comparisons.map(t=>({tenantId:t.tenantId,snapshotSha256:t.workflowSnapshotSha256}))}))};
   const stored={...body,sha256:hash(body)},evidenceFile=join(workDirectory,'actors-observation-'+randomUUID()+'.private.json');await privateNewFile(evidenceFile,canonical(stored));return{observation:{...stored,evidenceFile},fullFactsCheck,reviewConsistency};
  }
 };return result;
}
