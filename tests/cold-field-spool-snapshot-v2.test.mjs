import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createHmac,createPublicKey} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {stable} from '../integrations/telemetry.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {inspectColdFieldSpoolSnapshotV1 as inspect} from '../scripts/cold-field-spool-snapshot-v1.mjs';
import {coldFieldMaterialActualInputQaV2 as fixture} from './fixtures/cold-field-material-source-files-v2-input.mjs';

async function input(){
  const value=await fixture(),report=await value.json(join(resolve(process.env.IDMS_COLD_FIELD_MATERIAL_QA_CASE),'field-manager-proofs.private.json'));
  const spool=join(value.directory,'edge-spool'),files=(await readdir(spool)).filter(value=>/^stream-[a-f0-9]{64}\.sqlite$/.test(value));assert.equal(files.length,1);
  const bytes=await readFile(join(spool,files[0])),eventKey=await readFile(join(value.directory,'event.bin')),events=report.page.items.map(value=>value.receipt.envelope),workDirectory=join(value.directory,'snapshot-work');await mkdir(workDirectory);
  return {...value,bytes,key:randomBytes(32),options:{profile:report.profile,contextLease:events[0].lease,eventKey,platformPublicKey:createPublicKey(report.publicKeyPem),acknowledgedEvents:events,capacity:value.edge.spool.capacity,maxBytes:value.edge.spool.maxBytes,workDirectory}};
}
function seal(db,key){
  const metadata=Object.fromEntries(db.prepare('SELECT name,value FROM metadata ORDER BY name').all().map(value=>[value.name,value.value])),{state_mac,...meta}=metadata;
  const mac=createHmac('sha256',key).update('idms:field-spool-state:1\n'+stable(meta)+'\n');
  for(const row of db.prepare('SELECT event_id,sequence_no,payload,digest,state,attempts,last_attempt,reason FROM pending ORDER BY sequence_no').all())mac.update('P'+stable({...row,payload:fieldSha256(row.payload)})+'\n');
  for(const row of db.prepare('SELECT event_id,sequence_no,digest,ack FROM acknowledged ORDER BY sequence_no').all())mac.update('A'+stable({...row,ack:fieldSha256(row.ack)})+'\n');
  db.prepare("UPDATE metadata SET value=? WHERE name='state_mac'").run(mac.digest('hex'));
}
async function mutate(value,change,reSeal=false){
  const file=join(value.directory,'mutation.sqlite');await writeFile(file,value.bytes,{flag:'wx'});const db=new DatabaseSync(file);
  try{db.exec('PRAGMA journal_mode=DELETE');change(db);if(reSeal)seal(db,value.options.eventKey);}finally{db.close();}
  value.bytes=await readFile(file);
}
async function rejected(value){await assert.rejects(inspect(value.bytes,value.options,value.key),/COLD_FIELD_SPOOL_UNVERIFIABLE/);assert.deepEqual(await readdir(value.options.workDirectory),[]);}

test('actual captured main bytes verify all retained events, acknowledged events and state MAC without opening the original spool',async()=>{
  const value=await input(),before=Buffer.from(value.bytes),eventKey=Buffer.from(value.options.eventKey),key=Buffer.from(value.key),proof=await inspect(value.bytes,value.options,value.key);
  assert.equal(proof.evidence.pending,value.options.profile.points.length);assert.equal(proof.evidence.acknowledged,value.options.profile.points.length);assert.equal(proof.evidence.rejected,0);assert(proof.evidence.providedSnapshotStructureAndStateMacVerified&&proof.evidence.allRetainedAcknowledgementSignaturesVerified&&proof.evidence.temporarySnapshotNormallyClosedAndRemoved);
  for(const name of ['sourceAndCurrentHeldBound','currentSqlCommitOrMembershipProven','originalSpoolOpened','completeFieldMaterialsVerified','formalFieldActivationGranted','fullGoalComplete'])assert.equal(proof.evidence[name],false);
  assert.match(proof.fingerprint,/^[a-f0-9]{64}$/);assert.throws(()=>JSON.stringify(proof),/COLD_FIELD_SPOOL_PRIVATE_ONLY/);assert(!JSON.stringify(proof.evidence).includes(value.directory));assert.deepEqual(value.bytes,before);assert.deepEqual(value.key,key);assert.deepEqual(value.options.eventKey,eventKey);assert.deepEqual(await readdir(value.options.workDirectory),[]);
});
test('missing or altered acknowledged history cannot be replaced by a state MAC',async()=>{
  const absent=await input();absent.options.acknowledgedEvents=[];await rejected(absent);
  const altered=await input();altered.options.acknowledgedEvents=structuredClone(altered.options.acknowledgedEvents);altered.options.acknowledgedEvents[0].signature='0'.repeat(64);await rejected(altered);
});
test('pending event signature is verified even when the attacker can reseal the state MAC',async()=>{
  const value=await input();await mutate(value,db=>{const row=db.prepare('SELECT event_id,payload FROM pending LIMIT 1').get(),event=JSON.parse(row.payload);event.signature='0'.repeat(64);db.prepare('UPDATE pending SET payload=? WHERE event_id=?').run(stable(event),row.event_id);},true);await rejected(value);
});
test('ACK signature is verified even when the attacker can reseal the state MAC',async()=>{
  const value=await input();await mutate(value,db=>{const row=db.prepare('SELECT event_id,ack FROM acknowledged LIMIT 1').get(),ack=JSON.parse(row.ack);ack.signature='A'.repeat(86);db.prepare('UPDATE acknowledged SET ack=? WHERE event_id=?').run(stable(ack),row.event_id);},true);await rejected(value);
});
test('state MAC covers attempts and timestamps beyond signed event content',async()=>{
  const value=await input();await mutate(value,db=>db.exec('UPDATE pending SET attempts=attempts+1'));await rejected(value);
});
test('schema, application identity and capacity constraints are mandatory',async()=>{
  const extra=await input();await mutate(extra,db=>db.exec('CREATE TABLE extra (value TEXT)'));await rejected(extra);
  const wrong=await input();await mutate(wrong,db=>db.exec('PRAGMA application_id=1'));await rejected(wrong);
  const small=await input();small.options.capacity=1;await rejected(small);
});
test('binding and last-append sequence remain mandatory after resealing',async()=>{
  const binding=await input();await mutate(binding,db=>db.prepare("UPDATE metadata SET value=? WHERE name='binding_digest'").run('0'.repeat(64)),true);await rejected(binding);
  const last=await input();await mutate(last,db=>{const row=db.prepare("SELECT value FROM metadata WHERE name='last_append'").get(),value=JSON.parse(row.value);value.lastSequence++;db.prepare("UPDATE metadata SET value=? WHERE name='last_append'").run(stable(value));},true);await rejected(last);
});
test('canonical event-row digest correspondence is checked after resealing',async()=>{
  const value=await input();await mutate(value,db=>db.prepare('UPDATE pending SET digest=?').run('0'.repeat(64)),true);await rejected(value);
});
test('valid changed counters change the private fingerprint while keeping source authority unclaimed',async()=>{
  const value=await input(),before=await inspect(value.bytes,value.options,value.key);await mutate(value,db=>db.exec('UPDATE pending SET attempts=attempts+1'),true);const after=await inspect(value.bytes,value.options,value.key);assert.notEqual(after.fingerprint,before.fingerprint);assert.equal(after.evidence.sourceAndCurrentHeldBound,false);assert.deepEqual(await readdir(value.options.workDirectory),[]);
});
test('empty and rejected-only pending states preserve the original storage semantics',async()=>{
  const empty=await input();await mutate(empty,db=>db.exec("DELETE FROM pending;DELETE FROM acknowledged;UPDATE metadata SET value='0' WHERE name='sequence';UPDATE metadata SET value='null' WHERE name='last_append';"),true);const none=await inspect(empty.bytes,empty.options,empty.key);assert.equal(none.evidence.sequence,0);assert.equal(none.evidence.pending+none.evidence.rejected+none.evidence.acknowledged,0);
  const rejectedRows=await input();await mutate(rejectedRows,db=>db.exec("UPDATE pending SET state='REJECTED',reason='FIELD_POLICY_REJECTED'"),true);const proof=await inspect(rejectedRows.bytes,rejectedRows.options,rejectedRows.key);assert.equal(proof.evidence.pending,0);assert.equal(proof.evidence.rejected,rejectedRows.options.profile.points.length);
});
test('invalid database bytes retire every owned temporary file normally',async()=>{const value=await input();value.bytes=Buffer.alloc(512);await rejected(value);});
test('caller callbacks and invalid event keys cannot manufacture a review capability',async()=>{
  const callback=await input();callback.options.authorize=()=>({approved:true});await assert.rejects(inspect(callback.bytes,callback.options,callback.key),/COLD_FIELD_SPOOL_CONTEXT/);
  const key=await input();key.options.eventKey=randomBytes(32);await rejected(key);
});
