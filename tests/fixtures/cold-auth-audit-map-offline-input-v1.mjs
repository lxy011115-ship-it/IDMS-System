import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {coldAuthAuditMapEvidenceFixtureV1} from './cold-auth-audit-map-evidence-v1.mjs';
import {canonical} from '../../server/imports.ts';
import {stateKey,parseStateValueText} from '../../server/state-map-v1.ts';
import {AuthAuditCryptoV4,deriveAuthAuditKeyRingV4} from '../../server/auth-audit-event-v4.ts';
import {privateDirectory,privateNewFile} from '../../scripts/backup-support.mjs';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');

/** Synthetic offline rows only: deliberately cannot mint a live original-session capability. */
export async function coldAuthAuditMapOfflineInputV1(work,options={}){
 const directory=join(work,'offline-'+randomUUID());await privateDirectory(directory);
 const fixtures=[];for(const tenant of ['acme','sandbox'])fixtures.push(await coldAuthAuditMapEvidenceFixtureV1(directory,tenant,options));
 const sourceBase={deployment:'a'.repeat(64),databaseOid:'39001'},scope='b'.repeat(64),ring={format:1,activeKeyId:'offline-master',keys:[{keyId:'offline-master',key:Buffer.alloc(32,97).toString('base64url')}]},crypto=new AuthAuditCryptoV4(deriveAuthAuditKeyRingV4(ring,sourceBase),sourceBase);
 const rows={_ctx:[],_drafts:[],_meta:[{deployment:sourceBase.deployment,key_check:crypto.witness()}],delivery:[],events:[],streams:[]},tenants={},databases=[];
 for(const fixture of fixtures){
  const tenant=fixture.target.tenantId,leaves=new Map((await readFile(fixture.map.evidenceFile,'utf8')).trimEnd().split('\n').map(JSON.parse).filter(v=>v.type==='NODE'&&v.node.kind===0).map(v=>[v.node.prefix,parseStateValueText(v.valueText)]));
  const audits=[...leaves.values()].filter(v=>v?.objectType==='AUTHENTICATION'&&v.metadata?.authenticationEvent).sort((a,b)=>Number(a.metadata.authenticationEvent.position)-Number(b.metadata.authenticationEvent.position));let previous;
  for(const audit of audits){
   const m=audit.metadata.authenticationEvent,header={scope,tenantId:tenant,eventId:m.eventId,position:m.position,action:audit.action,occurredAtMs:String(Date.parse(audit.metadata.occurredAt)),previousHash:m.previousHash,sessionRef:m.sessionRef,digest:m.digest,chainHash:m.chainHash},event={header,payload:{actorId:audit.actorId,roles:audit.metadata.roles,reason:audit.metadata.reason}},completion=leaves.get(stateKey(tenant,'receipt','auth_audit:'+sha([m.source,m.eventId])));
   rows.events.push({id:m.eventId,scope,tenant,position:Number(m.position),lookup_hash:'e'.repeat(64),action:audit.action,occurred_ms:Number(header.occurredAtMs),previous_hash:m.previousHash,session_ref:m.sessionRef,digest:m.digest,chain_hash:m.chainHash,sealed:crypto.seal(event)});
   const delivered=m.position==='1',owner=delivered?null:randomUUID(),token=delivered?null:randomUUID(),lease=delivered?null:'2026-10-25T00:00:00.000Z',receipt=delivered?{completion,businessDatabaseOid:fixture.target.databaseOid,businessCatalogHash:fixture.target.catalogHash}:null;
   rows.delivery.push({id:m.eventId,status:delivered?'DELIVERED':'RUNNING',owner,token,fence:1,attempts:1,lease_until:lease,available_at:'2026-10-25T00:00:00.000Z',error_code:null,receipt});
   const wanted=tenants[tenant]??={};if(delivered){wanted.deliveredEventId=m.eventId;wanted.sourceDelivered={status:'DELIVERED',fence:'1',attempts:1,errorCode:null,receipt};}else{wanted.unacknowledgedEventId=m.eventId;wanted.sourceAwaiting={status:'RUNNING',fence:'1',attempts:1,errorCode:null,receipt:null};wanted.originalClaim={owner,token,fence:'1',leaseUntil:lease};}previous=m.chainHash;
  }
  rows.streams.push({scope,tenant,emitted:2,emitted_hash:previous,delivered:1});databases.push({databaseOid:fixture.target.databaseOid,sqlFacts:{relations:[]},map:{...fixture.map,profile:{binding:fixture.target}}});
 }
 const relations=['_ctx','_ddl_epoch','_drafts','_meta','delivery','events','streams'].map((name,index)=>{
  if(name==='_ddl_epoch')return{oid:String(40000+index),schema:'auth_audit_v4',name,kind:'S',last_value:'1',is_called:true};
  const records=rows[name].map(v=>canonical(v)).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));rows[name]=records;const data=records.map(r=>r+'\n').join('');return{oid:String(40000+index),schema:'auth_audit_v4',name,kind:'r',rows:records.length,bytes:Buffer.byteLength(data),sha256:sha(data)};
 });
 const baseline={identity:{databaseOid:sourceBase.databaseOid},relations,sha256:sha(relations)},binding={controlId:randomUUID(),sourceHash:'1'.repeat(64),sourceInventorySha256:'2'.repeat(64),recoveryId:randomUUID(),intentSha256:'3'.repeat(64)},id=randomUUID();
 const records=[{type:'HEADER',format:'COLD_AUTH_AUDIT_MAP_SQL_WITNESS_V1',binding,sourceSqlFactsSha256:baseline.sha256,relations}];for(const r of relations)if(r.kind==='S')records.push({type:'SEQUENCE',name:r.name,value:{last_value:r.last_value,is_called:r.is_called}});else for(const record of rows[r.name])records.push({type:'ROW',name:r.name,record});
 records.push({type:'COMPLETE',events:4,mapped:4,unacknowledged:2,sourceSqlFactsSha256:baseline.sha256,sourceNamespaceRelationsSha256:sha(relations)});const text=records.map(r=>canonical(r)+'\n').join(''),file=join(directory,'auth-audit-map-sql-'+id+'.private.jsonl');await privateNewFile(file,text);
 const sqlEvidence={sourceSqlFactsSha256:baseline.sha256,deploymentDigest:sourceBase.deployment,events:4,streams:2,delivered:2,running:2,pending:0,retry:0,matchedBusinessReceipts:4,businessReceiptsAwaitingSourceAcknowledgement:2,legacyAuthenticationAuditLeaves:2,rawCiphertextNamespaceWitness:{id,sha256:sha(text),bytes:Buffer.byteLength(text),sourceSqlFactsSha256:baseline.sha256,namespaceRelationsSha256:sha(relations)}};
 return{input:{source:{fullFacts:{databases:[...databases,{databaseOid:sourceBase.databaseOid,sqlFacts:baseline}]}},fullFactsCheck:{maps:fixtures.map(f=>f.map)},sqlEvidence,binding,ring,workDirectory:directory,seed:{tenants}},file,records,fixtures,sha};
}
