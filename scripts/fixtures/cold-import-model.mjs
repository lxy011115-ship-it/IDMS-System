import {canonical,digest} from '../../server/imports.ts';
import {splitBatch} from '../../server/entity-repository.ts';
import {revisionFacts,recordKey} from '../../server/import-revisions.ts';
// Independent full legacy payload oracle. No new verifier objects are used.
export function coldImportModel(payload,{fault=(kind,rows)=>rows,visit=()=>{},ledgerPayload=payload}={}){
 const tenant='acme',parts=new Map(payload.imports.batches.map(b=>[b.batchId,splitBatch(b)])),byId=new Map(payload.imports.batches.map(b=>[b.batchId,b])),ranks=new Map(payload.imports.records.map((r,i)=>[recordKey(r),i+1]));let queries=0,maxDriverRows=0;
 const roots=payload.imports.records.map((r,i)=>({tenant_id:r.tenantId,ordinal:String(i+1),batch_id:r.batchId,source_row:r.row,data_type:r.dataType,source_system:r.sourceSystem,source_record_id:String(r.value.source_record_id),snapshot_digest:byId.get(r.batchId).snapshotDigest,body:r.value}));
 const corrections=revisionFacts(ledgerPayload.imports,tenant).facts.map(f=>({kind:'revision',tenant_id:f.record.tenantId,root_ordinal:String(ranks.get(recordKey(f.root))),revision:f.revision,batch_id:f.record.batchId,source_row:f.record.row,previous_batch_id:f.previous.batchId,previous_row:f.previous.row,previous_digest:digest(canonical(f.previous)),snapshot_digest:f.snapshotDigest,body:f.record.value,data_type:f.record.dataType,source_system:f.record.sourceSystem,source_record_id:String(f.record.value.source_record_id)}));
 const used=new Set(corrections.map(r=>r.root_ordinal)),revisionRows=[...roots.filter(r=>used.has(r.ordinal)).map(({ordinal,...r})=>({...r,kind:'root',root_ordinal:ordinal,revision:1,previous_batch_id:null,previous_row:null,previous_digest:null})),...corrections].sort((a,b)=>Number(a.root_ordinal)-Number(b.root_ordinal)||a.revision-b.revision);
 function data(sql,values=[]){
  if(sql.includes('transaction_isolation'))return ['settings',[{isolation:'repeatable read'}]];
  if(sql.includes('IDMS_COLD_IMPORT_STATE'))return ['state',[{tenant_id:tenant,revision:'7',schema_version:3,payload_digest:digest(canonical(payload))}]];
  if(sql.includes('IDMS_COLD_IMPORT_BUSINESS'))return ['business',Object.entries(payload.business).flatMap(([kind,items])=>items.map((body,i)=>({kind,tenant_id:tenant,identity:body.id,ordinal:String(i+1),body})))];
  if(sql.includes('IDMS_COLD_IMPORT_MIRRORS'))return ['mirrors',payload.business.workOrders.map(body=>({tenant_id:tenant,id:body.id,body}))];
  if(sql.includes('IDMS_COLD_IMPORT_HEADERS'))return ['headers',payload.imports.batches.map((b,i)=>({tenant_id:tenant,batch_id:b.batchId,ordinal:String(i+1),header:Object.fromEntries(['tenantId','batchId','dataType','sourceSystem','status','snapshotDigest','fileSha256'].map(k=>[k,b[k]]))}))];
  if(sql.includes('IDMS_COLD_IMPORT_AUDITS'))return ['audits',payload.audits.map((event,i)=>({tenant_id:tenant,event_id:event.eventId,sequence_no:String(i+1),hash:event.hash,previous_hash:event.previousHash,event}))];
  if(sql.includes('IDMS_COLD_IMPORT_RECEIPTS'))return ['receipts',payload.idempotency.map(([request_key,body],i)=>({tenant_id:tenant,request_key,ordinal:String(i+1),body}))];
  if(sql.includes('IDMS_COLD_IMPORT_TOTALS'))return ['totals',[{files:String(parts.size),inputs:String(payload.imports.batches.reduce((n,b)=>n+b.rows.length,0))}]];
  if(sql.includes('IDMS_COLD_IMPORT_BATCH'))return ['batch',[{tenant_id:tenant,batch_id:values[1],body:parts.get(values[1]).body}]];
  if(sql.includes('IDMS_COLD_INPUT_COUNTS'))return ['inputCounts',[{inputs:String(parts.get(values[1]).input.length),selected:String(parts.get(values[1]).input.filter(row=>row.validOrdinal!==null).length)}]];
  if(sql.includes('IDMS_COLD_VALID_INPUTS'))return ['validInputs',parts.get(values[1]).input.filter(row=>row.validOrdinal!==null).sort((a,b)=>a.validOrdinal-b.validOrdinal).map(row=>({tenant_id:tenant,batch_id:values[1],ordinal:String(row.ordinal),valid_ordinal:row.validOrdinal,body:row.body}))];
  if(sql.includes('IDMS_COLD_IMPORT_INPUTS'))return ['inputs',parts.get(values[1]).input.map(row=>({tenant_id:tenant,batch_id:values[1],ordinal:String(row.ordinal),valid_ordinal:row.validOrdinal,body:row.body}))];
  if(sql.includes('IDMS_COLD_IMPORT_FILE_META'))return ['fileMeta',[{tenant_id:tenant,batch_id:values[1],sha256:byId.get(values[1]).fileSha256,bytes:parts.get(values[1]).content.length}]];
  if(sql.includes('IDMS_COLD_IMPORT_FILE_CHUNKS')){const content=parts.get(values[1]).content,rows=[];for(let at=0;at<content.length;at+=49152)rows.push({tenant_id:tenant,batch_id:values[1],offset:String(at),content:Buffer.from(content.subarray(at,at+49152))});return ['chunks',rows];}
  if(sql.includes('IDMS_COLD_IMPORT_RECEIVED_ANCHOR')){const event=payload.audits.find(e=>e.eventId===values[1]);return ['anchor',event?[{tenant_id:tenant,event_id:event.eventId,event}]:[]];}
  if(sql.includes('IDMS_COLD_IMPORT_PROJECTION_STATE'))return ['projectionState',[{tenant_id:tenant,schema_version:1,row_count:String(roots.length),rows_digest:digest(canonical(payload.imports.records))}]];
  if(sql.includes('IDMS_COLD_IMPORT_FACTS'))return ['facts',roots];
  if(sql.includes('IDMS_COLD_IMPORT_REQUESTS'))return ['requests',payload.imports.requests.map((r,i)=>({tenant_id:tenant,request_key:r.key,ordinal:String(i+1),digest:r.digest,batch_id:r.batchId}))];
  if(sql.includes('IDMS_COLD_IMPORT_REVISIONS'))return ['revisions',revisionRows];
  if(sql.startsWith('SELECT 1 FROM ')&&sql.includes('tenant_id IS DISTINCT'))return ['foreign',[]];
  if(sql.startsWith('SELECT data_type,count')){const groups=new Map();for(const r of roots)groups.set(r.data_type,(groups.get(r.data_type)||0)+1);return ['typedCounts',[...groups].map(([data_type,count])=>({data_type,count}))];}
  if(sql.startsWith('SELECT count(*)::int AS count FROM ')){const type=sql.includes('managed_assets')?'DEVICE':sql.includes('managed_point_definitions')?'POINT_DEFINITION':'MEASUREMENT';return ['typedTable',[{count:roots.filter(r=>r.data_type===type).length}]];}
  if(sql.startsWith('SELECT 1 FROM managed_assets'))return ['typedMismatch',[]];
  throw Error('Unexpected cold import test SQL: '+sql.slice(0,70));
 }
 const clone=rows=>rows.map(r=>{const {content,...rest}=r;return {...structuredClone(rest),...(content!==undefined?{content:Buffer.from(content)}:{})};});
 const client={query(config,values){queries++;const sql=typeof config==='string'?config:config.text,[kind,rows]=data(sql,values||config.values);visit(kind,sql);const changed=fault(kind,clone(rows));if(typeof config==='string')return Promise.resolve({rows:changed,rowCount:changed.length});queueMicrotask(()=>{const result={rows:[]};for(const row of changed){config.emit('row',row,result);result.rows.push(row);maxDriverRows=Math.max(maxDriverRows,result.rows.length);}config.callback(null,result);});return config;}};
 return {client,get queries(){return queries;},get maxDriverRows(){return maxDriverRows;}};
}
