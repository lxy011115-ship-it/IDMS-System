import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {canonical} from '../../server/imports.ts';
import {RuntimeColdControlV1,readRuntimeColdControlV1} from '../runtime-cold-portable-control-v1.mjs';
import {FieldMapColdReviewControlV1} from '../field-map-cold-review-control-v1.mjs';
import {fieldMapFrozenProfileV2,assertFieldMapFrozenProfileV2} from '../field-map-frozen-profile-v2.mjs';
import {openFieldMapFrozenMaintenanceV4} from '../field-map-frozen-maintenance-v4.mjs';
import {verifyFieldMapFullEvidenceV1} from '../field-map-full-evidence-v1.mjs';
import {createPlatformFieldAdminQaV1} from './platform-field-admin-v1-qa.mjs';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));

export async function exerciseFieldMapColdReviewQaV1({work,nonce,cluster,identity,site,trust,keyFile,note,save,report,setReviewControl=()=>{}}){
 const state=await readRuntimeColdControlV1(trust),privateWork=join(work,'field-review-private');await privateDirectory(privateWork);
 const profiles=Object.entries(site.qa.targets).map(([tenantId,t])=>{const gate=state.source.active.find(b=>b.database===t.account.database),closed=state.source.closedReceipt.databases.find(b=>b.database===t.account.database);return fieldMapFrozenProfileV2({format:'FIELD_MAP_FROZEN_PROFILE_V1',tenantId,targetDirectory:state.details.targetDirectory,inventory:state.source.inventory,structureSha256:state.source.structures.find(s=>s.database===t.account.database).sha256,binding:t.binding,fenceBinding:gate,closed:{operationId:closed.operationId,revision:String(closed.revision)}});});assert.equal(profiles.length,2);
 const config={format:1,purpose:'FIELD_MAP_COLD_REVIEW_V1',trust,account:cluster.account,authority:identity.runtime,profiles,binDirectory:cluster.bin,keyFile,workDirectory:privateWork},configFile=join(work,'field-cold-review.private.json'),recoveryId=randomUUID();await privateNewFile(configFile,canonical(config));
 const incomplete=new FieldMapColdReviewControlV1({...config,profiles:profiles.slice(0,1)});try{await assert.rejects(incomplete.claim({recoveryId}),/FIELD_COLD_REVIEW_MAP_COVERAGE/);}finally{await incomplete.close();}assert.equal((await readRuntimeColdControlV1(trust)).phase,'RESTORED');
 note('actual cold producer inventory requires both tenant maps; omitted enterprise scope rejects without claiming or opening SQL identities');
 const control=new FieldMapColdReviewControlV1(config);setReviewControl(control);let outside,target;
 try{
 try{outside=await cluster.client();target=await cluster.client(profiles[0].fenceBinding.database);await target.query('BEGIN');await assert.rejects(openFieldMapFrozenMaintenanceV4(target,profiles[0],[{pid:outside.processID}]),/FIELD_OWNED_GUARD_NOT_MINTED/);await target.query('ROLLBACK');await target.end();target=null;await assert.rejects(control.claim({recoveryId}),/FIELD_MAP_FROZEN_OTHER_SQL_CLIENT/);assert.equal((await outside.query('SELECT 1 AS n')).rows[0].n,1);assert.equal(control.state().ownedResourceGroups,0);}finally{await target?.end().catch(()=>{});await outside?.end();}
 note('unminted PID-shaped allowances reject; a real unrelated SQL session blocks the owned-guard path and survives the failed claim');
 const identityPrivate=await json(join(work,'identity.private.json')),admin=createPlatformFieldAdminQaV1({issuer:identity.runtime.issuer,admin:identityPrivate.admin}),realm=await admin(identity.realm),restoreRealm=()=>admin(identity.realm,'PUT',{attributes:realm.attributes});
 try{await admin(identity.realm,'PUT',{attributes:{...realm.attributes,idms_authority_challenge:'not-current'}});await assert.rejects(control.claim({recoveryId}),/AUTHORITY_ENDPOINT_MISMATCH/);}finally{await restoreRealm();}assert.equal((await readRuntimeColdControlV1(trust)).phase,'RESTORED');
 note('real independent Keycloak realm marker drift rejects the durable claim before any field review phase is written');
 let claimed;
  claimed=await control.claim({recoveryId});assert.equal(claimed.phase,'FIELD_REVIEW_V1');assert.equal(claimed.alreadyClaimed,false);assert.equal(claimed.tenants.length,2);assert.equal(claimed.reviewApproved,false);assert.equal(claimed.formalFieldActivationGranted,false);
  const stored=await readRuntimeColdControlV1(trust);assert.equal(stored.phase,'FIELD_REVIEW_V1');assert.equal(stored.details.fieldReview.recoveryId,recoveryId);assert(stored.details.fieldReview.baselines.some(b=>b.facts.leaves>256));for(const b of stored.details.fieldReview.baselines){assert(b.facts.entireCurrentRootVerified&&b.facts.fullDomainPayloadReconstructed&&b.facts.allSqlReceiptsVerified);assert.equal(BigInt(b.facts.leaves),BigInt(b.head.count));}
  await save('field-cold-review-claim.json',claimed);report.fieldReviewTrust=trust;report.fieldReviewConfigFile=configFile;report.fieldReviewRecoveryId=recoveryId;
  note('real full cold restore is durably claimed for both tenants, with complete graph and domain/audit facts beyond the old 256-key budget');
  await assert.rejects(new RuntimeColdControlV1(cluster.account,trust,identity.runtime).admit({binDirectory:cluster.bin}),/COLD_PHASE/);for(const p of profiles){const t=site.qa.targets[p.tenantId],app=new pg.Client(t.account);try{await assert.rejects(app.connect(),e=>e.code==='28000');}finally{await app.end();}}
  note('existing cold admission rejects the new persisted phase and actual ordinary tenant SQL LOGIN stays denied');
  const repeated=await control.claim({recoveryId});assert.equal(repeated.alreadyClaimed,true);assert.deepEqual(repeated.tenants,claimed.tenants);assert.equal(repeated.deploymentId,claimed.deploymentId);await assert.rejects(control.status({recoveryId:randomUUID()}),/FIELD_COLD_REVIEW_OPERATION_CONFLICT/);assert.equal(control.state().ownedResourceGroups,0);
  note('same original recovery operation revalidates exact facts and identities; a different operation cannot take over the durable claim');
  const child=await promisify(execFile)(process.execPath,['scripts/field-map-cold-review-entry-v1.mjs','STATUS',configFile,recoveryId],{windowsHide:true,maxBuffer:4*1024**2}),reopened=JSON.parse(child.stdout);assert.equal(reopened.phase,'FIELD_REVIEW_V1');assert.deepEqual(reopened.tenants,claimed.tenants);assert.equal(reopened.deploymentId,claimed.deploymentId);assert.equal(reopened.formalFieldActivationGranted,false);
  note('a fresh actual CLI process reopens the original claim and verifies full roots from the real cold control without adopting SQL handles');
  const b=(await readRuntimeColdControlV1(trust)).details.fieldReview.baselines[0],raw=await readFile(b.evidenceFile,'utf8');assert(Buffer.byteLength(raw)<32*1024**2);const lines=raw.trimEnd().split('\n');const at=lines.findIndex(line=>{const v=JSON.parse(line);return v.type==='NODE'&&v.node.kind===0;});assert(at>0);const changed=JSON.parse(lines[at]);changed.valueText='{"tampered":true}';lines[at]=canonical(changed);const tampered=join(privateWork,'tampered-evidence-copy.jsonl');await privateNewFile(tampered,lines.join('\n')+'\n');await assert.rejects(verifyFieldMapFullEvidenceV1({file:tampered,expectedFacts:b.facts,workDirectory:privateWork}),/FIELD_FULL_EVIDENCE_VALUE_CHANGED/);
  note('offline evidence verification independently reconstructs the full root and domain, and rejects a modified leaf in a separate copy');
  try{await admin(identity.realm,'PUT',{attributes:{...realm.attributes,idms_authority_challenge:'not-current'}});await assert.rejects(control.status({recoveryId}),/AUTHORITY_ENDPOINT_MISMATCH/);}finally{await restoreRealm();}assert.equal((await readRuntimeColdControlV1(trust)).phase,'FIELD_REVIEW_V1');
  note('current external identity still precedes an existing idempotent status; authority drift never reopens the original claim');
  const final=await control.status({recoveryId});assert.deepEqual(final.tenants,claimed.tenants);for(const p of profiles){const root=await cluster.client(p.fenceBinding.database);try{await assertFieldMapFrozenProfileV2(root,p,false);const actual=(await root.query("SELECT revision::text,encode(root_hash,'hex') AS hash FROM state_map_v1.head")).rows[0],h=claimed.tenants.find(t=>t.tenantId===p.tenantId).head;assert.equal(actual.revision,h.revision);assert.equal(actual.hash,h.rootHash);}finally{await root.end();}}
  assert.equal(control.state().ownedResourceGroups,0);report.fieldColdReview={recoveryId,deploymentId:claimed.deploymentId,tenantFacts:final.tenants,phase:'FIELD_REVIEW_V1',producerWasRealRuntimeColdControl:true,actualCurrentAuthorityVerified:true,fullGraphDatasetIndependentlyRebuilt:true,unknownNamespaceEntriesIncluded:300,sqlDataAndGateGenerationsUnchanged:true,ordinarySqlLoginDenied:true,oldAdmissionDenied:true,actualFreshStatusProcessVerified:true,currentOidcReviewerVerified:false,reviewApproved:false,formalFieldActivationGranted:false};
  note('all status reads preserve the captured roots, audit histories, CLOSED generations and complete frozen role inventory; no approval is granted');
 }finally{await control.close();assert.equal(control.state().ownedResourceGroups,0);}
 return {trust,recoveryId,configFile};
}
