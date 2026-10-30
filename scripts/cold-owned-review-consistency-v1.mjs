import {lstat,readFile,realpath} from 'node:fs/promises';
import {dirname,basename,resolve,join} from 'node:path';
import {canonical} from '../server/imports.ts';
import {reviewSourceNeedV1 as need,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {assertColdReviewInputsV1} from './cold-review-inputs-v1.mjs';
import {validateCurrentRecoveryWorkflowSnapshotV1} from './field-recovery-current-workflow-v2.mjs';

/** Called inside the original preparer's authority/store guards, never an approval capability. */
export async function verifyColdOwnedReviewConsistencyV1({source,fullFactsCheck,ownedWorkflows,recoveryId,sourceHash,workDirectory}){
 need(source?.format==='RUNTIME_COLD_REVIEW_SOURCE_V3'&&hash(source)===sourceHash&&ownedWorkflows?.format==='COLD_OWNED_REVIEW_WORKFLOW_FACTS_V1'&&ownedWorkflows.recoveryId===recoveryId&&ownedWorkflows.sourceHash===sourceHash&&ownedWorkflows.sourceFullFactsSha256===source.fullFacts.sha256&&fullFactsCheck?.sourceFullFactsSha256===source.fullFacts.sha256,'COLD_REVIEW_CONSISTENCY_BINDING');
 const maps=source.fullFacts.databases.filter(d=>d.map).map(d=>d.map),readers=source.readerContract.readers;
 const set=a=>[...a].sort().join(','),tenants=maps.map(m=>m.tenantId);
 need(maps.length>0&&maps.length<=32&&new Set(tenants).size===tenants.length&&Array.isArray(fullFactsCheck.maps)&&Array.isArray(ownedWorkflows.tenants)&&readers.length===maps.length&&fullFactsCheck.maps.length===maps.length&&ownedWorkflows.tenants.length===maps.length&&set(readers.map(r=>r.facts.tenantId))===set(tenants)&&set(fullFactsCheck.maps.map(m=>m.tenantId))===set(tenants)&&set(ownedWorkflows.tenants.map(t=>t.tenantId))===set(tenants),'COLD_REVIEW_CONSISTENCY_INVENTORY');
 const results=[];
 for(const original of maps){
  const tenantId=original.tenantId,m=fullFactsCheck.maps.find(v=>v.tenantId===tenantId),w=ownedWorkflows.tenants.find(v=>v.tenantId===tenantId),r=readers.find(v=>v.facts.tenantId===tenantId).facts;
  assertColdReviewInputsV1(m.reviewInputs,{tenantId,sourceFullFactsSha256:source.fullFacts.sha256,sourceMapFactsSha256:original.facts.factsSha256,payloadSha256:original.facts.payloadSha256});
  need(w.authorityId===r.authorityId&&typeof w.evidenceFile==='string','COLD_REVIEW_CONSISTENCY_WORKFLOW_BINDING');
  const directory=dirname(w.evidenceFile),name=basename(directory);
  need(/^owned-session-[a-f0-9-]{36}$/.test(name)&&dirname(directory)===resolve(workDirectory)&&directory===await realpath(directory)&&basename(w.evidenceFile).match(new RegExp('^workflow-'+tenantId+'-[a-f0-9-]{36}\\.private\\.json$'))&&join(directory,basename(w.evidenceFile))===w.evidenceFile,'COLD_REVIEW_CONSISTENCY_EVIDENCE_PATH');
  const before=await lstat(w.evidenceFile);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=3*1024**2,'COLD_REVIEW_CONSISTENCY_EVIDENCE_FILE');
  const bytes=await readFile(w.evidenceFile);need(hash(bytes)===w.snapshotSha256,'COLD_REVIEW_CONSISTENCY_EVIDENCE_CHANGED');
  const snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));need(canonical(snapshot)===bytes.toString('utf8'),'COLD_REVIEW_CONSISTENCY_EVIDENCE_CANONICAL');
  validateCurrentRecoveryWorkflowSnapshotV1({tenantId,authorityId:r.authorityId,definitionSha256:r.bpmnSha256},m.reviewInputs.orders,snapshot);
  const after=await lstat(w.evidenceFile);need(after.isFile()&&!after.isSymbolicLink()&&after.nlink===1&&after.dev===before.dev&&after.ino===before.ino&&after.size===before.size&&hash(await readFile(w.evidenceFile))===w.snapshotSha256,'COLD_REVIEW_CONSISTENCY_EVIDENCE_CHANGED');
  need(snapshot.cases.length===w.caseCount&&snapshot.commandCount===w.commandCount,'COLD_REVIEW_CONSISTENCY_SUMMARY_CHANGED');
  results.push({tenantId,reviewInputsSha256:m.reviewInputs.sha256,workflowSnapshotSha256:w.snapshotSha256,orderCount:m.reviewInputs.orders.length,workflowOrderCount:snapshot.cases.length,publishedPolicyCount:m.reviewInputs.policies.length,allOrdersAndProcessesCompared:true});
 }
 const body={format:'COLD_OWNED_REVIEW_CONSISTENCY_V1',recoveryId,sourceHash,sourceFullFactsSha256:source.fullFacts.sha256,intentSha256:ownedWorkflows.intentSha256,readerLeaseId:ownedWorkflows.readerLeaseId,tenants:results,workflowOrderInventoryVerified:true,currentOidcReviewerVerified:false,reviewApproved:false,formalFieldActivationGranted:false};
 return {...body,sha256:hash(body)};
}
