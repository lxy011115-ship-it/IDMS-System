import assert from 'node:assert/strict';
import {lstat,unlink,realpath} from 'node:fs/promises';
import {join,resolve,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {backupRegular,backupUnchanged,readExactly} from '../field-backup-io.mjs';
import {privateNewFile} from '../backup-support.mjs';
import {verifyFieldMapFullEvidenceV1} from '../field-map-full-evidence-v1.mjs';
import {assertColdSourceMapFactsV1} from '../cold-source-full-facts-v2.mjs';
import {canonical} from '../../server/imports.ts';
import {canonicalDigest} from '../../server/canonical-state.ts';
import {stateKey,validateStateNode,stateValueHash,parseStateValueText} from '../../server/state-map-v1.ts';
import {AuditChainVerifier} from '../../server/audit.ts';
import {auditPositionKey} from '../../server/telemetry-map-v4.ts';
import {AuthAuditCryptoV4,deriveAuthAuditKeyRingV4} from '../../server/auth-audit-event-v4.ts';

const digest=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const format='IDMS_AUTH_AUDIT_V4_1';

/** Fixed-size reads; authenticate all original bytes before returning any result. */
async function lines(file,maximum,task,lineMaximum=64*1024**2){
 const opened=await backupRegular(file,maximum),hash=createHash('sha256');let at=0,pending=Buffer.alloc(0),count=0;
 try{
  while(at<Number(opened.stat.size)){
   const chunk=await readExactly(opened.file,Math.min(65536,Number(opened.stat.size)-at),at);at+=chunk.length;hash.update(chunk);pending=Buffer.concat([pending,chunk]);
   for(;;){const end=pending.indexOf(10);if(end<0)break;assert(end<=lineMaximum);const line=new TextDecoder('utf8',{fatal:true}).decode(pending.subarray(0,end));assert(line.length);await task(JSON.parse(line),line,count++);pending=Buffer.from(pending.subarray(end+1));}
   assert(pending.length<=lineMaximum);
  }
  assert.equal(pending.length,0);await backupUnchanged(opened);const named=await lstat(file,{bigint:true});assert(named.dev===opened.stat.dev&&named.ino===opened.stat.ino&&named.nlink===1n&&named.size===opened.stat.size&&named.mtimeNs===opened.stat.mtimeNs&&named.ctimeNs===opened.stat.ctimeNs);return{bytes:at,sha256:hash.digest('hex'),lines:count};
 }finally{await opened.file.close();}
}

/** Separate offline consumer: no import of the runtime cohort, receipt matcher or SQL verifier. */
export async function verifyColdAuthAuditMapOfflineQaV2({source,fullFactsCheck,sqlEvidence,binding,ring,workDirectory,evidenceDirectory,seed}){
 assert(typeof evidenceDirectory==='string'&&isAbsolute(evidenceDirectory)&&resolve(evidenceDirectory)===evidenceDirectory&&evidenceDirectory!==workDirectory);for(let path=evidenceDirectory;;path=dirname(path)){const stat=await lstat(path);assert(stat.isDirectory()&&!stat.isSymbolicLink());const actual=await realpath(path);assert.equal(process.platform==='win32'?actual.toLowerCase():actual,process.platform==='win32'?path.toLowerCase():path);if(dirname(path)===path)break;}
 const baseline=source.fullFacts.databases.find(d=>d.sqlFacts.relations.some(r=>r.schema==='auth_audit_v4')).sqlFacts;
 const relations=baseline.relations.filter(r=>r.schema==='auth_audit_v4'),files=[],maps=new Map();let db,derived,result;
 assert.equal(relations.length,7);assert.equal(sqlEvidence.sourceSqlFactsSha256,baseline.sha256);assert(relations.reduce((n,r)=>n+(r.rows??0),0)<=4000000&&relations.reduce((n,r)=>n+(r.bytes??0),0)<=32*1024**3);
 const path=join(workDirectory,'auth-map-offline-'+randomUUID()+'.private.sqlite');await privateNewFile(path,'');const identity=await lstat(path,{bigint:true});files.push({path,identity});
 try{
  db=new DatabaseSync(path,{allowExtension:false});db.exec('PRAGMA journal_mode=DELETE;PRAGMA cache_size=-8192;PRAGMA max_page_count=4194304;CREATE TABLE leaves(tenant TEXT,k TEXT,v TEXT,PRIMARY KEY(tenant,k));CREATE TABLE markers(tenant TEXT,k TEXT,kind TEXT,in_chain INTEGER DEFAULT 0,matched INTEGER DEFAULT 0,PRIMARY KEY(tenant,k));CREATE TABLE events(scope TEXT,tenant TEXT,p INTEGER,id TEXT UNIQUE,v TEXT,PRIMARY KEY(scope,tenant,p));CREATE TABLE delivery(id TEXT PRIMARY KEY,v TEXT);CREATE TABLE streams(scope TEXT,tenant TEXT,v TEXT,PRIMARY KEY(scope,tenant));CREATE TABLE meta(v TEXT);BEGIN IMMEDIATE;');
  const insertLeaf=db.prepare('INSERT INTO leaves VALUES(?,?,?)'),insertMarker=db.prepare('INSERT INTO markers(tenant,k,kind) VALUES(?,?,?)');
  const get=(tenant,namespace,key)=>{const row=db.prepare('SELECT v FROM leaves WHERE tenant=? AND k=?').get(tenant,stateKey(tenant,namespace,key));return row?parseStateValueText(row.v):null;};
  for(const map of fullFactsCheck.maps){
   const original=source.fullFacts.databases.find(d=>d.map?.tenantId===map.tenantId);assert(original);assertColdSourceMapFactsV1(map.facts,original.map.facts);
   const rebuilt=await verifyFieldMapFullEvidenceV1({file:map.evidenceFile,expectedFacts:map.facts,workDirectory});assert(rebuilt.entireCurrentRootIndependentlyRebuilt&&rebuilt.fullDomainPayloadIndependentlyReconstructed);
   const counts={receipts:0,cursors:0,audits:0,legacy:0};
   const bytes=await lines(map.evidenceFile,2*1024**3,async value=>{
    if(value.type!=='NODE'||value.node?.kind!==0)return;
    const node=validateStateNode(value.node);assert.equal(stateValueHash(value.valueText),node.valueHash);const data=parseStateValueText(value.valueText);insertLeaf.run(map.tenantId,node.prefix,value.valueText);
    if(data?.format===format){
     assert.equal(data.tenantId,map.tenantId);
     if(Object.hasOwn(data,'requestHash')){assert(exact(data,['format','tenantId','source','requestHash','sourceEventId','sourcePosition','sourceChainHash','auditEventId','auditPosition','auditHash']));assert.equal(node.prefix,stateKey(map.tenantId,'receipt','auth_audit:'+canonicalDigest([data.source,data.sourceEventId])));insertMarker.run(map.tenantId,node.prefix,'RECEIPT');counts.receipts++;}
     else{assert(exact(data,['format','tenantId','source','position','chainHash','eventId']));assert.equal(node.prefix,stateKey(map.tenantId,'domain_head','auth_audit:'+data.source));insertMarker.run(map.tenantId,node.prefix,'CURSOR');counts.cursors++;}
    }
    if(data?.objectType==='AUTHENTICATION'){
     assert.equal(node.prefix,stateKey(map.tenantId,'audit',data.eventId));assert(data.metadata&&typeof data.metadata==='object');
     const current=Object.hasOwn(data.metadata,'authenticationEvent');insertMarker.run(map.tenantId,node.prefix,current?'AUDIT':'LEGACY');counts[current?'audits':'legacy']++;
    }
   });assert.equal(bytes.sha256,map.evidenceSha256);
   const head=get(map.tenantId,'domain_head','audit'),chain=new AuditChainVerifier(map.tenantId);assert(/^(0|[1-9][0-9]*)$/.test(head.count)&&BigInt(head.count)<=4000000n);let last=null;
   for(let p=1;p<=Number(head.count);p++){const order=get(map.tenantId,'audit_order',auditPositionKey(String(p)));assert.deepEqual(Object.keys(order).sort(),['eventId','position','tenantId']);assert.equal(order.tenantId,map.tenantId);assert.equal(order.position,String(p));last=get(map.tenantId,'audit',order.eventId);assert(chain.accept(last));if(last.objectType==='AUTHENTICATION')assert.equal(db.prepare('UPDATE markers SET in_chain=1 WHERE tenant=? AND k=? AND in_chain=0').run(map.tenantId,stateKey(map.tenantId,'audit',last.eventId)).changes,1);}
   assert.equal(chain.tip,head.hash);assert.equal(last?.eventId??null,head.eventId);assert.equal(db.prepare("SELECT count(*) AS n FROM markers WHERE tenant=? AND kind IN('AUDIT','LEGACY') AND in_chain=0").get(map.tenantId).n,0);
   maps.set(map.tenantId,{target:{tenantId:map.tenantId,databaseOid:original.map.profile.binding.databaseOid,catalogHash:original.map.profile.binding.catalogHash},counts});
  }
  const witness=sqlEvidence.rawCiphertextNamespaceWitness;assert.match(witness.id,/^[a-f0-9-]{36}$/);assert.equal(witness.sourceSqlFactsSha256,baseline.sha256);assert.equal(witness.namespaceRelationsSha256,digest(relations));
  const stats=relations.map(relation=>({relation,rows:0,bytes:0,hash:createHash('sha256'),last:null,sequence:false}));let header=null,complete=null,lastRelation=-1;
  const captured=await lines(join(evidenceDirectory,'auth-audit-map-sql-'+witness.id+'.private.jsonl'),2*relations.reduce((n,r)=>n+(r.bytes??0),0)+relations.reduce((n,r)=>n+(r.rows??0),0)*512+128*1024,async(value,line,number)=>{
   assert.equal(canonical(value),line);assert(!complete);
   if(number===0){assert.equal(value.type,'HEADER');assert.equal(value.format,'COLD_AUTH_AUDIT_MAP_SQL_WITNESS_V1');assert.deepEqual(value.binding,binding);assert.equal(value.sourceSqlFactsSha256,baseline.sha256);assert.deepEqual(value.relations,relations);header=value;return;}
   assert(header);if(value.type==='COMPLETE'){assert.equal(value.sourceSqlFactsSha256,baseline.sha256);assert.equal(value.sourceNamespaceRelationsSha256,digest(relations));complete=value;return;}
   const ordinal=relations.findIndex(r=>r.name===value.name);assert(ordinal>=lastRelation&&ordinal>=0);lastRelation=ordinal;const item=stats[ordinal];
   if(value.type==='SEQUENCE'){assert.equal(item.relation.kind,'S');assert(!item.sequence);assert.deepEqual(value.value,{last_value:item.relation.last_value,is_called:item.relation.is_called});item.sequence=true;return;}
   assert.equal(value.type,'ROW');assert.equal(item.relation.kind,'r');assert.equal(typeof value.record,'string');const raw=Buffer.from(value.record+'\n');assert(raw.length<=64*1024**2+1);assert(!item.last||Buffer.compare(item.last,raw)<=0);item.last=raw;item.rows++;item.bytes+=raw.length;assert(item.rows<=item.relation.rows&&item.bytes<=item.relation.bytes);item.hash.update(raw);const row=JSON.parse(value.record);
   if(value.name==='events'){assert(integer(row.position)&&row.position>0&&row.position<=4000000);db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(row.scope,row.tenant,row.position,row.id,value.record);}
   else if(value.name==='delivery')db.prepare('INSERT INTO delivery VALUES(?,?)').run(row.id,value.record);
   else if(value.name==='streams')db.prepare('INSERT INTO streams VALUES(?,?,?)').run(row.scope,row.tenant,value.record);
   else if(value.name==='_meta')db.prepare('INSERT INTO meta VALUES(?)').run(value.record);
  },128*1024**2+4096);assert(complete);assert.equal(captured.sha256,witness.sha256);assert.equal(captured.bytes,witness.bytes);
  for(const item of stats){if(item.relation.kind==='S')assert(item.sequence);else{assert.equal(item.rows,item.relation.rows);assert.equal(item.bytes,item.relation.bytes);assert.equal(item.hash.digest('hex'),item.relation.sha256);}}
  const sourceBase={deployment:sqlEvidence.deploymentDigest,databaseOid:baseline.identity.databaseOid};derived=deriveAuthAuditKeyRingV4(ring,sourceBase);const crypto=new AuthAuditCryptoV4(derived,sourceBase),meta=db.prepare('SELECT v FROM meta').all();assert.equal(meta.length,1);crypto.verifyWitness(JSON.parse(meta[0].v).key_check);
  let events=0,mapped=0,unacknowledged=0,delivered=0,running=0,pending=0,retry=0;const streams=[],seedEvents=new Set();
  for(const item of db.prepare('SELECT v FROM streams ORDER BY scope,tenant').iterate()){
   const stream=JSON.parse(item.v),map=maps.get(stream.tenant);assert(map&&integer(stream.emitted)&&integer(stream.delivered)&&stream.delivered<=stream.emitted);const src={...sourceBase,scope:stream.scope},sourceKey=canonicalDigest(src);let position=0,previous='0'.repeat(64),business=0,last=null,sourceAcks=0;
   for(const item of db.prepare('SELECT v FROM events WHERE scope=? AND tenant=? ORDER BY p').iterate(stream.scope,stream.tenant)){
    const row=JSON.parse(item.v),deliveryRow=db.prepare('SELECT v FROM delivery WHERE id=?').get(row.id);assert(deliveryRow);const d=JSON.parse(deliveryRow.v,(key,value,context)=>key==='fence'?context.source:value);assert.equal(row.position,++position);assert.equal(row.previous_hash,previous);assert(integer(row.occurred_ms)&&row.occurred_ms>0&&row.occurred_ms<=8640000000000000);
    const event=crypto.open({scope:row.scope,tenantId:row.tenant,eventId:row.id,position:String(row.position),action:row.action,occurredAtMs:String(row.occurred_ms),previousHash:row.previous_hash,sessionRef:row.session_ref,digest:row.digest,chainHash:row.chain_hash},row.sealed);previous=row.chain_hash;events++;
    assert(typeof d.fence==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(d.fence)&&BigInt(d.fence)<=9223372036854775807n&&integer(d.attempts)&&d.available_at!==null);
    if(d.status==='RUNNING'){assert(d.owner&&d.token&&d.lease_until&&BigInt(d.fence)>0n&&d.attempts>0);assert.equal(d.error_code,null);assert.equal(d.receipt,null);running++;}
    else{assert.equal(d.owner,null);assert.equal(d.token,null);assert.equal(d.lease_until,null);if(d.status==='DELIVERED'){assert(d.attempts>0&&BigInt(d.fence)>0n);assert.equal(d.error_code,null);delivered++;}else if(d.status==='PENDING'){assert.equal(d.fence,'0');assert.equal(d.attempts,0);assert.equal(d.receipt,null);assert.equal(d.error_code,null);pending++;}else{assert.equal(d.status,'RETRY');assert(d.attempts>0&&BigInt(d.fence)>0n&&d.error_code);assert.equal(d.receipt,null);retry++;}}
    if(position<=stream.delivered){assert.equal(d.status,'DELIVERED');sourceAcks++;}else{assert.notEqual(d.status,'DELIVERED');assert.equal(d.receipt,null);}
    const receiptKey='auth_audit:'+canonicalDigest([sourceKey,row.id]),c=get(row.tenant,'receipt',receiptKey);
    if(c){
     assert.equal(position,business+1);assert.equal(c.source,sourceKey);assert.equal(c.requestHash,canonicalDigest({source:src,event}));assert.equal(c.sourceEventId,row.id);assert.equal(c.sourcePosition,String(position));assert.equal(c.sourceChainHash,row.chain_hash);
     const a=get(row.tenant,'audit',c.auditEventId),order=get(row.tenant,'audit_order',auditPositionKey(c.auditPosition));assert.deepEqual(order,{tenantId:row.tenant,position:c.auditPosition,eventId:c.auditEventId});assert.equal(a.eventId,c.auditEventId);assert.equal(a.hash,c.auditHash);assert.equal(a.actorId,event.payload.actorId);assert.equal(a.objectId,event.payload.actorId);assert.equal(a.actorType,'USER');assert.equal(a.action,row.action);assert.equal(a.correlationId,row.id);
     assert.deepEqual(a.metadata,{authMode:'oidc',roles:event.payload.roles,reason:event.payload.reason,occurredAt:new Date(row.occurred_ms).toISOString(),authenticationEvent:{format,source:sourceKey,eventId:row.id,position:String(position),previousHash:row.previous_hash,chainHash:row.chain_hash,digest:row.digest,sessionRef:row.session_ref}});
     if(d.receipt!==null)assert.deepEqual(d.receipt,{completion:c,businessDatabaseOid:map.target.databaseOid,businessCatalogHash:map.target.catalogHash});
     for(const [kind,key]of [['RECEIPT',stateKey(row.tenant,'receipt',receiptKey)],['AUDIT',stateKey(row.tenant,'audit',a.eventId)]])assert.equal(db.prepare('UPDATE markers SET matched=1 WHERE tenant=? AND k=? AND kind=? AND matched=0').run(row.tenant,key,kind).changes,1);
     business=position;last=event;mapped++;if(position>stream.delivered)unacknowledged++;
    }else assert(position>stream.delivered);
    if(seed){const wanted=seed.tenants[row.tenant];for(const [id,value]of [[wanted.deliveredEventId,wanted.sourceDelivered],[wanted.unacknowledgedEventId,wanted.sourceAwaiting]])if(row.id===id){seedEvents.add(id);assert.deepEqual({status:d.status,fence:d.fence,attempts:d.attempts,errorCode:d.error_code,receipt:d.receipt},value);}if(row.id===wanted.unacknowledgedEventId){assert.equal(d.owner,wanted.originalClaim.owner);assert.equal(d.token,wanted.originalClaim.token);assert.equal(d.fence,wanted.originalClaim.fence);assert.equal(Date.parse(d.lease_until),Date.parse(wanted.originalClaim.leaseUntil));}}
   }
   assert.equal(position,stream.emitted);assert.equal(previous,stream.emitted_hash);assert.equal(sourceAcks,stream.delivered);assert(business>=stream.delivered);
   const cursor=get(stream.tenant,'domain_head','auth_audit:'+sourceKey);if(last){assert.deepEqual(cursor,{format,tenantId:stream.tenant,source:sourceKey,position:String(business),chainHash:last.header.chainHash,eventId:last.header.eventId});assert.equal(db.prepare("UPDATE markers SET matched=1 WHERE tenant=? AND k=? AND kind='CURSOR' AND matched=0").run(stream.tenant,stateKey(stream.tenant,'domain_head','auth_audit:'+sourceKey)).changes,1);}else assert.equal(cursor,null);
   streams.push({tenantId:stream.tenant,emitted:position,sourceAcknowledged:sourceAcks,businessCommitted:business});
  }
  assert.equal(events,sqlEvidence.events);assert.equal(events,relations.find(r=>r.name==='events').rows);assert.equal(events,relations.find(r=>r.name==='delivery').rows);assert.equal(mapped,sqlEvidence.matchedBusinessReceipts);assert.equal(unacknowledged,sqlEvidence.businessReceiptsAwaitingSourceAcknowledgement);assert.equal(mapped,complete.mapped);assert.equal(unacknowledged,complete.unacknowledged);assert.equal(events,complete.events);assert.equal(streams.length,sqlEvidence.streams);
  assert.deepEqual({delivered,running,pending,retry},{delivered:sqlEvidence.delivered,running:sqlEvidence.running,pending:sqlEvidence.pending,retry:sqlEvidence.retry});
  assert.equal(db.prepare("SELECT count(*) AS n FROM markers WHERE kind!='LEGACY' AND matched=0").get().n,0);const legacy=db.prepare("SELECT count(*) AS n FROM markers WHERE kind='LEGACY'").get().n;assert.equal(legacy,sqlEvidence.legacyAuthenticationAuditLeaves);if(seed)assert.equal(seedEvents.size,Object.keys(seed.tenants).length*2);
  result={format:'COLD_AUTH_AUDIT_MAP_OFFLINE_VERIFICATION_V1',rawNamespaceRowsIndependentlyRehashed:true,rawNamespaceCiphertextsIndependentlyDecrypted:true,completeCurrentRootsAndAuditChainsIndependentlyRebuilt:true,allBusinessReceiptsCursorsAndV4AuditsBidirectionallyMatched:true,events,streams,mapped,unacknowledged,legacyAuthenticationAuditLeaves:legacy,sourceRowsOwnerTokenFenceAndLeasePreserved:!!seed,originalSourceAcknowledgementsUnchanged:!!seed,witnessSha256:captured.sha256,witnessBytes:captured.bytes,fullGoalComplete:false};
 }finally{
  for(const key of derived?.keys??[])key.key='';if(db){if(db.isTransaction)db.exec('ROLLBACK;');db.close();}
  for(const file of files){const current=await lstat(file.path,{bigint:true});assert(current.isFile()&&current.nlink===1n&&current.dev===file.identity.dev&&current.ino===file.identity.ino);await unlink(file.path);}
 }
 return{...result,privateIndexNormallyRetired:true};
}
