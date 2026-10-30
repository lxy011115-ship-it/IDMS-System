import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,readdir,mkdir,rename} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomBytes,createPublicKey,createHmac} from 'node:crypto';
import {stable} from '../integrations/telemetry.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {fieldStreamBinding,fieldStreamId} from '../integrations/field-event.ts';
import {coldFieldSourceStreamBindingV1 as derive} from '../scripts/cold-field-source-stream-binding-v1.mjs';
import {readColdFieldSourceHistoryV1} from '../scripts/cold-field-source-history-v1.mjs';
import {readColdFieldSourceHistoryV2,assertColdFieldSourceHistoryV2} from '../scripts/cold-field-source-history-v2.mjs';
import {inspectColdFieldSpoolSnapshotV3 as inspect} from '../scripts/cold-field-spool-snapshot-v3.mjs';
import {loadColdFieldDeploymentMaterialFilesV3 as load} from '../scripts/cold-field-deployment-material-files-v3.mjs';
import {coldFieldDeploymentFilesActualInputQaV1 as fixture} from './fixtures/cold-field-deployment-files-v1-input.mjs';

async function input(disabled=false){
  const value=await fixture({disabled}),workDirectory=join(value.directory,'spool-inspection-work');await mkdir(workDirectory);const context={...value.context,workDirectory};
  const proof=await value.json(join(resolve(process.env.IDMS_COLD_FIELD_MATERIAL_QA_CASE),'field-manager-proofs.private.json')),publicKey=createPublicKey(proof.publicKeyPem),eventKey=await readFile(join(value.directory,'event.bin')),spool=join(value.directory,'edge-spool'),name=(await readdir(spool)).find(value=>/^stream-[a-f0-9]{64}\.sqlite$/.test(value));assert(name);
  return {...value,context,proof,publicKey,eventKey,spool,name,streamId:name.slice(7,-7),file:join(spool,name),key:randomBytes(32)};
}
const historyContext=value=>({trust:value.context.trust,tenantId:'sandbox',publicKeys:[value.publicKey],workDirectory:value.context.workDirectory});
function seal(db,key){
  const metadata=Object.fromEntries(db.prepare('SELECT name,value FROM metadata ORDER BY name').all().map(value=>[value.name,value.value])),{state_mac,...meta}=metadata,mac=createHmac('sha256',key).update('idms:field-spool-state:1\n'+stable(meta)+'\n');
  for(const row of db.prepare('SELECT event_id,sequence_no,payload,digest,state,attempts,last_attempt,reason FROM pending ORDER BY sequence_no').all())mac.update('P'+stable({...row,payload:fieldSha256(row.payload)})+'\n');
  for(const row of db.prepare('SELECT event_id,sequence_no,digest,ack FROM acknowledged ORDER BY sequence_no').all())mac.update('A'+stable({...row,ack:fieldSha256(row.ack)})+'\n');db.prepare("UPDATE metadata SET value=? WHERE name='state_mac'").run(mac.digest('hex'));
}
async function mutate(value,change){const db=new DatabaseSync(value.file);try{db.exec('PRAGMA journal_mode=DELETE');change(db);seal(db,value.eventKey);}finally{db.close();}}
async function historical(value){
  const profileFile=join(value.directory,'historical-public-profile.json');await value.save(profileFile,value.proof.profile);value.descriptor.format='idms-cold-field-deployment-materials-v2';value.descriptor.historicalStreamMaterials=[{tenantId:'sandbox',edgeId:value.proof.profile.source.edgeId,streamId:value.streamId,profileFile,eventKeyFile:join(value.directory,'event.bin'),platformPublicKeyFile:resolve(dirname(value.edgeFile),value.edge.lease.platformPublicKeyFile)}];await value.save(value.configurationFile,value.descriptor);return value.descriptor.historicalStreamMaterials[0];
}

test('SOURCE issuance-only stream projection is exactly the original signed stream binding for every actual event',async()=>{
  const value=await input();for(const item of value.proof.page.items){const event=item.receipt.envelope,actual=derive(value.proof.profile,event.lease.body,value.publicKey),expected=fieldStreamBinding(value.proof.profile,event.lease,value.publicKey);assert.deepEqual(actual.binding,expected);assert.equal(actual.streamId,fieldStreamId(expected));}
  assert.throws(()=>derive(value.proof.profile,{...value.proof.page.items[0].receipt.envelope.lease.body,tenantId:'acme'},value.publicKey),/COLD_FIELD_SOURCE_STREAM_BINDING/);
});
test('provided-body primitive verifies an empty snapshot without a context signed lease or any ACK, with no SOURCE authority claim',async()=>{
  const value=await input();await mutate(value,db=>db.exec("DELETE FROM pending;DELETE FROM acknowledged;UPDATE metadata SET value='0' WHERE name='sequence';UPDATE metadata SET value='null' WHERE name='last_append';"));
  const result=await inspect(await readFile(value.file),{profile:value.proof.profile,streamId:value.streamId,eventKey:value.eventKey,platformPublicKey:value.publicKey,acknowledgedEvents:[],acknowledgedReceipts:[],sourceLeaseBodies:[value.proof.page.items[0].receipt.envelope.lease.body],capacity:value.edge.spool.capacity,maxBytes:value.edge.spool.maxBytes,workDirectory:value.context.workDirectory},value.key);
  assert.equal(result.evidence.sequence,0);assert.equal(result.evidence.pending+result.evidence.acknowledged,0);assert(result.evidence.streamBindingDerivedFromProvidedIssuanceBodyWithoutContextSignature);assert.equal(result.evidence.sourceAndCurrentHeldBound,false);assert.deepEqual(await readdir(value.context.workDirectory),[]);
});
test('whole captured file graph now binds every spool stream to actual SOURCE history and includes that proof in its private MAC',async()=>{
  const value=await input();let result;try{result=await load(value.configurationFile,value.context,value.key);assert(result.evidence.offlineSpoolSemanticsVerified&&result.evidence.allCapturedSpoolStreamsBoundToSourceHistory);assert.equal(result.evidence.spoolStreamsVerified,1);assert.equal(result.spoolProofs[0].evidence.pending,value.proof.profile.points.length);assert.equal(result.spoolProofs[0].evidence.acknowledged,value.proof.profile.points.length);assert(result.spoolProofs[0].evidence.spoolSequenceNotBehindSourceCommittedHistory);assert.equal(result.evidence.emptyWalIdentityWitnesses,1);for(const name of ['currentHeldSessionVerified','currentTargetSqlAndIdentityVerified','actualTransportObserved','brokerTopicAclVerified','actualStartupProgramsApproved','completeFieldMaterialsVerified','formalFieldActivationGranted','fullGoalComplete'])assert.equal(result.evidence[name],false);assert.throws(()=>JSON.stringify(result),/COLD_FIELD_DEPLOYMENT_PRIVATE_ONLY/);assert.deepEqual(await readdir(value.context.workDirectory),[]);}finally{result?.clear();}
});
test('no-ACK streams still verify actual SOURCE issuances, pending signatures and complete history',async()=>{
  const value=await input();await mutate(value,db=>db.exec('DELETE FROM acknowledged'));let result;try{result=await load(value.configurationFile,value.context,value.key);assert.equal(result.spoolProofs[0].evidence.acknowledged,0);assert.equal(result.spoolProofs[0].evidence.pending,value.proof.profile.points.length);assert(result.spoolProofs[0].evidence.streamBindingDerivedFromActualSourceIssuanceAndRegistry);assert.equal(result.spoolProofs[0].evidence.contextSignedLeaseOrAckRequiredForBinding,false);}finally{result?.clear();}
});
test('an empty rollback behind committed SOURCE events or an unissued stream filename is rejected',async()=>{
  const rollback=await input();await mutate(rollback,db=>db.exec("DELETE FROM pending;DELETE FROM acknowledged;UPDATE metadata SET value='0' WHERE name='sequence';UPDATE metadata SET value='null' WHERE name='last_append';"));await assert.rejects(load(rollback.configurationFile,rollback.context,rollback.key),/COLD_FIELD_DEPLOYMENT_UNVERIFIABLE/);
  const unknown=await input(),replacement='stream-'+'0'.repeat(64)+'.sqlite';for(const entry of await readdir(unknown.spool))if(entry.startsWith(unknown.name))await rename(join(unknown.spool,entry),join(unknown.spool,replacement+entry.slice(unknown.name.length)));await assert.rejects(load(unknown.configurationFile,unknown.context,unknown.key),/COLD_FIELD_DEPLOYMENT_UNVERIFIABLE/);
});
test('historical material descriptors must match authenticated SOURCE profiles and stream IDs',async()=>{
  const value=await input();await historical(value);let result;try{result=await load(value.configurationFile,value.context,value.key);assert.equal(result.evidence.historicalStreamMaterialSets,1);assert(result.evidence.offlineSpoolSemanticsVerified);}finally{result?.clear();}
  const wrong=await input(),entry=await historical(wrong);entry.streamId='0'.repeat(64);await wrong.save(wrong.configurationFile,wrong.descriptor);await assert.rejects(load(wrong.configurationFile,wrong.context,wrong.key),/COLD_FIELD_DEPLOYMENT_HISTORICAL_SOURCE_STREAM/);
});
test('historical event-key bytes must match the authenticated public profile',async()=>{
  const value=await input(),entry=await historical(value),file=join(value.directory,'wrong-historical-event.bin');await writeFile(file,randomBytes(32),{flag:'wx'});entry.eventKeyFile=file;await value.save(value.configurationFile,value.descriptor);await assert.rejects(load(value.configurationFile,value.context,value.key),/COLD_FIELD_DEPLOYMENT_HISTORICAL_KEYS/);
});
test('one actual immutable history owner can be reused, while copied, old-version and closed owners are rejected',async()=>{
  const value=await input(),context=historyContext(value),owner=await readColdFieldSourceHistoryV2(context,value.key);assert.equal(assertColdFieldSourceHistoryV2(owner,{trust:value.context.trust,tenantId:'sandbox'}),owner);assert.throws(()=>owner.history.issuances.push({}),TypeError);assert.throws(()=>{owner.history.events[0].receipt.auditEventId='changed';},TypeError);assert.throws(()=>assertColdFieldSourceHistoryV2({...owner},{trust:value.context.trust,tenantId:'sandbox'}),/COLD_FIELD_HISTORY_ORIGINAL_OWNER/);
  const old=await readColdFieldSourceHistoryV1(context,value.key);assert.throws(()=>assertColdFieldSourceHistoryV2(old,{trust:value.context.trust,tenantId:'sandbox'}),/COLD_FIELD_HISTORY_ORIGINAL_OWNER/);owner.close();assert.throws(()=>assertColdFieldSourceHistoryV2(owner,{trust:value.context.trust,tenantId:'sandbox'}),/COLD_FIELD_HISTORY_ORIGINAL_OWNER/);assert.deepEqual(await readdir(value.context.workDirectory),[]);
});
test('actual explicit-disabled whole SOURCE retains its declared mode and no current authority claim',async()=>{
  const value=await input(true);let result;try{result=await load(value.configurationFile,value.context,value.key);assert.equal(result.sourceBinding.siteFieldEnabled,false);assert.equal(result.evidence.spoolStreamsVerified,0);assert.equal(result.evidence.completeFieldMaterialsVerified,false);}finally{result?.clear();}
});
test('inspection work cannot be placed inside a captured spool directory',async()=>{
  const value=await input(),workDirectory=join(value.spool,'inspection');await mkdir(workDirectory);await assert.rejects(load(value.configurationFile,{...value.context,workDirectory},value.key),/COLD_FIELD_DEPLOYMENT_/);
});
