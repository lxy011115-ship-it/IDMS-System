import {DatabaseSync} from 'node:sqlite';
import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,readdir,unlink,rmdir} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {stable} from '../integrations/telemetry.ts';
import {fieldObject,fieldHash,fieldInteger,fieldSha256} from '../integrations/field-profile.ts';
import {fieldEventProfile,fieldStreamBinding,fieldStreamId,verifyFieldEvent,verifyFieldAck,fieldEventDigest,fieldEventUuid,decodeFieldMessage,fieldEventMaxBytes} from '../integrations/field-event.ts';

const need=(value,code='COLD_FIELD_SPOOL_INTEGRITY')=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const tables={
  metadata:'CREATE TABLE metadata (name TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(length(CAST(value AS BLOB))<=32768))',
  pending:`CREATE TABLE pending (event_id TEXT PRIMARY KEY,sequence_no INTEGER NOT NULL UNIQUE CHECK(sequence_no>0 AND sequence_no<=9007199254740991),payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=${fieldEventMaxBytes}),digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('PENDING','REJECTED')),attempts INTEGER NOT NULL CHECK(attempts>=0 AND attempts<=9007199254740991),last_attempt INTEGER NOT NULL CHECK(last_attempt>=0 AND last_attempt<=9007199254740991),reason TEXT)`,
  acknowledged:`CREATE TABLE acknowledged (event_id TEXT PRIMARY KEY,sequence_no INTEGER NOT NULL UNIQUE CHECK(sequence_no>0 AND sequence_no<=9007199254740991),digest TEXT NOT NULL,ack TEXT NOT NULL CHECK(length(CAST(ack AS BLOB))<=${fieldEventMaxBytes}))`
};
async function canonicalDirectory(path){
  need(typeof path==='string'&&isAbsolute(path)&&path===resolve(path),'COLD_FIELD_SPOOL_WORK_DIRECTORY');
  for(let current=path;;current=dirname(current)){
    const stat=await lstat(current);need(stat.isDirectory()&&!stat.isSymbolicLink(),'COLD_FIELD_SPOOL_WORK_DIRECTORY');
    need(await realpath(current)===current,'COLD_FIELD_SPOOL_WORK_DIRECTORY');if(dirname(current)===current)break;
  }
}

/**
 * Inspects supplied, already captured main-database bytes. No original spool
 * path, authorization callback, network session or runtime constructor is used.
 * Historical signatures prove their signed content, not a current SQL commit.
 * The caller must separately bind the bytes, empty-WAL witness, full historical
 * event evidence and this private MAC to actual SOURCE and the current HELD.
 */
export async function inspectColdFieldSpoolSnapshotV1(input,raw,macKey){
  need(Buffer.isBuffer(input)&&input.length>=512&&input.length<=256*1024**2,'COLD_FIELD_SPOOL_BYTES');
  need(exact(raw,['profile','contextLease','eventKey','platformPublicKey','acknowledgedEvents','capacity','maxBytes','workDirectory']),'COLD_FIELD_SPOOL_CONTEXT');
  need(Buffer.isBuffer(macKey)&&macKey.length===32&&!macKey.every(value=>value===0),'COLD_FIELD_SPOOL_MAC_KEY');
  const bytes=Buffer.from(input),key=Buffer.from(macKey);let eventKey,db,directory,ownedIdentity,result,cleanupComplete=false;
  try{
    const profile=fieldEventProfile(raw.profile),binding=fieldStreamBinding(profile,raw.contextLease,raw.platformPublicKey),stream=fieldStreamId(binding);
    const capacity=fieldInteger(raw.capacity,1,10000),maxBytes=fieldInteger(raw.maxBytes,65536,268435456);
    need(Buffer.isBuffer(raw.eventKey)&&raw.eventKey.length===32&&!raw.eventKey.every(value=>value===0)&&fieldSha256(raw.eventKey)===profile.transport.eventKeySha256,'COLD_FIELD_SPOOL_EVENT_KEY');eventKey=Buffer.from(raw.eventKey);
    need(Array.isArray(raw.acknowledgedEvents)&&raw.acknowledgedEvents.length<=10000,'COLD_FIELD_SPOOL_ACK_EVENTS');
    const events=new Map();
    for(const value of raw.acknowledgedEvents){const event=verifyFieldEvent(value,eventKey,profile,raw.platformPublicKey),digest=fieldEventDigest(event);need(event.streamId===stream&&!events.has(digest),'COLD_FIELD_SPOOL_ACK_EVENTS');events.set(digest,event);}
    await canonicalDirectory(raw.workDirectory);directory=join(raw.workDirectory,'cold-field-spool-'+randomUUID());await mkdir(directory,{mode:0o700});ownedIdentity=await lstat(directory,{bigint:true});await privateDirectory(directory);
    const file=join(directory,'snapshot.sqlite');await privateNewFile(file,bytes);
    db=new DatabaseSync(file,{readOnly:true,timeout:1000});db.exec('PRAGMA trusted_schema=OFF;PRAGMA query_only=ON;PRAGMA temp_store=MEMORY;BEGIN;');
    need(Object.values(db.prepare('PRAGMA quick_check').get())[0]==='ok');
    const expected=Object.entries(tables).map(([name,sql])=>({name,type:'table',sql})).sort((a,b)=>a.name.localeCompare(b.name));
    need(stable(db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all())===stable(expected));
    need(db.prepare('PRAGMA application_id').get().application_id===0x49444631&&db.prepare('PRAGMA user_version').get().user_version===1);
    const names=['binding','binding_digest','format','last_append','sequence','state_mac'],rows=db.prepare('SELECT name,value FROM metadata ORDER BY name').all();
    need(rows.length===names.length&&rows.every((row,index)=>row.name===names[index]&&typeof row.value==='string'&&Buffer.byteLength(row.value)<=32768));
    const metadata=Object.fromEntries(rows.map(row=>[row.name,row.value]));
    need(metadata.format==='idms-field-spool-v1'&&metadata.binding===stable(binding)&&metadata.binding_digest===stream,'COLD_FIELD_SPOOL_BINDING');
    need(/^(0|[1-9][0-9]{0,15})$/.test(metadata.sequence)&&Number.isSafeInteger(Number(metadata.sequence)));
    const sequence=Number(metadata.sequence),last=JSON.parse(metadata.last_append);
    if(last===null)need(sequence===0);
    else{
      const value=fieldObject(last,['readId','inputDigest','firstSequence','lastSequence','eventIds']);fieldEventUuid(value.readId);fieldHash(value.inputDigest);fieldInteger(value.firstSequence,1,Number.MAX_SAFE_INTEGER);fieldInteger(value.lastSequence,1,Number.MAX_SAFE_INTEGER);
      need(value.lastSequence===sequence&&Array.isArray(value.eventIds)&&value.eventIds.length>0&&value.eventIds.length<=profile.points.length&&value.eventIds.length===value.lastSequence-value.firstSequence+1);
      const ids=value.eventIds.map(fieldEventUuid);need(new Set(ids).size===ids.length);
    }
    const usage=(table,column)=>db.prepare(`SELECT count(*) AS n,COALESCE(sum(length(CAST(${column} AS BLOB))),0) AS bytes,COALESCE(max(sequence_no),0) AS seq FROM ${table}`).get();
    const pendingUsage=usage('pending','payload'),ackUsage=usage('acknowledged','ack');
    need(pendingUsage.n<=capacity&&ackUsage.n<=capacity&&pendingUsage.bytes+ackUsage.bytes<=maxBytes&&Math.max(pendingUsage.seq,ackUsage.seq)===sequence);
    const {state_mac,...meta}=metadata,mac=createHmac('sha256',eventKey).update('idms:field-spool-state:1\n'+stable(meta)+'\n'),ids=new Set(),sequences=new Set();let pending=0,rejected=0,acknowledged=0;
    const rowIdentity=row=>{fieldEventUuid(row.event_id);fieldHash(row.digest);fieldInteger(row.sequence_no,1,sequence);need(!ids.has(row.event_id)&&!sequences.has(row.sequence_no));ids.add(row.event_id);sequences.add(row.sequence_no);};
    for(const row of db.prepare('SELECT event_id,sequence_no,payload,digest,state,attempts,last_attempt,reason FROM pending ORDER BY sequence_no').iterate()){
      rowIdentity(row);fieldInteger(row.attempts,0,Number.MAX_SAFE_INTEGER);fieldInteger(row.last_attempt,0,Number.MAX_SAFE_INTEGER);
      need(row.state==='PENDING'&&row.reason===null||row.state==='REJECTED'&&typeof row.reason==='string'&&/^FIELD_[A-Z0-9_]{1,96}$/.test(row.reason));
      need(typeof row.payload==='string'&&Buffer.byteLength(row.payload)<=fieldEventMaxBytes);
      const event=verifyFieldEvent(decodeFieldMessage(Buffer.from(row.payload)),eventKey,profile,raw.platformPublicKey);
      need(event.eventId===row.event_id&&event.sequenceNo===row.sequence_no&&event.streamId===stream&&fieldEventDigest(event)===row.digest&&stable(event)===row.payload,'COLD_FIELD_SPOOL_EVENT');
      mac.update('P'+stable({...row,payload:fieldSha256(row.payload)})+'\n');row.state==='PENDING'?pending++:rejected++;
    }
    const consumed=[];
    for(const row of db.prepare('SELECT event_id,sequence_no,digest,ack FROM acknowledged ORDER BY sequence_no').iterate()){
      rowIdentity(row);need(typeof row.ack==='string'&&Buffer.byteLength(row.ack)<=fieldEventMaxBytes);
      const event=events.get(row.digest);need(event,'COLD_FIELD_SPOOL_ACK_EVENT_MISSING');
      need(event.eventId===row.event_id&&event.sequenceNo===row.sequence_no&&event.streamId===stream,'COLD_FIELD_SPOOL_ACK_EVENT');
      const rawAck=decodeFieldMessage(Buffer.from(row.ack)),ack=verifyFieldAck(rawAck,raw.platformPublicKey,event,rawAck.body?.signedAtMs);
      need(ack.body.status==='STORED'&&stable(ack)===row.ack,'COLD_FIELD_SPOOL_ACK');
      mac.update('A'+stable({...row,ack:fieldSha256(row.ack)})+'\n');consumed.push(row.digest);acknowledged++;
    }
    need(/^[a-f0-9]{64}$/.test(state_mac)&&timingSafeEqual(mac.digest(),Buffer.from(state_mac,'hex')),'COLD_FIELD_SPOOL_STATE_MAC');
    const fingerprint=createHmac('sha256',key).update('IDMS_COLD_FIELD_SPOOL_SNAPSHOT_V1\n'+stable({binding,capacity,maxBytes,acknowledgedEventDigests:[...events.keys()].sort(),consumed:consumed.sort()})+'\n').update(bytes).digest('hex');
    db.exec('COMMIT');
    result={fingerprint,evidence:Object.freeze({format:'COLD_FIELD_SPOOL_SNAPSHOT_V1',pending,rejected,acknowledged,sequence,payloadBytes:pendingUsage.bytes+ackUsage.bytes,providedSnapshotStructureAndStateMacVerified:true,pendingEventSignaturesVerified:true,allRetainedAcknowledgementSignaturesVerified:true,historicalSignatureTimesUsed:true,sourceAndCurrentHeldBound:false,currentSqlCommitOrMembershipProven:false,originalSpoolOpened:false,temporarySnapshotNormallyClosedAndRemoved:true,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false}),toJSON(){need(false,'COLD_FIELD_SPOOL_PRIVATE_ONLY');}};
  }catch{throw Object.assign(Error('COLD_FIELD_SPOOL_UNVERIFIABLE'),{code:'COLD_FIELD_SPOOL_UNVERIFIABLE'});}
  finally{
    try{
      if(db?.isOpen)db.close();
      if(directory){
        const current=await lstat(directory,{bigint:true});need(ownedIdentity&&current.isDirectory()&&!current.isSymbolicLink()&&current.dev===ownedIdentity.dev&&current.ino===ownedIdentity.ino,'COLD_FIELD_SPOOL_CLEANUP');
        for(const entry of await readdir(directory,{withFileTypes:true})){
          need(['snapshot.sqlite','snapshot.sqlite-wal','snapshot.sqlite-shm'].includes(entry.name)&&entry.isFile()&&!entry.isSymbolicLink(),'COLD_FIELD_SPOOL_CLEANUP');
          const file=join(directory,entry.name),stat=await lstat(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'COLD_FIELD_SPOOL_CLEANUP');await unlink(file);
        }
        await rmdir(directory);
      }
      cleanupComplete=true;
    }finally{bytes.fill(0);key.fill(0);eventKey?.fill(0);}
    need(cleanupComplete,'COLD_FIELD_SPOOL_CLEANUP');
  }
  return Object.freeze(result);
}
