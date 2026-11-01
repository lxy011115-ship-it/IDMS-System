import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,truncateSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {EdgeSpool} from '../services/edge/spool.ts';
import {proposeSpoolRecovery,recoverStoppedSpool} from '../services/edge/spool-maintenance.ts';
import {spoolRecoveryLimits,requireQuarantineSpace,quarantineBytes,spoolStorage} from '../services/edge/spool-v2.ts';
import {signAck,signEvent,sha,type EdgeSource} from '../integrations/telemetry.ts';
import {exportQuarantine,verifyQuarantineExport} from '../services/edge/spool-export.ts';
const source:EdgeSource={tenantId:'sandbox',edgeId:'qa-edge-recovery',deviceCode:'SIM-01',origin:'SIMULATOR',mapVersion:'1',signingKey:'s'.repeat(64),acknowledgementKey:'a'.repeat(64),statusKey:'h'.repeat(64),statusUrl:'http://127.0.0.1:9/status',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',unit:'mm/s'}]};
const sample=()=>({tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',eventTime:new Date().toISOString(),value:2,unit:'mm/s',quality:'GOOD' as const});
async function fixture(run:(f:{dir:string;path:string;proposal:ReturnType<typeof proposeSpoolRecovery>;original:any[]})=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'idms-spool-recovery-')),path=join(dir,'edge.sqlite');
 try{const old=new EdgeSpool(path,source);old.append(sample());old.append(sample());old.attempted(old.ready()[0].event_id);const original=old.db.prepare('SELECT * FROM pending ORDER BY event_id').all();old.close();const proposal=proposeSpoolRecovery(path,source,75118,'a'.repeat(64));await run({dir,path,proposal,original});}finally{rmSync(dir,{recursive:true,force:true});}
}
test('explicit recovery backs up/restores original records and advances only the future allocator',async()=>fixture(async f=>{
 let proofs=0;const result=await recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{proofs++;}});
 assert.equal(proofs,2);assert.equal(result.replayed,false);assert.equal(result.receipt.beforeSequence,2);assert.equal(result.receipt.afterSequence,75118);
 for(const p of [result.backupPath!,result.restorePath!]){const db=new DatabaseSync(p,{readOnly:true});try{assert.deepEqual(db.prepare('SELECT * FROM pending ORDER BY event_id').all(),f.original);assert.equal(db.prepare("SELECT value FROM metadata WHERE name='sequence'").get()?.value,'2');}finally{db.close();}}
 const spool=new EdgeSpool(f.path,source,10000,{existingOnly:true});try{
  assert.deepEqual(spool.db.prepare('SELECT * FROM pending ORDER BY event_id').all(),f.original);assert.equal(spool.append(sample()).sequenceNo,75119);
 }finally{spool.close();}
 const again=await recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}});assert.equal(again.replayed,true);assert.deepEqual(again.receipt,result.receipt);
 assert.throws(()=>new EdgeSpool(f.path,{...source,signingKey:'x'.repeat(64)},10000,{existingOnly:true}),/RECEIPT_INVALID/);
}));
test('only exact signed rejection with original ACK wire atomically quarantines original bytes',async()=>fixture(async f=>{
 await recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}});const spool=new EdgeSpool(f.path,source,10000,{existingOnly:true});
 try{
  const row=f.original[0],ack=signAck({version:1,eventId:row.event_id,tenantId:source.tenantId,edgeId:source.edgeId,digest:row.digest,status:'REJECTED',reason:'SEQUENCE_CONFLICT'},source.acknowledgementKey),wire=Buffer.from('  '+JSON.stringify(ack)+'\n');
  const {signature,...ackData}=ack;
  assert.equal(spool.acknowledge({...ack,signature:'0'.repeat(64)},wire),false);
  assert.equal(spool.acknowledge(signAck({...ackData,digest:'0'.repeat(64)},source.acknowledgementKey),wire),false);
  assert.throws(()=>spool.acknowledge(ack),/ORIGINAL_WIRE/);
  assert.throws(()=>spool.acknowledge(ack,Buffer.from(JSON.stringify({...ack,reason:'OTHER'}))),/WIRE_MISMATCH/);
  assert.throws(()=>spool.acknowledge(ack,Buffer.alloc(8193,32)),/WIRE_LIMIT/);assert.equal(spool.stats().pending,2);
  spool.db.prepare('UPDATE pending SET payload=? WHERE event_id=?').run(row.payload.replace('"value":2','"value":3'),row.event_id);assert.throws(()=>spool.acknowledge(ack,wire),/ORIGINAL_INVALID/);spool.db.prepare('UPDATE pending SET payload=? WHERE event_id=?').run(row.payload,row.event_id);
  assert.equal(spool.acknowledge(ack,wire),true);assert.equal(spool.acknowledge(ack,wire),false);assert.equal(spool.stats().pending,1);
  const q=spool.db.prepare('SELECT * FROM quarantine').get() as any;
  assert.equal(q.payload,row.payload);assert.equal(q.digest,row.digest);assert.equal(q.ack_payload,wire.toString());assert.equal(q.prior_state,row.state);assert.equal(q.attempts,row.attempts);assert.equal(q.last_attempt,row.last_attempt);assert.equal(q.prior_reason,row.reason);assert.equal(q.reason,'SEQUENCE_CONFLICT');assert.equal(q.logical_bytes,quarantineBytes(q));
  // Roll back a failure after quarantine insert but before pending removal.
  spool.db.exec("CREATE TRIGGER qa_reject_delete BEFORE DELETE ON pending BEGIN SELECT RAISE(ABORT,'QA_DELETE_FAILURE'); END");
  const second=f.original[1],ack2=signAck({...ackData,eventId:second.event_id,digest:second.digest},source.acknowledgementKey);
  assert.throws(()=>spool.acknowledge(ack2,Buffer.from(JSON.stringify(ack2))),/QA_DELETE_FAILURE/);
  assert.equal(spool.stats().pending,1);assert.equal(spool.db.prepare('SELECT count(*) AS n FROM quarantine').get()?.n,1);
  spool.db.exec('DROP TRIGGER qa_reject_delete');
  const stored=signAck({...ackData,eventId:second.event_id,digest:second.digest,status:'STORED'},source.acknowledgementKey);assert.equal(spool.acknowledge(stored),true);assert.equal(spool.stats().acknowledged,1);
 }finally{spool.close();}
}));
test('recovery refuses active writers, stale proposal, exhausted sequence and wrong source before mutation',async()=>fixture(async f=>{
 const before=readFileSync(f.path);await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{throw Error('WRITER_LIVE');}}),/WRITER_LIVE/);assert.deepEqual(readFileSync(f.path),before);
 await assert.rejects(recoverStoppedSpool(f.path,{...source,edgeId:'wrong'},f.proposal,{directory:f.dir,assertStopped:async()=>{}}),/PROPOSAL_INVALID/);
 assert.throws(()=>proposeSpoolRecovery(f.path,source,Number.MAX_SAFE_INTEGER,'a'.repeat(64)),/EXHAUSTED/);
 const old=new EdgeSpool(f.path,source);old.append(sample());old.close();await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}}),/PROPOSAL_STALE/);
 const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,0);assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='quarantine'").get()?.n,0);}finally{db.close();}
}));
test('ordinary existing-only reopen makes no DDL or cursor repair and refuses incomplete v2 schema',async()=>fixture(async f=>{
 const old=new EdgeSpool(f.path,source,10000,{existingOnly:true});assert.equal(old.stats().sequence,2);assert.equal(old.version,0);old.close();
 const db=new DatabaseSync(f.path);db.exec('PRAGMA user_version=2');db.close();assert.throws(()=>new EdgeSpool(f.path,source,10000,{existingOnly:true}),/SCHEMA_MISMATCH/);
}));
test('quarantine count and UTF-8 byte budgets reject the next record at either boundary',()=>{
 requireQuarantineSpace(9999,0,1);assert.throws(()=>requireQuarantineSpace(10000,0,1),/QUARANTINE_LIMIT/);
 requireQuarantineSpace(0,spoolRecoveryLimits.logicalBytes-1,1);assert.throws(()=>requireQuarantineSpace(0,spoolRecoveryLimits.logicalBytes,1),/QUARANTINE_LIMIT/);
 assert.throws(()=>requireQuarantineSpace(-1,0,1),/QUARANTINE_LIMIT/);
});
test('observed database and WAL thresholds are independent of the logical quarantine allowance',()=>{
 const dir=mkdtempSync(join(tmpdir(),'idms-spool-storage-')),path=join(dir,'owned-size-fixture');try{
  writeFileSync(path,'');writeFileSync(path+'-wal','');assert.equal(spoolStorage(path).storageBlocked,false);
  truncateSync(path,spoolRecoveryLimits.databaseBytes);assert.equal(spoolStorage(path).storageBlocked,true);
  truncateSync(path,0);truncateSync(path+'-wal',spoolRecoveryLimits.walBytes);assert.equal(spoolStorage(path).storageBlocked,true);
 }finally{rmSync(dir,{recursive:true});}
});
test('protected export retains exact wire and independently rejects altered, truncated and forged manifests',async()=>fixture(async f=>{
 await recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}});
 const spool=new EdgeSpool(f.path,source,10000,{existingOnly:true});try{for(const row of f.original){const ack=signAck({version:1,eventId:row.event_id,tenantId:source.tenantId,edgeId:source.edgeId,digest:row.digest,status:'REJECTED',reason:'SEQUENCE_CONFLICT'},source.acknowledgementKey);spool.acknowledge(ack,Buffer.from(' '+JSON.stringify(ack)+'\n'));}}finally{spool.close();}
 const path=join(f.dir,'private-export.ndjson'),proof=exportQuarantine(f.path,source,path),verified=verifyQuarantineExport(path,source);assert.equal(verified.records,2);assert.equal(verified.digest,proof.digest);
 const original=readFileSync(path,'utf8');assert.equal(original.includes(source.signingKey),false);assert.equal(original.includes(source.acknowledgementKey),false);
 const records=original.trimEnd().split('\n');assert.equal(JSON.parse(records[1]).payload,f.original[0].payload);
 writeFileSync(path,original.replace('SEQUENCE_CONFLICT','OTHER_CONFLICT'));assert.throws(()=>verifyQuarantineExport(path,source));
 writeFileSync(path,records.slice(0,-1).join('\n')+'\n');assert.throws(()=>verifyQuarantineExport(path,source),/INTEGRITY_FAILED/);
 const footer=JSON.parse(records.at(-1)!);footer.signature='0'.repeat(64);writeFileSync(path,[...records.slice(0,-1),JSON.stringify(footer)].join('\n')+'\n');assert.throws(()=>verifyQuarantineExport(path,source),/SIGNATURE_INVALID/);
 writeFileSync(path,original);assert.throws(()=>verifyQuarantineExport(path,{...source,acknowledgementKey:'z'.repeat(64)}),/HEADER_INVALID/);assert.throws(()=>exportQuarantine(f.path,source,path),/EEXIST/);
}));
test('10000 original events survive signed rejection transfer; full quarantine leaves the next original pending',async()=>fixture(async f=>{
 const seed=new EdgeSpool(f.path,source);seed.db.exec('BEGIN IMMEDIATE');try{
  const insert=seed.db.prepare('INSERT INTO pending(event_id,payload,digest) VALUES(?,?,?)');
  for(let sequenceNo=3;sequenceNo<=10000;sequenceNo++){const e=signEvent({version:1,eventId:randomUUID(),tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion,sequenceNo,...sample()},source.signingKey);insert.run(e.eventId,JSON.stringify(e),sha(e));}
  seed.db.prepare("UPDATE metadata SET value='10000' WHERE name='sequence'").run();seed.db.exec('COMMIT');
 }catch(e){seed.db.exec('ROLLBACK');throw e;}
 const originals=seed.db.prepare('SELECT * FROM pending ORDER BY event_id').all() as any[];seed.close();
 const proposal=proposeSpoolRecovery(f.path,source,75118,'a'.repeat(64));await recoverStoppedSpool(f.path,source,proposal,{directory:f.dir,assertStopped:async()=>{}});
 const spool=new EdgeSpool(f.path,source,10000,{existingOnly:true});try{
  const h=createHash('sha256');for(const row of originals){h.update(JSON.stringify(row)+'\n');const a=signAck({version:1,eventId:row.event_id,tenantId:source.tenantId,edgeId:source.edgeId,digest:row.digest,status:'REJECTED',reason:'SEQUENCE_CONFLICT'},source.acknowledgementKey);assert.equal(spool.acknowledge(a,Buffer.from(JSON.stringify(a))),true);}
  const actual=createHash('sha256');for(const row of spool.db.prepare('SELECT event_id,payload,digest,prior_state AS state,attempts,last_attempt,prior_reason AS reason FROM quarantine ORDER BY event_id').iterate())actual.update(JSON.stringify(row)+'\n');assert.equal(actual.digest('hex'),h.digest('hex'));assert.equal(spool.stats().pending,0);assert.equal(spool.stats().records,10000);assert.equal(spool.stats().quarantineBlocked,true);
  const next=spool.append(sample());assert.equal(next.sequenceNo,75119);const a=signAck({version:1,eventId:next.eventId,tenantId:source.tenantId,edgeId:source.edgeId,digest:sha(next),status:'REJECTED',reason:'TEST'},source.acknowledgementKey);assert.throws(()=>spool.acknowledge(a,Buffer.from(JSON.stringify(a))),/QUARANTINE_LIMIT/);assert.equal(spool.stats().pending,1);assert.equal(spool.stats().records,10000);
 }finally{spool.close();}
}));
test('interrupted reserved backup is retained and resumes into a new bounded owned generation',async()=>fixture(async f=>{
 let partial='';await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{},onCheckpoint:e=>{if(e.stage==='BACKUP_RESERVED'){partial=e.path;throw Error('QA_INTERRUPTED_AFTER_RESERVATION');}}}),/QA_INTERRUPTED/);
 assert.equal(statSync(partial).size,0);const result=await recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}});assert.notEqual(result.backupPath,partial);assert.match(result.backupPath!,/attempt-2/);assert.equal(statSync(partial).size,0);assert.equal(result.receipt.originalCount,2);
}));
test('verified backup is reused after interruption and a changed completed artifact never falls back',async()=>fixture(async f=>{
 let backup='';await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{},onCheckpoint:e=>{if(e.stage==='BACKUP_VERIFIED'){backup=e.path;throw Error('QA_INTERRUPTED_AFTER_BACKUP');}}}),/QA_INTERRUPTED/);
 const original=statSync(backup);const db=new DatabaseSync(backup);db.prepare("UPDATE metadata SET value='999' WHERE name='sequence'").run();db.close();
 await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}}),/COMPLETED_ARTIFACT_INVALID/);assert.equal(statSync(backup).ino,original.ino);assert.equal(readdirSync(f.dir).filter(n=>n.endsWith('.backup.sqlite')).length,1);assert.equal(readdirSync(f.dir).filter(n=>n.endsWith('.restore-check.sqlite')).length,0);
 const current=new EdgeSpool(f.path,source,10000,{existingOnly:true});try{assert.equal(current.version,0);assert.deepEqual(current.db.prepare('SELECT * FROM pending ORDER BY event_id').all(),f.original);}finally{current.close();}
}));
test('completed SQLite commit with lost caller result resolves from the same receipt without repeating migration',async()=>fixture(async f=>{
 let backup='',digest='';await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{},onCheckpoint:e=>{if(e.stage==='BACKUP_VERIFIED'){backup=e.path;digest=e.digest!;}if(e.stage==='SQLITE_COMMITTED')throw Error('QA_CALLER_RESULT_LOST');}}),/QA_CALLER_RESULT_LOST/);
 const original=readFileSync(backup),result=await recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}});assert.equal(result.replayed,true);assert.equal(result.receipt.backupDigest,digest);assert.deepEqual(readFileSync(backup),original);assert.equal(readdirSync(f.dir).filter(n=>n.endsWith('.backup.sqlite')).length,1);
}));
test('verified backup and restore are reused byte-for-byte after a pre-migration interruption',async()=>fixture(async f=>{
 let backup='',restore='';await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{},onCheckpoint:e=>{if(e.stage==='BACKUP_VERIFIED')backup=e.path;if(e.stage==='RESTORE_VERIFIED'){restore=e.path;throw Error('QA_INTERRUPTED_BEFORE_MIGRATION');}}}),/QA_INTERRUPTED/);
 const b=readFileSync(backup),r=readFileSync(restore),bi=statSync(backup).ino,ri=statSync(restore).ino;const result=await recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}});assert.equal(result.backupPath,backup);assert.equal(result.restorePath,restore);assert.equal(statSync(backup).ino,bi);assert.equal(statSync(restore).ino,ri);assert.deepEqual(readFileSync(backup),b);assert.deepEqual(readFileSync(restore),r);
}));
test('three incomplete artifacts remain visible and cannot cause unbounded retry copies',async()=>fixture(async f=>{
 for(let i=0;i<3;i++)await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{},onCheckpoint:e=>{if(e.stage==='BACKUP_RESERVED')throw Error('QA_INTERRUPTED');}}),/QA_INTERRUPTED/);
 await assert.rejects(recoverStoppedSpool(f.path,source,f.proposal,{directory:f.dir,assertStopped:async()=>{}}),/PARTIAL_ARTIFACT_REVIEW_REQUIRED/);assert.equal(readdirSync(f.dir).filter(n=>n.endsWith('.backup.sqlite')).length,3);
}));
