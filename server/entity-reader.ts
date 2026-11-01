import {estimatedBytes,temporaryAllocation} from './capacity.ts';
import {AsyncResource} from 'node:async_hooks';
import pg from 'pg';
import {entityTables} from './entity-schema.ts';
import type {TenantPayload} from './entity-repository.ts';
import {jsonWireClone,canonicalEqual} from './canonical-state.ts';

// One SQL statement supplies one MVCC snapshot, including under READ COMMITTED.
// File bytes are an independent text field, never part of an aggregate JSON.
const rowSections={
 state:"SELECT 'state'::text kind,tenant_id,tenant_id identity,revision ordinal,jsonb_build_object('schemaVersion',schema_version,'payloadDigest',payload_digest) detail,NULL::text content FROM business_state",
 business:Object.entries(entityTables).map(([key,table])=>`SELECT 'business:${key}',tenant_id,id,ordinal,body,NULL::text FROM ${table}`),
 batch:"SELECT 'batch',tenant_id,batch_id::text,ordinal,body,NULL::text FROM business_import_batches",
 file:"SELECT 'file',tenant_id,batch_id::text,0::bigint,jsonb_build_object('sha256',sha256),replace(encode(content,'base64'),E'\\n','') FROM business_import_files",
 input:"SELECT 'input',tenant_id,batch_id::text,ordinal::bigint,jsonb_build_object('body',body,'validOrdinal',valid_ordinal),NULL::text FROM business_import_input_rows",
 record:"SELECT 'record',tenant_id,batch_id::text,ordinal,jsonb_build_object('tenantId',tenant_id,'dataType',data_type,'batchId',batch_id,'row',source_row,'sourceSystem',source_system,'value',body),NULL::text FROM managed_import_rows",
 request:"SELECT 'request',tenant_id,request_key,ordinal,jsonb_build_object('key',request_key,'digest',digest,'batchId',batch_id),NULL::text FROM business_import_requests",
 receipt:"SELECT 'receipt',tenant_id,request_key,ordinal,body,NULL::text FROM business_command_receipts",
 audit:"SELECT 'audit',tenant_id,event_id::text,sequence_no,jsonb_build_object('event',event,'hash',hash,'previousHash',previous_hash),NULL::text FROM audit_ledger",
 mirror:"SELECT 'mirror',tenant_id,id::text,0::bigint,body,NULL::text FROM work_orders"
};
export const entityRowsSql='/* IDMS_ENTITY_ROWS */ '+Object.values(rowSections).flat().join(' UNION ALL ');
export const readWorkspaceRowsSql='/* IDMS_READ_WORKSPACE_ROWS */ '+[rowSections.state,...rowSections.business,rowSections.batch,rowSections.input,rowSections.record].join(' UNION ALL ');
export const leanSnapshotRowsSql=readWorkspaceRowsSql+' UNION ALL '+rowSections.mirror;
interface Row {kind:string;tenant_id:string;identity:string;ordinal:string;detail:any;content:string|null;rank?:bigint}
const ordered=(rows:Row[])=>rows.sort((a,b)=>a.rank!<b.rank!?-1:a.rank!>b.rank!?1:0);
export class EntityRows {
 private groups=new Map<string,Row[]>();private count=0;private closed=false;private allocation=temporaryAllocation();
 readonly tenantId:string;
 constructor(tenantId:string){this.tenantId=tenantId;}
 discard(){this.closed=true;this.groups.clear();this.allocation.release();}
 add(row:Row){
  if(this.closed)throw Error('Entity reader is closed');
  try{
  if(row.tenant_id!==this.tenantId)throw Error('Normalized relations contain foreign tenant data');
  if(!/^[0-9]+$/.test(row.ordinal))throw Error('Invalid normalized ordinal');this.count++;
  const retained={...row,rank:BigInt(row.ordinal)};
  // Include row/group/sort references, not just JSON bodies. Shared bodies are
  // transferred to the final payload once all SQL bindings have been checked.
  this.allocation.grow(estimatedBytes(retained)+64);
  const group=this.groups.get(row.kind)||[];group.push(retained);this.groups.set(row.kind,group);
  }catch(error){this.discard();throw error;}
 }
 finish(){
  if(this.closed)throw Error('Entity reader is closed');
  try{
  const take=(kind:string)=>{const rows=this.groups.get(kind)||[];this.groups.delete(kind);return ordered(rows);};
  const states=take('state');if(states.length!==1||states[0].detail.schemaVersion!==3)throw Error('Normalized business migration is required');
  const business=Object.fromEntries(Object.keys(entityTables).map(key=>[key,take('business:'+key).map(row=>{if(row.detail.id!==row.identity)throw Error('SQL entity identity disagrees with body');return row.detail;})])) as TenantPayload['business'];
  const files=new Map(take('file').map(row=>[row.identity,row]));const input=new Map<string,Row[]>();for(const row of take('input')){const items=input.get(row.identity)||[];items.push(row);input.set(row.identity,items);}
  const batches=take('batch').map(row=>{
   const file=files.get(row.identity);if(!file||file.detail.sha256!==row.detail.fileSha256||typeof file.content!=='string')throw Error('Original file metadata disagrees with batch checksum');files.delete(row.identity);
   const rows=ordered(input.get(row.identity)||[]);input.delete(row.identity);
   if(row.detail.batchId!==row.identity||['originalBase64','rows','validRows'].some(k=>Object.hasOwn(row.detail,k)))throw Error('SQL batch metadata binding changed');
   // Unlike the other collections, validRows owns cloned JSON bodies while the
   // input rows still exist. Reserve them before materializing the clones.
   this.allocation.grow(estimatedBytes(rows.filter(r=>r.detail.validOrdinal!==null).map(r=>r.detail.body)));
   return {...row.detail,originalBase64:file.content,rows:rows.map(r=>r.detail.body),validRows:rows.filter(r=>r.detail.validOrdinal!==null).sort((a,b)=>a.detail.validOrdinal-b.detail.validOrdinal).map(r=>jsonWireClone(r.detail.body))};
  });
  if(files.size||input.size)throw Error('Original file or input row has no bound batch');
  const records=take('record').map(row=>row.detail),requests=take('request').map(row=>row.detail),idempotency=take('receipt').map(row=>[row.identity,row.detail] as [string,unknown]);
  const audits=take('audit').map(row=>{const {event,hash,previousHash}=row.detail;if(event.eventId!==row.identity||event.tenantId!==row.tenant_id||event.hash!==hash||event.previousHash!==previousHash)throw Error('SQL audit columns disagree with frozen events');return event;});
  const orders=take('mirror').map(row=>row.detail).sort((a,b)=>a.id.localeCompare(b.id));if(!canonicalEqual(orders,[...business.workOrders].sort((a,b)=>a.id.localeCompare(b.id))))throw Error('Work-order projection disagrees with normalized entities');
  if(this.groups.size)throw Error('Unknown normalized relation kind');
  const payload={business,imports:{batches,records,requests},audits,idempotency} as TenantPayload;
  const result={payload,revision:Number(states[0].ordinal),payloadDigest:states[0].detail.payloadDigest as string,rowsSeen:this.count};
  // No await or callback can observe an uncharged payload. The row envelopes
  // and reconstruction containers retire on return; payload remains task-owned.
  this.allocation.transfer(estimatedBytes(payload));this.closed=true;return result;
  }finally{this.discard();}
 }
}
export function readEntityRows(client:pg.PoolClient,tenantId:string):Promise<ReturnType<EntityRows['finish']>>{
 return new Promise((resolve,reject)=>{
  const state=new EntityRows(tenantId);let failure:unknown,stopped=false;
  const query=new pg.Query(entityRowsSql,undefined,AsyncResource.bind((error:Error|undefined,result?:pg.QueryResult)=>{
   stopped=true;result?.rows.splice(0);if(error||failure){state.discard();reject(error||failure);return;}try{resolve(state.finish());}catch(e){state.discard();reject(e);}
  }));
  // A callback preserves normal client query_timeout and error delivery. Clear
  // the public result array per event: pg retains at most the current extra row.
  query.on('row',AsyncResource.bind((row:Row,result?:{rows:unknown[]})=>{if(result)result.rows.length=0;if(stopped||failure)return;try{state.add(row);}catch(e){failure=e;state.discard();}}));
  try{client.query(query);}catch(e){stopped=true;state.discard();reject(e);}
 });
}
