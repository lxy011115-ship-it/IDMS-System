import type {DatabaseSync} from 'node:sqlite';
import {statSync} from 'node:fs';
import {authenticAck,authenticEvent,sha,type EdgeSource,type TelemetryAck} from '../../integrations/telemetry.ts';

export const spoolRecoveryLimits={records:10000,logicalBytes:128*1024**2,databaseBytes:256*1024**2,walBytes:64*1024**2,wireBytes:8192,freeBytes:1024**3} as const;
export const spoolV2Definitions={
 quarantine:"CREATE TABLE quarantine (event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,prior_state TEXT NOT NULL,attempts INTEGER NOT NULL,last_attempt INTEGER NOT NULL,prior_reason TEXT,reason TEXT NOT NULL,ack_payload TEXT NOT NULL,quarantined_at TEXT NOT NULL,logical_bytes INTEGER NOT NULL CHECK(logical_bytes>0))",
 spool_migrations:"CREATE TABLE spool_migrations (singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=2),receipt TEXT NOT NULL)"
};
export interface SpoolMigrationReceipt {
 format:'IDMS_EDGE_RECOVERY_V2';operationId:string;sourceDigest:string;keyDigest:string;
 beforeSequence:number;afterSequence:number;durableSequence:number;originalCount:number;originalDigest:string;postgresDigest:string;backupDigest:string;
}
export const spoolSourceDigest=(s:EdgeSource)=>sha({tenantId:s.tenantId,edgeId:s.edgeId,deviceCode:s.deviceCode,mapVersion:s.mapVersion});
export const spoolKeyDigest=(s:EdgeSource)=>sha({signingKey:s.signingKey,acknowledgementKey:s.acknowledgementKey});
export function spoolVersion(db:DatabaseSync){return Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);}
export function validateSpoolReceipt(value:unknown,source:EdgeSource):SpoolMigrationReceipt{
 const r=value as SpoolMigrationReceipt,keys=['format','operationId','sourceDigest','keyDigest','beforeSequence','afterSequence','durableSequence','originalCount','originalDigest','postgresDigest','backupDigest'];
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k))||r.format!=='IDMS_EDGE_RECOVERY_V2'||!/^[a-f0-9-]{36}$/.test(r.operationId)||r.sourceDigest!==spoolSourceDigest(source)||r.keyDigest!==spoolKeyDigest(source)||[r.originalDigest,r.postgresDigest,r.backupDigest].some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))||[r.beforeSequence,r.afterSequence,r.durableSequence,r.originalCount].some(n=>!Number.isSafeInteger(n)||n<0)||r.originalCount>10000||r.afterSequence<Math.max(r.beforeSequence,r.durableSequence)||r.afterSequence>=Number.MAX_SAFE_INTEGER)throw Error('SPOOL_MIGRATION_RECEIPT_INVALID');
 return r;
}
export function readSpoolReceipt(db:DatabaseSync,source:EdgeSource){
 const rows=db.prepare('SELECT version,receipt FROM spool_migrations WHERE singleton=1').all() as {version:number;receipt:string}[];
 if(rows.length!==1||rows[0].version!==2||Buffer.byteLength(rows[0].receipt)>4096)throw Error('SPOOL_MIGRATION_RECEIPT_INVALID');
 return validateSpoolReceipt(JSON.parse(rows[0].receipt),source);
}
export interface PendingSpoolRow {event_id:string;payload:string;digest:string;state:string;attempts:number;last_attempt:number;reason:string|null}
export function validPendingOriginal(row:PendingSpoolRow,source:EdgeSource){
 if(typeof row.payload!=='string'||Buffer.byteLength(row.payload)>8192)return false;
 try{const e=JSON.parse(row.payload);return authenticEvent(e,source.signingKey)&&sha(e)===row.digest&&e.eventId===row.event_id&&e.tenantId===source.tenantId&&e.edgeId===source.edgeId&&e.deviceCode===source.deviceCode&&e.mapVersion===source.mapVersion&&Number.isSafeInteger(e.sequenceNo)&&e.sequenceNo>0;}catch{return false;}
}
export interface QuarantineRow {event_id:string;payload:string;digest:string;prior_state:string;attempts:number;last_attempt:number;prior_reason:string|null;reason:string;ack_payload:string;quarantined_at:string;logical_bytes:number}
export function quarantineBytes(row:Omit<QuarantineRow,'logical_bytes'>){
 // UTF-8 field bytes plus a conservative fixed per-row structural allowance.
 return 128+[row.event_id,row.payload,row.digest,row.prior_state,row.attempts,row.last_attempt,row.prior_reason,row.reason,row.ack_payload,row.quarantined_at].reduce<number>((n,v)=>n+Buffer.byteLength(v===null?'null':String(v),'utf8'),0);
}
export function validSpoolAck(input:unknown,source:EdgeSource):input is TelemetryAck{
 if(!authenticAck(input,source.acknowledgementKey))return false;
 const keys=['version','eventId','tenantId','edgeId','digest','status','signature','reason'];
 return Object.keys(input).every(k=>keys.includes(k))&&input.version===1&&input.tenantId===source.tenantId&&input.edgeId===source.edgeId&&typeof input.eventId==='string'&&input.eventId.length<=100&&/^[a-f0-9]{64}$/.test(input.digest)&&['STORED','REJECTED'].includes(input.status)&&(input.reason===undefined||typeof input.reason==='string'&&/^[A-Z0-9_]{1,80}$/.test(input.reason));
}
export function spoolStorage(path:string){
 const size=(p:string)=>{try{return statSync(p).size;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;}};
 const databaseBytes=path===':memory:'?0:size(path),walBytes=path===':memory:'?0:size(path+'-wal');
 return {databaseBytes,walBytes,storageBlocked:databaseBytes>=spoolRecoveryLimits.databaseBytes||walBytes>=spoolRecoveryLimits.walBytes};
}
export function quarantineSummary(db:DatabaseSync){
 const row=db.prepare('SELECT count(*) AS records,coalesce(sum(logical_bytes),0) AS logicalBytes FROM quarantine').get() as {records:number;logicalBytes:number};
 return {...row,quarantineBlocked:row.records>=spoolRecoveryLimits.records||row.logicalBytes>=spoolRecoveryLimits.logicalBytes};
}
export function requireQuarantineSpace(records:number,logicalBytes:number,nextBytes:number){
 if(![records,logicalBytes,nextBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||records+1>spoolRecoveryLimits.records||logicalBytes+nextBytes>spoolRecoveryLimits.logicalBytes)throw Error('SPOOL_QUARANTINE_LIMIT');
}
/** Caller owns the surrounding IMMEDIATE transaction. Nothing moves on invalid or full ACK. */
export function quarantineRejected(db:DatabaseSync,row:PendingSpoolRow,ack:TelemetryAck,wire:Buffer,path:string){
 if(wire.length>spoolRecoveryLimits.wireBytes)throw Error('SPOOL_ACK_WIRE_LIMIT');
 const ack_payload=new TextDecoder('utf-8',{fatal:true}).decode(wire);
 if(sha(JSON.parse(ack_payload))!==sha(ack))throw Error('SPOOL_ACK_WIRE_MISMATCH');
 if(Buffer.byteLength(row.payload)>spoolRecoveryLimits.wireBytes)throw Error('SPOOL_EVENT_WIRE_LIMIT');
 if(spoolStorage(path).storageBlocked)throw Error('SPOOL_STORAGE_LIMIT');
 const record={event_id:row.event_id,payload:row.payload,digest:row.digest,prior_state:row.state,attempts:row.attempts,last_attempt:row.last_attempt,prior_reason:row.reason,reason:ack.reason||'REJECTED',ack_payload,quarantined_at:new Date().toISOString()};
 const bytes=quarantineBytes(record),stats=quarantineSummary(db);
 requireQuarantineSpace(stats.records,stats.logicalBytes,bytes);
 db.prepare('INSERT INTO quarantine VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(record.event_id,record.payload,record.digest,record.prior_state,record.attempts,record.last_attempt,record.prior_reason,record.reason,record.ack_payload,record.quarantined_at,bytes);
 if(db.prepare('DELETE FROM pending WHERE event_id=? AND digest=? AND payload=?').run(row.event_id,row.digest,row.payload).changes!==1)throw Error('SPOOL_PENDING_CHANGED');
}
