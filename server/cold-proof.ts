import {createHash} from 'node:crypto';
import type pg from 'pg';
import type {BatchBody} from './imports.ts';
import type {AuditEvent} from './domain.ts';
import type {BatchEvidence,ReceivedAuditEvidence} from './batch-evidence.ts';
import {entityTables} from './entity-schema.ts';
import {AuditChainVerifier} from './audit.ts';
import {emitCanonical} from './canonical-state.ts';
import {readLeanSnapshot,type LeanSnapshot} from './lean-snapshot.ts';
import {verifyBatchMappingEvidence} from './catalog.ts';
import {verifyEquipmentCatalogEvidence} from './equipment-profiles.ts';
import {verifyDataProjection} from './data-projection.ts';
import {holdAllocation,holdValue,requestSignal,CapacityError} from './capacity.ts';
import {streamRows} from './pg-row-stream.ts';
import {DomainError} from './service.ts';
export const coldFileChunkBytes=49152;
const frame=(phase:number)=>`SELECT ${phase},'frame',''::text,''::text,(-1)::bigint,NULL::jsonb,NULL::bytea,0::bigint`;
// No tenant filter can hide foreign or orphan evidence. All statements in this
// verifier are restricted to one caller-owned repeatable snapshot.
export const coldCanonicalRowsSql='/* IDMS_COLD_CANONICAL_ROWS */ SELECT * FROM ('+[
 `SELECT 0::integer AS phase,'state'::text AS kind,tenant_id,tenant_id AS identity,revision AS ordinal,jsonb_build_object('schemaVersion',schema_version,'payloadDigest',payload_digest) AS detail,NULL::bytea AS content,0::bigint AS suborder FROM business_state`,
 frame(1),`SELECT 1,'audit',tenant_id,event_id::text,sequence_no,jsonb_build_object('event',event,'hash',hash,'previousHash',previous_hash),NULL::bytea,0::bigint FROM audit_ledger`,
 frame(2),`SELECT 2,'receipt',tenant_id,request_key,ordinal,body,NULL::bytea,0::bigint FROM business_command_receipts`,
 frame(3),`SELECT 3,'file-meta',f.tenant_id,f.batch_id::text,COALESCE(b.ordinal,0),jsonb_build_object('sha256',f.sha256,'bytes',octet_length(f.content)),NULL::bytea,0::bigint FROM business_import_files f LEFT JOIN business_import_batches b ON b.tenant_id=f.tenant_id AND b.batch_id=f.batch_id`,
 `SELECT 3,'file-chunk',f.tenant_id,f.batch_id::text,COALESCE(b.ordinal,0),jsonb_build_object('offset',piece.start_at),substring(f.content FROM (piece.start_at+1)::integer FOR ${coldFileChunkBytes}),piece.start_at+1 FROM business_import_files f LEFT JOIN business_import_batches b ON b.tenant_id=f.tenant_id AND b.batch_id=f.batch_id CROSS JOIN LATERAL generate_series(0::bigint,octet_length(f.content)::bigint-1,${coldFileChunkBytes}::bigint) AS piece(start_at)`,
 frame(4),`SELECT 4,'request',tenant_id,request_key,ordinal,jsonb_build_object('key',request_key,'digest',digest,'batchId',batch_id),NULL::bytea,0::bigint FROM business_import_requests`,frame(5)
].join(' UNION ALL ')+') proof_rows ORDER BY phase,ordinal,suborder,identity COLLATE "C"';
export interface ColdProofRow {phase:number;kind:string;tenant_id:string;identity:string;ordinal:string;detail:any;content:Buffer|null;suborder:string}
const invalid=()=>new DomainError(503,'企业冷读取完整来源校验失败');
const fields=(v:any,names:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const rank=(v:unknown)=>{if(typeof v!=='string'||!/^[1-9][0-9]{0,18}$/.test(v))throw invalid();const n=BigInt(v);if(n>9223372036854775807n)throw invalid();return n;};
const absent:ReceivedAuditEvidence=Object.freeze({count:0,first:undefined,hasMapping:false,hasCorrection:false,hasEquipmentProfile:false});
interface Received {count:number;first:AuditEvent;hasMapping:boolean;hasCorrection:boolean;hasEquipmentProfile:boolean;release:()=>void}
interface Anchor {event:AuditEvent;release:()=>void}
interface File {batch:BatchBody;rank:bigint;bytes:number;seen:number;sha:string;hash:ReturnType<typeof createHash>;keys:string[];originalIndex:number}
// Replays the original canonical root without ever constructing a TenantPayload
// with absent originals/audits/receipts. The only retained source view is lean.
export class ColdCanonicalVerifier {
 private snapshot:LeanSnapshot|undefined;private tenant:string;private hash=createHash('sha256');private chain:AuditChainVerifier;private phase=0;private states=0;private finished=false;private closed=false;private lastAudit=0n;private lastReceipt=0n;private lastRequest=0n;private audits=0;private receipts=0;private requests=0;private fileIndex=0;private file?:File;
 private received=new Map<string,Received>();private anchors=new Map<string,Anchor>();private files=new Map<BatchBody,string>();private batchIds:Set<string>;private templateIds:Set<string>;private releaseIndex:()=>void;
 constructor(snapshot:LeanSnapshot,tenant:string){
  if(!fields(snapshot.data,['store','imports'])||!fields(snapshot.data.imports,['batches','records'])||!fields(snapshot.data.store,Object.keys(entityTables))||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<1||!/^[a-f0-9]{64}$/.test(snapshot.payloadDigest))throw invalid();
  this.snapshot=snapshot;this.tenant=tenant;this.chain=new AuditChainVerifier(tenant);this.releaseIndex=holdAllocation(131072+snapshot.data.imports.batches.length*256+snapshot.data.store.templates.length*256);
  this.batchIds=new Set(snapshot.data.imports.batches.map(b=>b.batchId));this.templateIds=new Set(snapshot.data.store.templates.filter(t=>t.manifest?.purpose==='equipment-profile').map(t=>t.id));
 }
 private text(text:string){this.hash.update(text);}
 private value(value:unknown){emitCanonical(value,text=>this.text(text));}
 private next(phase:number){
  if(phase!==this.phase+1||this.states!==1)throw invalid();
  if(phase===1)this.text('{"audits":[');
  else if(phase===2){this.text('],"business":');this.value(this.snapshot!.data.store);this.text(',"idempotency":[');}
  else if(phase===3)this.text('],"imports":{"batches":[');
  else if(phase===4){this.endFile();if(this.fileIndex!==this.snapshot!.data.imports.batches.length)throw invalid();this.text('],"records":');this.value(this.snapshot!.data.imports.records);this.text(',"requests":[');}
  else if(phase===5)this.text(']}}');else throw invalid();this.phase=phase;
 }
 private evidence(event:AuditEvent){
  if(event.objectType==='DATA_IMPORT'&&event.action==='IMPORT_RECEIVED'&&this.batchIds.has(event.objectId)){
   const old=this.received.get(event.objectId),flags={hasMapping:!!event.metadata?.mappingBinding,hasCorrection:!!event.metadata?.correction,hasEquipmentProfile:!!event.metadata?.equipmentProfileBinding};
   if(old){if(!Number.isSafeInteger(++old.count))throw invalid();old.hasMapping ||=flags.hasMapping;old.hasCorrection ||=flags.hasCorrection;old.hasEquipmentProfile ||=flags.hasEquipmentProfile;}
   else{const release=holdValue(event);try{this.received.set(event.objectId,{count:1,first:event,...flags,release});}catch(error){release();throw error;}}
  }
  if(event.objectType==='TEMPLATE'&&this.templateIds.has(event.objectId)){
   this.anchors.get(event.objectId)?.release();const release=holdValue(event);try{this.anchors.set(event.objectId,{event,release});}catch(error){release();throw error;}
  }
 }
 private beginFile(row:ColdProofRow){
  this.endFile();const batch=this.snapshot!.data.imports.batches[this.fileIndex];if(!batch||batch.batchId!==row.identity||this.snapshot!.batchRanks.get(row.identity)!==rank(row.ordinal)||row.suborder!=='0'||row.content!==null||!fields(row.detail,['sha256','bytes'])||row.detail.sha256!==batch.fileSha256||!Number.isSafeInteger(row.detail.bytes)||row.detail.bytes<0)throw invalid();
  if(this.fileIndex++)this.text(',');const keys=[...Object.keys(batch),'originalBase64'].sort(),originalIndex=keys.indexOf('originalBase64');this.text('{');
  for(let n=0;n<=originalIndex;n++){if(n)this.text(',');this.value(keys[n]);this.text(':');if(n<originalIndex)this.value((batch as any)[keys[n]]);}this.text('"');
  this.file={batch,rank:rank(row.ordinal),bytes:row.detail.bytes,seen:0,sha:row.detail.sha256,hash:createHash('sha256'),keys,originalIndex};
 }
 private endFile(){
  const file=this.file;if(!file)return;if(file.seen!==file.bytes||file.hash.digest('hex')!==file.sha)throw invalid();this.text('"');
  for(let n=file.originalIndex+1;n<file.keys.length;n++){this.text(',');this.value(file.keys[n]);this.text(':');this.value((file.batch as any)[file.keys[n]]);}this.text('}');this.files.set(file.batch,file.sha);this.file=undefined;
 }
 accept(row:ColdProofRow){
  if(this.closed||this.finished||!fields(row,['phase','kind','tenant_id','identity','ordinal','detail','content','suborder']))throw invalid();
  if(row.kind==='frame'){if(row.ordinal!=='-1'||row.suborder!=='0'||row.tenant_id!==''||row.identity!==''||row.detail!==null||row.content!==null)throw invalid();this.next(row.phase);return;}
  if(row.phase!==this.phase||row.tenant_id!==this.tenant||typeof row.identity!=='string')throw invalid();
  if(row.kind==='state'&&this.phase===0){if(this.states++||row.identity!==this.tenant||rank(row.ordinal)!==BigInt(this.snapshot!.revision)||row.suborder!=='0'||row.content!==null||!fields(row.detail,['schemaVersion','payloadDigest'])||row.detail.schemaVersion!==3||row.detail.payloadDigest!==this.snapshot!.payloadDigest)throw invalid();}
  else if(row.kind==='audit'&&this.phase===1){
   const n=rank(row.ordinal),d=row.detail,event=d?.event as AuditEvent;if(n<=this.lastAudit||row.suborder!=='0'||row.content!==null||!fields(d,['event','hash','previousHash'])||!event||event.eventId!==row.identity||event.tenantId!==row.tenant_id||event.hash!==d.hash||event.previousHash!==d.previousHash||!this.chain.accept(event))throw invalid();this.lastAudit=n;if(this.audits++)this.text(',');this.value(event);this.evidence(event);
  }else if(row.kind==='receipt'&&this.phase===2){const n=rank(row.ordinal);if(n<=this.lastReceipt||!row.identity.startsWith(this.tenant+':')||row.suborder!=='0'||row.content!==null)throw invalid();this.lastReceipt=n;if(this.receipts++)this.text(',');this.value([row.identity,row.detail]);}
  else if(row.kind==='file-meta'&&this.phase===3)this.beginFile(row);
  else if(row.kind==='file-chunk'&&this.phase===3){
   const f=this.file;if(!f||row.identity!==f.batch.batchId||rank(row.ordinal)!==f.rank||row.suborder!==String(f.seen+1)||!fields(row.detail,['offset'])||row.detail.offset!==f.seen||!Buffer.isBuffer(row.content)||row.content.length!==Math.min(coldFileChunkBytes,f.bytes-f.seen)||row.content.length<1)throw invalid();f.hash.update(row.content);this.text(row.content.toString('base64'));f.seen+=row.content.length;
  }else if(row.kind==='request'&&this.phase===4){const n=rank(row.ordinal);if(n<=this.lastRequest||!row.identity.startsWith(this.tenant+':')||row.suborder!=='0'||row.content!==null||!fields(row.detail,['key','digest','batchId'])||row.detail.key!==row.identity)throw invalid();this.lastRequest=n;if(this.requests++)this.text(',');this.value(row.detail);}
  else throw invalid();
 }
 finish(){
  if(this.closed||this.finished||this.phase!==5||this.states!==1||this.file||this.files.size!==this.snapshot!.data.imports.batches.length||this.hash.digest('hex')!==this.snapshot!.payloadDigest)throw invalid();this.finished=true;
  const evidence:BatchEvidence={templates:this.snapshot!.data.store.templates,templateAnchor:(tenant,id)=>tenant===this.tenant?this.anchors.get(id)?.event:undefined,received:(tenant,id)=>tenant===this.tenant?this.received.get(id)||absent:absent,originalMatches:batch=>this.files.get(batch)===batch.fileSha256};
  verifyEquipmentCatalogEvidence(evidence);for(const batch of this.snapshot!.data.imports.batches)verifyBatchMappingEvidence(evidence,batch);
  return {revision:this.snapshot!.revision,audits:this.audits,files:this.files.size,receipts:this.receipts,requests:this.requests};
 }
 dispose(){if(this.closed)return;this.closed=true;this.snapshot=undefined;this.file=undefined;for(const item of this.received.values())item.release();for(const item of this.anchors.values())item.release();this.received.clear();this.anchors.clear();this.files.clear();this.batchIds.clear();this.templateIds.clear();this.releaseIndex();}
}
export async function readColdSnapshot(client:pg.PoolClient,tenant:string){
 const settings=(await client.query("SELECT current_setting('transaction_isolation') AS isolation")).rows;if(settings.length!==1||settings[0].isolation!=='repeatable read')throw invalid();
 const check=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};check();const snapshot=await readLeanSnapshot(client,tenant);check();const proof=new ColdCanonicalVerifier(snapshot,tenant);let release=()=>{};
 try{await streamRows<ColdProofRow>(client,coldCanonicalRowsSql,row=>{release();release=()=>{};check();const {content,...meta}=row;if(content!==null&&!Buffer.isBuffer(content))throw invalid();const releaseMeta=holdValue(meta);try{const releaseBytes=holdAllocation(content?.length||0);release=()=>{releaseMeta();releaseBytes();};}catch(error){releaseMeta();throw error;}proof.accept(row);},()=>proof.dispose());check();proof.finish();await verifyDataProjection(client,snapshot.data.imports,tenant,check);check();return {data:snapshot.data,revision:snapshot.revision};}finally{release();proof.dispose();}
}
