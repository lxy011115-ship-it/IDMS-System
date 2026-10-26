import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createPublicKey,generateKeyPairSync,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonical} from '../server/imports.ts';
import {readRuntimeColdReviewWithFieldSourceV2} from '../scripts/runtime-cold-readonly-control-v7.mjs';
import {verifyFieldMapFullFieldSourceHistoryV1 as project} from '../scripts/field-map-full-field-source-history-v1.mjs';
import {readColdFieldSourceHistoryV1 as readHistory} from '../scripts/cold-field-source-history-v1.mjs';
import {inspectColdFieldSpoolSnapshotV2 as inspect} from '../scripts/cold-field-spool-snapshot-v2.mjs';
import {inspectColdFieldSourceSpoolV1 as inspectSource} from '../scripts/cold-field-source-spool-v1.mjs';
import {coldFieldMaterialActualInputQaV2 as fixture} from './fixtures/cold-field-material-source-files-v2-input.mjs';

async function input(mode='ENABLED'){
  const value=await fixture(),original=resolve(process.env.IDMS_COLD_FIELD_MATERIAL_QA_CASE),proof=await value.json(join(original,'field-manager-proofs.private.json')),trust=value.sourceModes.find(value=>value.mode===mode).trust,state=await readRuntimeColdReviewWithFieldSourceV2(trust),map=state.source.fullFacts.databases.find(value=>value.map?.tenantId==='sandbox').map,workDirectory=join(value.directory,'history-work');await mkdir(workDirectory);
  const publicKey=createPublicKey(proof.publicKeyPem),spool=join(value.directory,'edge-spool'),name=(await readdir(spool)).find(value=>/^stream-[a-f0-9]{64}\.sqlite$/.test(value));assert(name);
  return {...value,proof,trust,state,map,workDirectory,publicKey,key:randomBytes(32),bytes:await readFile(join(spool,name)),eventKey:await readFile(join(value.directory,'event.bin')),raw:{file:map.evidenceFile,expectedFacts:map.facts,workDirectory,publicKeys:[publicKey]},context:{trust,tenantId:'sandbox',publicKeys:[publicKey],workDirectory}};
}
const normalized=history=>history.events.filter(value=>value.receipt.status==='STORED').map(value=>({eventDigest:value.receipt.eventDigest,receiptAuditId:value.receipt.auditEventId,receiptAt:value.receipt.receivedAt,status:value.receipt.status,pointId:value.receipt.pointId}));
function options(value,history){return {profile:value.proof.profile,contextLease:value.proof.page.items[0].receipt.envelope.lease,eventKey:value.eventKey,platformPublicKey:value.publicKey,acknowledgedEvents:history.events.filter(value=>value.receipt.status==='STORED').map(value=>value.event),acknowledgedReceipts:normalized(history),sourceLeaseBodies:history.issuances.map(value=>value.body),capacity:value.edge.spool.capacity,maxBytes:value.edge.spool.maxBytes,workDirectory:value.workDirectory};}
function sourceOptions(value){return {trust:value.trust,tenantId:'sandbox',profile:value.proof.profile,contextLease:value.proof.page.items[0].receipt.envelope.lease,eventKey:value.eventKey,platformPublicKey:value.publicKey,historyPublicKeys:[value.publicKey],capacity:value.edge.spool.capacity,maxBytes:value.edge.spool.maxBytes,workDirectory:value.workDirectory};}

test('complete actual SOURCE root projects every historical receipt, point, registry and issuance',async()=>{
  const value=await input(),result=await project(value.raw);assert.equal(result.fieldHistory.events.length,value.proof.page.items.length);assert(result.fieldHistory.issuances.length>0&&result.fieldHistory.registries.length>0);assert.deepEqual(result.fieldSourceFacts,value.state.source.fieldSource.fieldMaps.find(value=>value.binding.tenantId==='sandbox').fieldFacts);
  for(const record of result.fieldHistory.events){const expected=value.proof.page.items.find(value=>value.receipt.eventDigest===record.receipt.eventDigest);assert(expected);assert.deepEqual(record.receipt,expected.receipt);assert.deepEqual(record.point,expected.point);}
  assert.throws(()=>JSON.stringify(result),/COLD_FIELD_HISTORY_PRIVATE_ONLY/);assert.deepEqual(await readdir(value.workDirectory),[]);
});
test('SOURCE-selected history preserves enabled and explicitly disabled historical roots',async()=>{
  for(const mode of ['ENABLED','EXPLICIT_DISABLED']){const value=await input(mode),history=await readHistory(value.context,value.key);assert.equal(history.evidence.events,value.proof.page.items.length);assert.equal(history.sourceBinding.sourceHash,value.trust.sourceHash);assert(history.evidence.sourceSelectedEvidenceFileAndTrustedFacts);assert.equal(history.evidence.currentHeldSessionVerified,false);assert.equal(history.evidence.completeFieldMaterialsVerified,false);assert.throws(()=>JSON.stringify(history),/COLD_FIELD_HISTORY_PRIVATE_ONLY/);assert.deepEqual(await readdir(value.workDirectory),[]);}
});
test('modified leaf values and an incomplete receipt chain cannot produce projected history',async()=>{
  for(const kind of ['LEAF','RECEIPT']){const value=await input(),lines=(await readFile(value.map.evidenceFile,'utf8')).trimEnd().split('\n'),records=lines.map(value=>JSON.parse(value));
    if(kind==='LEAF'){const index=records.findIndex(value=>value.type==='NODE'&&typeof value.valueText==='string');assert(index>=0);records[index].valueText='null';lines[index]=canonical(records[index]);}
    else{const index=records.findIndex(value=>value.type==='RECEIPT');assert(index>=0);lines.splice(index,1);}
    const file=join(value.directory,'altered-'+kind+'.ndjson');await writeFile(file,lines.join('\n')+'\n',{flag:'wx'});await assert.rejects(project({...value.raw,file}),/FIELD_FULL_EVIDENCE_/);assert.deepEqual(await readdir(value.workDirectory),[]);
  }
});
test('missing, wrong or duplicated historical keys fail closed',async()=>{
  for(const kind of ['MISSING','WRONG','DUPLICATE']){const value=await input(),publicKeys=kind==='MISSING'?[]:kind==='WRONG'?[generateKeyPairSync('ed25519').publicKey]:[value.publicKey,value.publicKey];await assert.rejects(project({...value.raw,publicKeys}),/COLD_FIELD_HISTORY_KEY/);assert.deepEqual(await readdir(value.workDirectory),[]);}
});
test('actual SOURCE historical members and captured spool signatures compose without a current authority claim',async()=>{
  const value=await input(),result=await inspectSource(value.bytes,sourceOptions(value),value.key);assert.equal(result.evidence.pending,value.proof.profile.points.length);assert.equal(result.evidence.acknowledged,value.proof.profile.points.length);assert(result.evidence.actualSourceCompleteRootAndHistoryVerified&&result.evidence.allProvidedEventIssuancesMatchActualSource&&result.evidence.allRetainedAckAuditAndTimeAndPointOutcomesMatchActualSource);
  for(const name of ['wholePrivateFileSetAndEmptyWalBound','currentHeldSessionVerified','currentTargetSqlCommitOrIdentityProven','completeFieldMaterialsVerified','formalFieldActivationGranted','fullGoalComplete'])assert.equal(result.evidence[name],false);assert.match(result.fingerprint,/^[a-f0-9]{64}$/);assert.throws(()=>JSON.stringify(result),/COLD_FIELD_SOURCE_SPOOL_PRIVATE_ONLY/);assert.deepEqual(await readdir(value.workDirectory),[]);
});
test('a cryptographically valid ACK still requires the exact committed SOURCE audit, time and point outcome',async()=>{
  for(const name of ['receiptAuditId','receiptAt','pointId']){const value=await input(),history=await readHistory(value.context,value.key),raw=options(value,history.history);for(const receipt of raw.acknowledgedReceipts)receipt[name]=name==='receiptAt'?new Date(Date.parse(receipt[name])+1).toISOString():randomUUID();await assert.rejects(inspect(value.bytes,raw,value.key),/COLD_FIELD_SPOOL_UNVERIFIABLE/);assert.deepEqual(await readdir(value.workDirectory),[]);}
});
test('every pending lease body must also exist in authenticated SOURCE issuance history',async()=>{
  const value=await input(),history=await readHistory(value.context,value.key),raw=options(value,history.history),file=join(value.directory,'manifest-copy.sqlite');await writeFile(file,value.bytes,{flag:'wx'});const db=new DatabaseSync(file,{readOnly:true});let lease;
  try{lease=JSON.parse(db.prepare('SELECT payload FROM pending LIMIT 1').get().payload).lease.body;}finally{db.close();}
  raw.sourceLeaseBodies=raw.sourceLeaseBodies.filter(value=>canonical(value)!==canonical(lease));await assert.rejects(inspect(value.bytes,raw,value.key),/COLD_FIELD_SPOOL_UNVERIFIABLE/);assert.deepEqual(await readdir(value.workDirectory),[]);
});
test('caller-provided alternate files, facts, event lists and cross-tenant profiles cannot replace actual SOURCE selection',async()=>{
  const value=await input();for(const extra of [{file:value.map.evidenceFile},{expectedFacts:value.map.facts},{events:value.proof.page.items}])await assert.rejects(readHistory({...value.context,...extra},value.key),/COLD_FIELD_HISTORY_CONTEXT/);
  await assert.rejects(inspectSource(value.bytes,{...sourceOptions(value),tenantId:'acme'},value.key),/COLD_FIELD_SOURCE_SPOOL_UNVERIFIABLE/);assert.deepEqual(await readdir(value.workDirectory),[]);
});
