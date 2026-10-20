import {createHash} from 'node:crypto';
import type pg from 'pg';
import type {BatchBody,StoredRow} from '../../server/imports.ts';
import type {Store} from '../../server/store.ts';
import type {ReadWorkspaceData,StoreView} from '../../server/read-model.ts';
import {batchInputValue} from '../../server/import-revisions.ts';
import type {AuditEvent} from '../../server/domain.ts';
import type {RuntimeHistory} from '../../server/runtime-bootstrap.ts';
import type {BatchEvidence,ReceivedAuditEvidence} from '../../server/batch-evidence.ts';
import {AuditChainVerifier} from '../../server/audit.ts';
import {emitCanonical,canonicalDigest} from '../../server/canonical-state.ts';
import {verifyBatchMappingEvidence} from '../../server/catalog.ts';
import {verifyEquipmentCatalogEvidence} from '../../server/equipment-profiles.ts';
import {verifyTypedProjection,projectionTables} from '../../server/data-projection.ts';
import {holdValue,holdAllocation,accountValue} from '../../server/capacity.ts';
import {streamRows} from '../../server/pg-row-stream.ts';
import {freezeValue} from '../../server/tenant-workspace.ts';
import {coldFileChunkBytes} from '../../server/cold-proof.ts';
import {ColdCorrectionIndex,coldRank,coldObject,coldImportIntegrity,type RevisionSource} from './cold-input-baseline-corrections.ts';
import {readColdBusiness,readColdHeaders,readColdBatch,coldCount,checkColdImport,type ColdBatchHeader} from './cold-input-baseline-sources.ts';
export interface ColdImportBindings {readonly revision:number;readonly tenants:Store['tenants'];readonly history:RuntimeHistory}
const absent:ReceivedAuditEvidence=Object.freeze({count:0,first:undefined,hasMapping:false,hasCorrection:false,hasEquipmentProfile:false});
interface Received {count:number;firstId:string;firstDigest:string;hasMapping:boolean;hasCorrection:boolean;hasEquipmentProfile:boolean;release:()=>void}
export const coldRevisionSourcesSql=`/* IDMS_COLD_IMPORT_REVISIONS */ SELECT * FROM (
 SELECT 'root'::text AS kind,m.tenant_id,m.ordinal::text AS root_ordinal,1 AS revision,m.batch_id::text,m.source_row,NULL::text AS previous_batch_id,NULL::integer AS previous_row,NULL::text AS previous_digest,m.snapshot_digest,m.body,m.data_type,m.source_system,m.source_record_id FROM managed_import_rows m WHERE EXISTS(SELECT 1 FROM managed_record_revisions r WHERE r.tenant_id=m.tenant_id AND r.root_ordinal=m.ordinal)
 UNION ALL SELECT 'revision',r.tenant_id,r.root_ordinal::text,r.revision,r.batch_id::text,r.source_row,r.previous_batch_id::text,r.previous_row,r.previous_digest,r.snapshot_digest,r.body,m.data_type,m.source_system,m.source_record_id FROM managed_record_revisions r LEFT JOIN managed_import_rows m ON m.tenant_id=r.tenant_id AND m.ordinal=r.root_ordinal
 ) revision_sources ORDER BY root_ordinal::bigint,revision`;
function stored(row:any,tenant:string,headers:ReadonlyMap<string,ColdBatchHeader>):StoredRow{
 const h=headers.get(row.batch_id);if(row.tenant_id!==tenant||!h||h.status!=='COMMITTED'||h.dataType!==row.data_type||h.sourceSystem!==row.source_system||h.snapshotDigest!==row.snapshot_digest||!Number.isSafeInteger(row.source_row)||row.source_row<2||!coldObject(row.body)||String(row.body.source_record_id)!==row.source_record_id)throw coldImportIntegrity();
 return {tenantId:tenant,dataType:row.data_type,batchId:row.batch_id,row:row.source_row,sourceSystem:row.source_system,value:row.body};
}
// Reconstructs the exact old canonical root with one complete real BatchBody at
// a time. There is no partial ImportView, missing-file TenantPayload, or new root.
async function proveColdImports(client:pg.PoolClient,tenant:string,collector?:ColdReadCollector):Promise<ColdImportBindings>{
 checkColdImport();const settings=(await client.query("SELECT current_setting('transaction_isolation') AS isolation")).rows;if(settings.length!==1||settings[0].isolation!=='repeatable read')throw coldImportIntegrity();
 const states=(await client.query('/* IDMS_COLD_IMPORT_STATE */ SELECT tenant_id,revision::text,schema_version,payload_digest FROM business_state')).rows,state=states[0];if(states.length!==1||state.tenant_id!==tenant||state.schema_version!==3||!Number.isSafeInteger(Number(coldRank(state.revision)))||!/^[a-f0-9]{64}$/.test(state.payload_digest))throw coldImportIntegrity();
 const business=await readColdBusiness(client,tenant);let headers:Awaited<ReturnType<typeof readColdHeaders>>|undefined,corrections:ColdCorrectionIndex|undefined,rowLease=()=>{};const received=new Map<string,Received>(),anchors=new Map<string,{event:AuditEvent;release:()=>void}>(),pins=new Set<string>(),pinLeases:(()=>void)[]=[];let releaseState=()=>{},releaseScratch=()=>{};
 const hash=createHash('sha256'),text=(s:string)=>hash.update(s),value=(v:unknown)=>emitCanonical(v,text),ownRow=(r:unknown)=>{rowLease();rowLease=()=>{};checkColdImport();rowLease=holdValue(r);};
 try{
  releaseState=holdValue(state);releaseScratch=holdAllocation(131072);collector?.business(business.store);headers=await readColdHeaders(client,tenant);corrections=new ColdCorrectionIndex(tenant);const templates=new Set(business.store.templates.filter(t=>t.manifest?.purpose==='equipment-profile').map(t=>t.id)),chain=new AuditChainVerifier(tenant);let auditRank=0n,audits=0;
  text('{"audits":[');
  await streamRows<any>(client,'/* IDMS_COLD_IMPORT_AUDITS */ SELECT tenant_id,event_id::text,sequence_no::text,hash,previous_hash,event FROM audit_ledger a ORDER BY a.sequence_no',row=>{
   ownRow(row);const n=coldRank(row.sequence_no),event=row.event as AuditEvent;if(row.tenant_id!==tenant||n<=auditRank||!coldObject(event)||event.tenantId!==tenant||event.eventId!==row.event_id||event.hash!==row.hash||event.previousHash!==row.previous_hash||!chain.accept(event))throw coldImportIntegrity();auditRank=n;if(audits++)text(',');value(event);
   if(event.objectType==='DATA_IMPORT'&&event.action==='IMPORT_RECEIVED'&&headers!.byId.has(event.objectId)){
    const old=received.get(event.objectId),flags={hasMapping:!!event.metadata?.mappingBinding,hasCorrection:!!event.metadata?.correction,hasEquipmentProfile:!!event.metadata?.equipmentProfileBinding};if(old){if(!Number.isSafeInteger(++old.count))throw coldImportIntegrity();old.hasMapping ||=flags.hasMapping;old.hasCorrection ||=flags.hasCorrection;old.hasEquipmentProfile ||=flags.hasEquipmentProfile;}
    else{const entry={count:1,firstId:event.eventId,firstDigest:canonicalDigest(event),...flags},release=holdValue(entry);received.set(event.objectId,{...entry,release});}
   }
   if(event.objectType==='TEMPLATE'&&templates.has(event.objectId)){anchors.get(event.objectId)?.release();const release=holdValue(event);anchors.set(event.objectId,{event,release});}
  },()=>{});rowLease();rowLease=()=>{};
  text('],"business":');value(business.store);text(',"idempotency":[');let receiptRank=0n,receipts=0;
  await streamRows<any>(client,'/* IDMS_COLD_IMPORT_RECEIPTS */ SELECT tenant_id,request_key,ordinal::text,body FROM business_command_receipts c ORDER BY c.ordinal',row=>{ownRow(row);const rank=coldRank(row.ordinal);if(row.tenant_id!==tenant||rank<=receiptRank||typeof row.request_key!=='string'||!row.request_key.startsWith(tenant+':')||!Object.hasOwn(row,'body'))throw coldImportIntegrity();receiptRank=rank;if(receipts++)text(',');value([row.request_key,row.body]);},()=>{});rowLease();rowLease=()=>{};
  const totals=(await client.query('/* IDMS_COLD_IMPORT_TOTALS */ SELECT (SELECT count(*)::text FROM business_import_files) AS files,(SELECT count(*)::text FROM business_import_input_rows) AS inputs')).rows;if(totals.length!==1||coldCount(totals[0].files)!==headers.list.length)throw coldImportIntegrity();let inputs=0;
  text('],"imports":{"batches":[');
  for(let i=0;i<headers.list.length;i++){
   checkColdImport();const header=headers.list[i],loaded=await readColdBatch(client,header),batch=loaded.batch;let releaseAnchor=()=>{};
   try{
    if(canonicalDigest(batchInputValue(batch))!==batch.snapshotDigest)throw coldImportIntegrity();inputs+=batch.rows.length;if(!Number.isSafeInteger(inputs))throw coldImportIntegrity();const metadata=(await client.query('/* IDMS_COLD_IMPORT_FILE_META */ SELECT tenant_id,batch_id::text,sha256,octet_length(content) AS bytes FROM business_import_files WHERE tenant_id=$1 AND batch_id=$2::uuid',[tenant,header.batchId])).rows,file=metadata[0];if(metadata.length!==1||file.tenant_id!==tenant||file.batch_id!==header.batchId||file.sha256!==header.fileSha256||!Number.isSafeInteger(file.bytes)||file.bytes<0)throw coldImportIntegrity();
    if(i)text(',');const keys=[...Object.keys(batch),'originalBase64'].sort(),position=keys.indexOf('originalBase64');text('{');for(let n=0;n<=position;n++){if(n)text(',');value(keys[n]);text(':');if(n<position)value((batch as any)[keys[n]]);}text('"');const fileHash=createHash('sha256');let seen=0;
    await streamRows<any>(client,`/* IDMS_COLD_IMPORT_FILE_CHUNKS */ SELECT f.tenant_id,f.batch_id::text,piece.start_at::text AS offset,substring(f.content FROM (piece.start_at+1)::integer FOR ${coldFileChunkBytes}) AS content FROM business_import_files f CROSS JOIN LATERAL generate_series(0::bigint,octet_length(f.content)::bigint-1,${coldFileChunkBytes}::bigint) piece(start_at) WHERE f.tenant_id=$1 AND f.batch_id=$2::uuid ORDER BY piece.start_at`,row=>{rowLease();rowLease=()=>{};checkColdImport();const {content,...meta}=row;if(!Buffer.isBuffer(content)||row.tenant_id!==tenant||row.batch_id!==header.batchId||coldCount(row.offset)!==seen||content.length!==Math.min(coldFileChunkBytes,file.bytes-seen)||content.length<1)throw coldImportIntegrity();const releaseMeta=holdValue(meta);let releaseBytes=()=>{};try{releaseBytes=holdAllocation(content.length);rowLease=()=>{releaseMeta();releaseBytes();};}catch(e){releaseMeta();throw e;}fileHash.update(content);text(content.toString('base64'));seen+=content.length;},()=>{},[tenant,header.batchId]);rowLease();rowLease=()=>{};if(seen!==file.bytes||fileHash.digest('hex')!==file.sha256)throw coldImportIntegrity();text('"');for(let n=position+1;n<keys.length;n++){text(',');value(keys[n]);text(':');value((batch as any)[keys[n]]);}text('}');
    const audit=received.get(header.batchId);let first:AuditEvent|undefined;if((batch.correction||batch.mappingBinding||batch.equipmentProfileBinding||audit?.hasCorrection||audit?.hasMapping||audit?.hasEquipmentProfile)&&audit?.count===1){const rows=(await client.query('/* IDMS_COLD_IMPORT_RECEIVED_ANCHOR */ SELECT tenant_id,event_id::text,event FROM audit_ledger WHERE tenant_id=$1 AND event_id=$2::uuid',[tenant,audit.firstId])).rows;if(rows.length!==1||rows[0].tenant_id!==tenant||rows[0].event_id!==audit.firstId||rows[0].event?.eventId!==audit.firstId||canonicalDigest(rows[0].event)!==audit.firstDigest)throw coldImportIntegrity();first=rows[0].event;releaseAnchor=holdValue(first);}
    const evidence:BatchEvidence={templates:business.store.templates,templateAnchor:(t,id)=>t===tenant?anchors.get(id)?.event:undefined,received:(t,id)=>t===tenant&&id===header.batchId&&audit?{...audit,first}:absent,originalMatches:b=>b===batch&&file.sha256===b.fileSha256};verifyBatchMappingEvidence(evidence,batch);corrections.add(batch);collector?.batch(batch);
    if(!coldObject(batch.aiReview))throw coldImportIntegrity();const gateway=batch.aiReview.gateway;if(gateway){if(typeof gateway.modelDigest!=='string'||!gateway.modelDigest)throw coldImportIntegrity();if(!pins.has(gateway.modelDigest)){pinLeases.push(holdValue(gateway.modelDigest));pins.add(gateway.modelDigest);}}
    audit?.release();received.delete(header.batchId);
   }finally{rowLease();rowLease=()=>{};releaseAnchor();loaded.release();}
  }
  if(inputs!==coldCount(totals[0].inputs))throw coldImportIntegrity();text('],"records":[');
  for(const table of [...projectionTables,'managed_projection_state'])if((await client.query(`SELECT 1 FROM ${table} WHERE tenant_id IS DISTINCT FROM $1 LIMIT 1`,[tenant])).rowCount)throw coldImportIntegrity();
  const projection=(await client.query('/* IDMS_COLD_IMPORT_PROJECTION_STATE */ SELECT tenant_id,schema_version,row_count::text,rows_digest FROM managed_projection_state')).rows,p=projection[0];if(projection.length!==1||p.tenant_id!==tenant||p.schema_version!==1||!/^[a-f0-9]{64}$/.test(p.rows_digest))throw coldImportIntegrity();const expectedFacts=coldCount(p.row_count),recordsHash=createHash('sha256');recordsHash.update('[');let facts=0;
  await streamRows<any>(client,'/* IDMS_COLD_IMPORT_FACTS */ SELECT * FROM managed_import_rows ORDER BY ordinal',row=>{ownRow(row);if(coldRank(row.ordinal)!==BigInt(facts+1))throw coldImportIntegrity();const record=stored(row,tenant,headers!.byId);collector?.record(record);if(facts++){text(',');recordsHash.update(',');}emitCanonical(record,s=>{text(s);recordsHash.update(s);});},()=>{});rowLease();rowLease=()=>{};recordsHash.update(']');if(facts!==expectedFacts||recordsHash.digest('hex')!==p.rows_digest)throw coldImportIntegrity();
  text('],"requests":[');let requests=0,requestRank=0n;await streamRows<any>(client,'/* IDMS_COLD_IMPORT_REQUESTS */ SELECT tenant_id,request_key,ordinal::text,digest,batch_id::text FROM business_import_requests r ORDER BY r.ordinal',row=>{ownRow(row);const rank=coldRank(row.ordinal);if(row.tenant_id!==tenant||rank<=requestRank||typeof row.request_key!=='string'||!row.request_key.startsWith(tenant+':'))throw coldImportIntegrity();requestRank=rank;if(requests++)text(',');value({key:row.request_key,digest:row.digest,batchId:row.batch_id});},()=>{});rowLease();rowLease=()=>{};text(']}}');checkColdImport();if(hash.digest('hex')!==state.payload_digest)throw coldImportIntegrity();
  verifyEquipmentCatalogEvidence({templates:business.store.templates,templateAnchor:(t,id)=>t===tenant?anchors.get(id)?.event:undefined});checkColdImport();await verifyTypedProjection(client,tenant);checkColdImport();
  await streamRows<RevisionSource>(client,coldRevisionSourcesSql,row=>{ownRow(row);stored(row,tenant,headers!.byId);corrections!.accept(row);},()=>{});rowLease();rowLease=()=>{};corrections.finish();checkColdImport();
  const t=business.store.tenants[0],bindings:ColdImportBindings={revision:Number(state.revision),tenants:[{id:t.id,name:t.name,plan:t.plan,status:t.status,modules:[...t.modules]}],history:{workflowRequired:business.store.workOrders.some(o=>!!o.workflow),aiModelDigests:[...pins].sort()}};freezeValue(bindings);accountValue(bindings);return bindings;
 }finally{rowLease();releaseState();releaseScratch();business.release();headers?.release();corrections?.dispose();for(const e of received.values())e.release();received.clear();for(const a of anchors.values())a.release();anchors.clear();for(const f of pinLeases)f();pins.clear();}
}

// A legacy consumer explicitly requests its complete read model. It receives
// the same real objects used in the canonical proof, only after every check.
// The metadata-only verifier never creates this collector.
class ColdReadCollector {
 private store?:StoreView;private batches:BatchBody[]=[];private records:StoredRow[]=[];private leases:(()=>void)[]=[];private closed=false;
 business(store:StoreView){if(this.closed||this.store)throw coldImportIntegrity();this.leases.push(holdValue(store));this.store=store;}
 batch(batch:BatchBody){this.add(batch);this.batches.push(batch);}
 record(record:StoredRow){this.add(record);this.records.push(record);}
 private add(value:unknown){if(this.closed)throw coldImportIntegrity();const release=holdValue(value);let slot=()=>{};try{slot=holdAllocation(128);this.leases.push(()=>{release();slot();});}catch(e){release();slot();throw e;}}
 finish(revision:number){if(this.closed||!this.store)throw coldImportIntegrity();const data:ReadWorkspaceData={store:this.store,imports:{batches:[...this.batches],records:[...this.records]}};accountValue(data);freezeValue(data);return {data,revision};}
 dispose(){if(this.closed)return;this.closed=true;this.store=undefined;this.batches.length=0;this.records.length=0;for(const release of this.leases)release();this.leases.length=0;}
}
export async function verifyColdImports(client:pg.PoolClient,tenant:string){return proveColdImports(client,tenant);}
export async function readColdImportSnapshot(client:pg.PoolClient,tenant:string){const collector=new ColdReadCollector();try{const proof=await proveColdImports(client,tenant,collector);return collector.finish(proof.revision);}finally{collector.dispose();}}
