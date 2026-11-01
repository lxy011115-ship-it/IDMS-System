import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync,statfsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {authenticEvent,sha,stable,type EdgeSource} from '../../integrations/telemetry.ts';
import {openExistingSqlite,validateExistingSqlite} from '../existing-sqlite.ts';
import {spoolVersion,spoolV2Definitions,readSpoolReceipt,spoolSourceDigest,spoolKeyDigest,spoolStorage,spoolRecoveryLimits,type PendingSpoolRow,type SpoolMigrationReceipt} from './spool-v2.ts';
import {ensureSpoolIntent,verifiedSpoolCopy,spoolCheckpoint,type SpoolCheckpointObserver} from './spool-backup-artifact.ts';

export interface SpoolProposal {
 format:'IDMS_EDGE_RECOVERY_PROPOSAL_V2';operationId:string;path:string;device:number;inode:number;
 sourceDigest:string;keyDigest:string;postgresDigest:string;durableSequence:number;
 beforeSequence:number;afterSequence:number;originalCount:number;originalDigest:string;
 databaseBytes:number;walBytes:number;
}
function requirePath(path:string){const p=resolve(path),s=lstatSync(p);if(p!==realpathSync(p)||!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('SPOOL_EXACT_REGULAR_FILE_REQUIRED');return {path:p,device:s.dev,inode:s.ino};}
function requireSpace(path:string){const s=statfsSync(path);if(s.bavail*s.bsize<spoolRecoveryLimits.freeBytes)throw Error('SPOOL_RECOVERY_FREE_SPACE_REQUIRED');}
function snapshot(db:DatabaseSync,source:EdgeSource){
 const hash=createHash('sha256');let count=0,maximum=0;
 for(const row of db.prepare('SELECT * FROM pending ORDER BY event_id').iterate() as IterableIterator<PendingSpoolRow>){
  if(++count>10000||Buffer.byteLength(row.payload)>8192||!(row.reason===null||typeof row.reason==='string'&&Buffer.byteLength(row.reason)<=8192)||!['PENDING','REJECTED'].includes(row.state)||!Number.isSafeInteger(row.attempts)||row.attempts<0||!Number.isSafeInteger(row.last_attempt)||row.last_attempt<0)throw Error('SPOOL_RECOVERY_INPUT_LIMIT');
  const event=JSON.parse(row.payload);
  if(!authenticEvent(event,source.signingKey)||sha(event)!==row.digest||event.eventId!==row.event_id||event.tenantId!==source.tenantId||event.edgeId!==source.edgeId||event.deviceCode!==source.deviceCode||event.mapVersion!==source.mapVersion||!Number.isSafeInteger(event.sequenceNo)||event.sequenceNo<1)throw Error('SPOOL_RECOVERY_ORIGINAL_INVALID');
  maximum=Math.max(maximum,event.sequenceNo);hash.update(stable(row)+'\n');
 }
 // Also bind successful acknowledgements; migration must not rewrite them.
 let acknowledgements=0;for(const row of db.prepare('SELECT * FROM acknowledged ORDER BY event_id').iterate()){if(++acknowledgements>1000000)throw Error('SPOOL_RECOVERY_INPUT_LIMIT');hash.update(stable(row)+'\n');}
 const sequence=Number((db.prepare("SELECT value FROM metadata WHERE name='sequence'").get() as {value:string}).value);
 return {count,maximum,sequence,digest:hash.digest('hex')};
}
export function proposeSpoolRecovery(path:string,source:EdgeSource,durableSequence:number,postgresDigest:string,operationId:string=randomUUID()):SpoolProposal{
 if(!Number.isSafeInteger(durableSequence)||durableSequence<0||!/^[a-f0-9]{64}$/.test(postgresDigest)||!/^[a-f0-9-]{36}$/.test(operationId))throw Error('SPOOL_RECOVERY_AUTHORITY_INVALID');
 const identity=requirePath(path);if(spoolStorage(identity.path).storageBlocked)throw Error('SPOOL_STORAGE_LIMIT');
 const db=openExistingSqlite(path,'edge',source,{readOnly:true});
 try{
  if(spoolVersion(db)!==0)throw Error('SPOOL_RECOVERY_ALREADY_VERSIONED');
  db.exec('BEGIN');const state=snapshot(db,source),storage=spoolStorage(identity.path);
  if(storage.storageBlocked)throw Error('SPOOL_STORAGE_LIMIT');
  const afterSequence=Math.max(state.sequence,state.maximum,durableSequence);if(afterSequence>=Number.MAX_SAFE_INTEGER)throw Error('SPOOL_SEQUENCE_EXHAUSTED');
  return {format:'IDMS_EDGE_RECOVERY_PROPOSAL_V2',operationId,...identity,sourceDigest:spoolSourceDigest(source),keyDigest:spoolKeyDigest(source),postgresDigest,durableSequence,beforeSequence:state.sequence,afterSequence,originalCount:state.count,originalDigest:state.digest,databaseBytes:storage.databaseBytes,walBytes:storage.walBytes};
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
// Physical sizes are observations, not logical identity: SQLite recovery or a
// checkpoint may change them after an interrupted transaction without changing
// a single original record. The physical pause limits are rechecked separately.
const sameProposal=(a:SpoolProposal,b:SpoolProposal)=>{const {databaseBytes:ad,walBytes:aw,...left}=a,{databaseBytes:bd,walBytes:bw,...right}=b;return stable(left)===stable(right);};
function checkBackup(db:DatabaseSync,source:EdgeSource,proposal:SpoolProposal){
 validateExistingSqlite(db,'edge',source);
 if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('SPOOL_BACKUP_INTEGRITY_FAILED');
 const s=snapshot(db,source);if(s.digest!==proposal.originalDigest||s.count!==proposal.originalCount||s.sequence!==proposal.beforeSequence)throw Error('SPOOL_BACKUP_STATE_MISMATCH');
}
/** Explicit maintenance primitive. Caller MUST hold the deployment start/stop
 * coordinator and prove all original writers terminal in assertStopped. No
 * ordinary startup path imports or invokes this function. */
export async function recoverStoppedSpool(path:string,source:EdgeSource,proposal:SpoolProposal,options:{directory:string;assertStopped:()=>Promise<void>;onCheckpoint?:SpoolCheckpointObserver}):Promise<{receipt:SpoolMigrationReceipt;replayed:boolean;backupPath?:string;restorePath?:string}>{
 if(typeof options.assertStopped!=='function'||proposal.format!=='IDMS_EDGE_RECOVERY_PROPOSAL_V2'||proposal.path!==resolve(path)||spoolSourceDigest(source)!==proposal.sourceDigest||spoolKeyDigest(source)!==proposal.keyDigest)throw Error('SPOOL_RECOVERY_PROPOSAL_INVALID');
 const identity=requirePath(path);if(identity.device!==proposal.device||identity.inode!==proposal.inode)throw Error('SPOOL_RECOVERY_FILE_CHANGED');
 await options.assertStopped();
 let existing=openExistingSqlite(path,'edge',source,{readOnly:true});
 try{
  if(spoolVersion(existing)===2){const receipt=readSpoolReceipt(existing,source);if(receipt.operationId!==proposal.operationId||receipt.originalDigest!==proposal.originalDigest||receipt.postgresDigest!==proposal.postgresDigest||receipt.afterSequence!==proposal.afterSequence)throw Error('SPOOL_RECOVERY_OPERATION_CONFLICT');return {receipt,replayed:true};}
 }finally{existing.close();}
 requireSpace(path);if(!sameProposal(proposal,proposeSpoolRecovery(path,source,proposal.durableSequence,proposal.postgresDigest,proposal.operationId)))throw Error('SPOOL_RECOVERY_PROPOSAL_STALE');
 const directory=resolve(options.directory);if(directory!==realpathSync(directory)||!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())throw Error('SPOOL_BACKUP_DIRECTORY_INVALID');requireSpace(directory);
 ensureSpoolIntent(directory,proposal.operationId,proposal);
 const copyOptions={directory,operationId:proposal.operationId,check:(db:DatabaseSync)=>checkBackup(db,source,proposal),onCheckpoint:options.onCheckpoint};
 let backupResult;existing=openExistingSqlite(path,'edge',source,{readOnly:true});try{backupResult=await verifiedSpoolCopy(existing,'backup',copyOptions);}finally{existing.close();}
 requireSpace(directory);const saved=new DatabaseSync(backupResult.path,{readOnly:true});let restoreResult;
 try{restoreResult=await verifiedSpoolCopy(saved,'restore-check',copyOptions);}finally{saved.close();}
 const backupPath=backupResult.path,restorePath=restoreResult.path,backupDigest=backupResult.digest;
 await options.assertStopped();requireSpace(path);
 if(!sameProposal(proposal,proposeSpoolRecovery(path,source,proposal.durableSequence,proposal.postgresDigest,proposal.operationId)))throw Error('SPOOL_RECOVERY_PROPOSAL_STALE');
 const receipt:SpoolMigrationReceipt={format:'IDMS_EDGE_RECOVERY_V2',operationId:proposal.operationId,sourceDigest:proposal.sourceDigest,keyDigest:proposal.keyDigest,postgresDigest:proposal.postgresDigest,backupDigest,beforeSequence:proposal.beforeSequence,afterSequence:proposal.afterSequence,durableSequence:proposal.durableSequence,originalCount:proposal.originalCount,originalDigest:proposal.originalDigest};
 const db=openExistingSqlite(path,'edge',source);
 try{
  db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  if(!sameProposal(proposal,{...proposeFromOpen(db,source,proposal),databaseBytes:proposal.databaseBytes,walBytes:proposal.walBytes}))throw Error('SPOOL_RECOVERY_PROPOSAL_STALE');
  for(const definition of Object.values(spoolV2Definitions))db.exec(definition);
  db.prepare('INSERT INTO spool_migrations VALUES(1,2,?)').run(JSON.stringify(receipt));
  db.prepare("UPDATE metadata SET value=? WHERE name='sequence'").run(String(receipt.afterSequence));db.exec('PRAGMA user_version=2');
  const after=snapshot(db,source);if(after.digest!==proposal.originalDigest||after.count!==proposal.originalCount||after.sequence!==receipt.afterSequence)throw Error('SPOOL_RECOVERY_CONSERVATION_FAILED');
  validateExistingSqlite(db,'edge',source);db.exec('COMMIT');spoolCheckpoint(options.onCheckpoint,{stage:'SQLITE_COMMITTED',path});
  return {receipt,replayed:false,backupPath,restorePath};
 }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
}
function proposeFromOpen(db:DatabaseSync,source:EdgeSource,p:SpoolProposal):SpoolProposal{
 const s=snapshot(db,source);return {...p,beforeSequence:s.sequence,afterSequence:Math.max(s.sequence,s.maximum,p.durableSequence),originalCount:s.count,originalDigest:s.digest};
}
