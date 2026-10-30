import assert from 'node:assert/strict';
import {readFile,lstat,readdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {coldToolingV1,coldStoppedV1} from './pg-cold-image-portable-tools-v1.mjs';
import {stateKey,verifyStateProof} from '../server/state-map-v1.ts';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {fieldAdmissionDecision} from '../server/field-admission.ts';
import {readCurrentFieldAdmissionMapV1} from '../server/field-admission-map-v1.ts';
import {publicFieldProfileDigest} from '../integrations/field-profile.ts';

assert.equal(process.argv.length,3);const nonce=process.argv[2];assert(/^[a-f0-9]{12}$/.test(nonce));
const root=resolve('.'),work=resolve('work/field-admission-map-v1-20261024',nonce),hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=p=>readActivationMaterialFile(p,32*1024**2),json=async p=>JSON.parse((await bytes(p)).toString('utf8'));
const r=await json(join(work,'verification.private.json')),pins=await json(join(work,'native-input-pins.json'));
assert.equal(r.format,'IDMS_FIELD_ADMISSION_MAP_NATIVE_V1');assert.equal(r.nonce,nonce);assert.equal(pins.nonce,nonce);
assert(r.passed&&r.checks.length===7&&r.cleanupComplete&&r.cleanupErrors.length===0&&r.postgresCleanOffline&&r.fenceCatalogUnchanged);
assert.equal(r.originalDatabaseContacted,false);assert.equal(r.platformIdentityAuthorityExecuted,false);assert.equal(r.fieldIssuerOrMqttDataPathExecuted,false);assert.equal(r.allProductionDependenciesRegistered,false);
assert.deepEqual(pins.sourcePins,r.sourcePins);assert.deepEqual(pins.node,r.node);
for(const p of r.sourcePins){const file=resolve(p.path),rel=relative(root,file);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(hash(await bytes(file)),p.sha256);}
assert.equal(hash(await readFile(process.execPath)),r.node.sha256);assert.equal(process.versions.node,r.node.version);
const proofBytes=await bytes(join(work,'domain-proofs.private.json'));assert.equal(hash(proofBytes),r.domainProofsSha256);const e=JSON.parse(proofBytes);
assert.equal(e.format,'IDMS_FIELD_ADMISSION_MAP_PROOFS_V1');assert.equal(e.nonce,nonce);
const tenant=e.profile.source.tenantId,profileDigest=publicFieldProfileDigest(e.profile);assert.equal(tenant,r.binding.tenantId);
let memberProofs=0;
function lookup(record){
 const entries=new Map();assert(Array.isArray(record.proofs)&&record.proofs.length<=256);
 for(const {namespace,key,proof}of record.proofs){
  const id=namespace+'\0'+key;assert(!entries.has(id));const value=verifyStateProof(proof,record.head,stateKey(tenant,namespace,key));assert(value.present);entries.set(id,value.value);memberProofs++;
 }
 return async(ns,key)=>{assert(entries.has(ns+'\0'+key),'FIELD_MAP_INDEPENDENT_MEMBER_MISSING');return structuredClone(entries.get(ns+'\0'+key));};
}
for(const [name,payload]of [['initial',e.initialPayload],['final',e.finalPayload]]){
 const c=e[name],get=lookup(c),actual=await readCurrentFieldAdmissionMapV1(e.profile,c.at,null,get),store={...payload.business,audits:payload.audits,idempotency:new Map(payload.idempotency)};
 assert.deepEqual(actual,c.result);assert.deepEqual(actual.decision,fieldAdmissionDecision(store,payload.imports,e.profile,c.at,null));assert.equal(actual.control.governanceAnchorDigest,canonicalDigest(payload));
 assert.equal(actual.head.compiledPayloadDigest,canonicalDigest(payload));assert.equal(actual.head.profileDigest,profileDigest);
 assert.equal(actual.decision.binding.evaluatedAt,new Date(c.at).toISOString());assert(c.proofs.length<256&&actual.nodeReads<=64);
}
assert(e.initial.result.decision.allowed);assert.equal(e.final.result.decision.allowed,false);assert.equal(e.final.result.decision.reason,'FIELD_APPROVAL_PAUSED');
assert.notEqual(canonicalDigest(e.initialPayload),canonicalDigest(e.finalPayload));assert.equal(canonicalDigest(e.finalPayload),r.finalAnchor);
assert.equal(r.jobs.length,3);assert.deepEqual(r.jobs.map(j=>j.action),['TEMPLATE_CREATE','TEMPLATE_SUBMIT','TEMPLATE_APPROVE']);
assert.equal(r.jobs[0].actorId,r.jobs[1].actorId);assert.notEqual(r.jobs[0].actorId,r.jobs[2].actorId);
const reviewed=e.finalPayload.business.templates.filter(t=>t.publishedBy===r.jobs[2].actorId&&t.manifest.purpose==='field-channel-policy'&&t.version==='1.0.1');assert.equal(reviewed.length,1);
assert.equal(e.staged.length,r.stagedIsolationChecks);assert.equal(e.staged.length,r.jobs.reduce((n,j)=>n+j.stagedGroups,0));
for(const job of r.jobs){assert(job.status==='COMMITTED'&&job.stagedGroups>0);assert.equal(e.staged.filter(s=>s.commandId===job.commandId&&s.action===job.action).length,job.stagedGroups);}
for(const staged of e.staged){const get=lookup(staged),control=await get('domain_head','control'),field=await get('field_admission',profileDigest);assert.equal(control.status,'UPDATING');assert.equal(field.compiledPayloadDigest,control.governanceAnchorDigest);await assert.rejects(readCurrentFieldAdmissionMapV1(e.profile,e.final.at,null,get),/FIELD_ADMISSION_MAP_NOT_ACTIVE/);}
assert(canonicalEqual(e.replay.before,e.replay.after)&&canonicalEqual(e.replay.before,e.closedFenceHead)&&canonicalEqual(e.final.head,e.replay.before));
// Verify that the independent verifier actually rejects a corrupted member proof.
const corrupt=structuredClone(e.final);corrupt.proofs[0].proof.valueText='{"changed":true}';assert.throws(()=>lookup(corrupt));
assert.equal(memberProofs,e.initial.proofs.length+e.final.proofs.length+e.staged.reduce((n,s)=>n+s.proofs.length,0));
const cluster=await json(join(r.postgres.work,'cluster.private.json'));
assert(/^[a-f0-9]{12}[\\/]source$/.test(relative(resolve('work/pg-physical-platform-v1-20261022'),r.postgres.source)));
assert.equal(cluster.source,r.postgres.source);assert.equal(cluster.authority.port,r.postgres.port);assert.notEqual(r.postgres.port,45432);
const tooling=await coldToolingV1(cluster.bin),control=await coldStoppedV1(r.postgres.source,tooling,r.postgres.systemIdentifier);assert(control);await assert.rejects(lstat(join(r.postgres.source,'postmaster.pid')),{code:'ENOENT'});
assert(r.postgresProcesses.length===1&&r.postgresProcesses.every(p=>p.stopped&&p.directory===r.postgres.source&&p.systemIdentifier===control.systemIdentifier));
const journal=[];for(const name of (await readdir(r.postgres.work)).filter(n=>/^cluster-event-\d{4}\.json$/.test(n)).sort())journal.push(await json(join(r.postgres.work,name)));
const stopped=journal.at(-1);assert.equal(stopped.type,'STOPPED');assert(stopped.pidAbsent&&stopped.stopped);assert.equal(stopped.pid,r.postgresProcesses[0].pid);assert.deepEqual(stopped.control,control);
console.log(JSON.stringify({format:'IDMS_FIELD_ADMISSION_MAP_INDEPENDENT_V1',nonce,readOnly:true,nativeChecks:7,sourcePinsVerified:r.sourcePins.length,currentRootMembershipProofsVerified:memberProofs,originalRuleComparisons:2,stagedIsolationGroupsVerified:e.staged.length,independentModelActorIdsVerified:true,replayAndBlockedFenceHeadUnchanged:true,corruptedMembershipProofRejected:true,postgresCleanOffline:true,postgresNeverRestarted:true,offlineSqlRowsRequeried:false,platformIdentityAuthorityExecuted:false,fieldIssuerOrMqttDataPathExecuted:false,allProductionDependenciesRegistered:false,fullGoalComplete:false}));
