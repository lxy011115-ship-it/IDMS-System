import assert from 'node:assert/strict';
import {readFile,lstat,readdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash,createPublicKey} from 'node:crypto';
import {readActivationMaterialFile} from './field-activation-material-files.mjs';
import {coldToolingV1,coldStoppedV1} from './pg-cold-image-portable-tools-v1.mjs';
import {stateKey,verifyStateProof} from '../server/state-map-v1.ts';
import {canonicalDigest} from '../server/canonical-state.ts';
import {validateTenantPayload} from '../server/entity-repository.ts';
import {compileFieldRuntimeMapV1} from '../server/field-runtime-map-v1.ts';
import {fieldCurrentLeaseCheckMapV1} from '../server/field-map-lease-v1.ts';
import {fieldCurrentLeaseCheck} from '../server/field-current-check.ts';
import {inspectFieldLeaseEvidence} from '../server/field-lease-evidence.ts';
import {fieldLeaseKeyId,verifyFieldLease} from '../integrations/field-lease.ts';
import {verifyFieldCheck} from '../integrations/field-check.ts';

assert.equal(process.argv.length,3);const nonce=process.argv[2];assert(/^[a-f0-9]{12}$/.test(nonce));
const root=resolve('.'),work=resolve('work/field-map-lease-v1-20261024',nonce),hash=b=>createHash('sha256').update(b).digest('hex'),bytes=p=>readActivationMaterialFile(p,32*1024**2),json=async p=>JSON.parse((await bytes(p)).toString('utf8'));
const r=await json(join(work,'verification.private.json')),pins=await json(join(work,'native-input-pins.json'));
assert.equal(r.format,'IDMS_FIELD_MAP_LEASE_NATIVE_V1');assert.equal(r.nonce,nonce);assert.equal(pins.nonce,nonce);assert.deepEqual(r.sourcePins,pins.sourcePins);assert.deepEqual(r.node,pins.node);
assert(r.passed&&r.checks.length===13&&r.cleanupComplete&&r.cleanupErrors.length===0&&r.postgresCleanOffline&&r.fenceCatalogUnchanged&&r.queryHookRestored&&r.committedReplyLossInjected&&r.resolvedOriginalSqlReceipt);
assert(r.currentMapIssuerExecuted);for(const k of ['originalDatabaseContacted','platformIdentityAuthorityExecuted','fieldMqttDataPathExecuted','allProductionDependenciesRegistered'])assert.equal(r[k],false);
assert(r.issuerTerminalStates.length===2);for(const s of r.issuerTerminalStates)assert(s.closing&&s.closed&&s.active===0&&s.keyCount===0);
for(const pin of r.sourcePins){const file=resolve(pin.path),rel=relative(root,file);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(hash(await bytes(file)),pin.sha256);}
assert.equal(hash(await readFile(process.execPath)),r.node.sha256);assert.equal(process.versions.node,r.node.version);
const proofBytes=await bytes(join(work,'domain-proofs.private.json'));assert.equal(hash(proofBytes),r.domainProofsSha256);const e=JSON.parse(proofBytes);assert.equal(e.format,'IDMS_FIELD_MAP_LEASE_PROOFS_V1');assert.equal(e.nonce,nonce);
const final=e.final,tenant=e.profile.source.tenantId,key=createPublicKey(e.publicKeyPem);assert.equal(fieldLeaseKeyId(key),final.snapshot.leaseKeyId);validateTenantPayload(final.payload,tenant);
let memberProofs=0;
function snapshot(record){const entries=new Map();assert(record.proofs.length<256);for(const {namespace,key,proof}of record.proofs){const id=namespace+'\0'+key;assert(!entries.has(id));entries.set(id,verifyStateProof(proof,record.head,stateKey(tenant,namespace,key)));memberProofs++;}
 return {tenantId:tenant,head:record.head,state:async(ns,k)=>{const v=entries.get(ns+'\0'+k);assert(v,'FIELD_MAP_INDEPENDENT_MEMBER_MISSING');return structuredClone(v);},get:async function(ns,k){const v=await this.state(ns,k);assert(v.present);return v.value;}};
}
const s=snapshot(final),control=await s.get('domain_head','control');assert.equal(control.governanceAnchorDigest,canonicalDigest(final.payload));assert.equal(control.status,'ACTIVE');
for(const entry of compileFieldRuntimeMapV1(final.payload,tenant))assert.deepEqual(await s.get(entry.namespace,entry.key),JSON.parse(entry.valueText));
const actual=await fieldCurrentLeaseCheckMapV1(s,final.request,final.snapshot,key,final.check.body.checkedAtMs);assert.deepEqual(actual,final.check.body);assert.equal(actual.reason,'FIELD_APPROVAL_PAUSED');
const store={...final.payload.business,audits:final.payload.audits},original=fieldCurrentLeaseCheck(store,final.payload.imports,final.request,final.snapshot,key,final.check.body.checkedAtMs);assert.deepEqual(actual,original);
verifyFieldLease(final.lease,key,{...e.profile.source,profileDigest:final.lease.body.profileDigest},final.lease.body.issuedAtMs);verifyFieldCheck(final.check,key,{requestId:final.request.requestId,requestedAtMs:final.request.requestedAtMs,lease:final.lease},final.check.body.checkedAtMs);
const observations=new Map(final.payload.audits.filter(a=>a.objectType==='FIELD_REGISTRY').map(a=>[a.eventId,a]));let issuanceAudits=0;
for(const a of final.payload.audits)if(a.objectType==='FIELD_LEASE'){inspectFieldLeaseEvidence(store,final.payload.imports,a,observations);issuanceAudits++;}
assert(issuanceAudits>=6);assert.equal(r.rejectedRequestIds.length,2);for(const id of r.rejectedRequestIds)assert.equal(final.payload.audits.filter(a=>a.objectType==='FIELD_LEASE'&&a.objectId===id).length,0);
assert.equal(r.jobs.length,3);assert(r.jobs.every(j=>j.status==='COMMITTED'));assert.notEqual(r.jobs[0].actorId,r.jobs[2].actorId);assert(r.stagedIsolationGroups>=3);
const verifiedMembers=memberProofs;const corrupt=structuredClone(final);corrupt.proofs[0].proof.valueText='{"changed":true}';assert.throws(()=>snapshot(corrupt));assert.equal(memberProofs,verifiedMembers);
const cluster=await json(join(r.postgres.work,'cluster.private.json'));assert(/^[a-f0-9]{12}[\\/]source$/.test(relative(resolve('work/pg-physical-platform-v1-20261022'),r.postgres.source)));assert.equal(cluster.source,r.postgres.source);assert.equal(cluster.authority.port,r.postgres.port);assert.notEqual(r.postgres.port,45432);
const tooling=await coldToolingV1(cluster.bin),controlFile=await coldStoppedV1(r.postgres.source,tooling,r.postgres.systemIdentifier);await assert.rejects(lstat(join(r.postgres.source,'postmaster.pid')),{code:'ENOENT'});assert(r.postgresProcesses.length===1&&r.postgresProcesses.every(p=>p.stopped&&p.directory===r.postgres.source));
const journal=[];for(const name of (await readdir(r.postgres.work)).filter(n=>/^cluster-event-\d{4}\.json$/.test(n)).sort())journal.push(await json(join(r.postgres.work,name)));const stopped=journal.at(-1);assert.equal(stopped.type,'STOPPED');assert(stopped.stopped&&stopped.pidAbsent);assert.equal(stopped.pid,r.postgresProcesses[0].pid);assert.deepEqual(stopped.control,controlFile);
console.log(JSON.stringify({format:'IDMS_FIELD_MAP_LEASE_INDEPENDENT_V1',nonce,readOnly:true,nativeChecks:13,sourcePinsVerified:r.sourcePins.length,currentRootMembershipProofsVerified:verifiedMembers,persistedIssuanceAuditsVerified:issuanceAudits,originalCurrentCheckCompared:true,leaseAndCheckSignaturesVerified:true,rolledBackIssuancesAbsent:true,corruptedMembershipProofRejected:true,issuerKeysCleared:true,postgresCleanOffline:true,postgresNeverRestarted:true,offlineSqlRowsRequeried:false,currentMapIssuerExecuted:true,platformIdentityAuthorityExecuted:false,fieldMqttDataPathExecuted:false,allProductionDependenciesRegistered:false,fullGoalComplete:false}));
