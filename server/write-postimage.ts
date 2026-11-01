import type pg from 'pg';
import type {TenantPayload} from './entity-repository.ts';
import type {Batch} from './imports.ts';
import {entityTables} from './entity-schema.ts';
import {entityRowsSql} from './entity-reader.ts';
import {canonicalEqual} from './canonical-state.ts';
import {holdAllocation,holdValue} from './capacity.ts';
import {streamRows} from './pg-row-stream.ts';
import {DomainError} from './service.ts';

// Exactly the same source sections as the full reader, in one SQL snapshot.
// Only the query marker changes; no body or relation is omitted.
export const postImageRowsSql=entityRowsSql.replace('/* IDMS_ENTITY_ROWS */','/* IDMS_POST_IMAGE_ROWS */');
export interface PostImageRow {kind:string;tenant_id:string;identity:string;ordinal:string;detail:any;content:string|null}
const invalid=()=>Object.assign(new DomainError(503,'企业写入后的一致性校验失败，本次变更未提交'),{code:'WRITE_POSTIMAGE_MISMATCH'});
const fields=(value:unknown,names:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const ordinal=(value:unknown,zero=false):bigint=>{
 if(typeof value!=='string'||!(zero&&value==='0'||/^[1-9][0-9]{0,18}$/.test(value)))throw invalid();const n=BigInt(value);if(n>9223372036854775807n)throw invalid();return n;
};
class Marks {
 private bits:Uint8Array;private count=0;readonly size:number;
 constructor(size:number){this.size=size;this.bits=new Uint8Array(Math.ceil(size/8));}
 mark(index:number){if(!Number.isInteger(index)||index<0||index>=this.size)throw invalid();const byte=Math.floor(index/8),mask=1<<(index&7);if(this.bits[byte]&mask)throw invalid();this.bits[byte]|=mask;this.count++;}
 complete(){if(this.count!==this.size)throw invalid();}
 clear(){this.bits=new Uint8Array(0);}
}
interface BatchIndex {batch:Batch;index:number;input:Marks;valid:Marks}
// References and compact coverage/order indexes only. The expected wire payload
// already belongs to the transaction; this class never builds another payload.
export class PostImageVerifier {
 readonly indexBytes:number;private expected:TenantPayload|undefined;private tenant:string;private revision:number;private beforeDigest:string;private closed=false;private rows=0;
 private releaseIndex:()=>void=()=>{};private slots:Marks[]=[];private business=new Map<string,Marks>();private batches=new Map<string,BatchIndex>();private auditIndex=new Map<string,number>();private mirrorIndex=new Map<string,number>();private sequences=new BigInt64Array(0);
 private state!:Marks;private batchRows!:Marks;private files!:Marks;private records!:Marks;private requests!:Marks;private receipts!:Marks;private audits!:Marks;private mirrors!:Marks;
 constructor(expected:TenantPayload,tenant:string,revision:number,beforeDigest:string){
  this.expected=expected;this.tenant=tenant;this.revision=revision;this.beforeDigest=beforeDigest;
  // The SQL envelope can represent exactly these root/import fields and pairs.
  // Checking only row bodies would otherwise miss an unexpected empty field or
  // a third receipt tuple element and permit an unreconstructable digest.
  if(!fields(expected,['business','imports','audits','idempotency'])||!fields(expected.imports,['batches','records','requests'])||!fields(expected.business,Object.keys(entityTables))||!Array.isArray(expected.idempotency)||expected.idempotency.some(entry=>!Array.isArray(entry)||entry.length!==2))throw invalid();
  if(!Number.isSafeInteger(revision)||revision<1||!/^[a-f0-9]{64}$/.test(beforeDigest))throw invalid();
  const slotBytes=(size:number)=>128+Math.ceil(size/8);
  this.indexBytes=65536+slotBytes(1)+Object.values(expected.business).reduce((n,items)=>n+slotBytes(items.length),0)+[expected.imports.batches.length,expected.imports.batches.length,expected.imports.records.length,expected.imports.requests.length,expected.idempotency.length,expected.audits.length,expected.business.workOrders.length].reduce((n,size)=>n+slotBytes(size),0)+expected.audits.reduce((n,event)=>n+128+event.eventId.length*2,0)+expected.audits.length*8+expected.business.workOrders.reduce((n,order)=>n+128+order.id.length*2,0)+expected.imports.batches.reduce((n,b)=>n+256+b.batchId.length*2+Object.keys(b).length*64+slotBytes(b.rows.length)+slotBytes(b.validRows.length),0);
  if(!Number.isSafeInteger(this.indexBytes)||this.indexBytes<65536)throw invalid();
  this.releaseIndex=holdAllocation(this.indexBytes);
  try{
   const marks=(size:number)=>{const result=new Marks(size);this.slots.push(result);return result;};this.state=marks(1);
   for(const [key,items]of Object.entries(expected.business))this.business.set(key,marks(items.length));
   this.batchRows=marks(expected.imports.batches.length);this.files=marks(expected.imports.batches.length);this.records=marks(expected.imports.records.length);this.requests=marks(expected.imports.requests.length);this.receipts=marks(expected.idempotency.length);this.audits=marks(expected.audits.length);this.mirrors=marks(expected.business.workOrders.length);
   for(const [index,batch]of expected.imports.batches.entries()){if(this.batches.has(batch.batchId))throw invalid();this.batches.set(batch.batchId,{batch,index,input:marks(batch.rows.length),valid:marks(batch.validRows.length)});}
   for(const [index,event]of expected.audits.entries()){if(this.auditIndex.has(event.eventId))throw invalid();this.auditIndex.set(event.eventId,index);}
   for(const [index,order]of expected.business.workOrders.entries()){if(this.mirrorIndex.has(order.id))throw invalid();this.mirrorIndex.set(order.id,index);}
   this.sequences=new BigInt64Array(expected.audits.length);
  }catch(error){this.dispose();throw error;}
 }
 accept(row:PostImageRow){
  if(this.closed||!row||row.tenant_id!==this.tenant||typeof row.kind!=='string'||typeof row.identity!=='string')throw invalid();
  const payload=this.expected!,n=ordinal(row.ordinal,row.kind==='file'||row.kind==='mirror'),index=Number(n-1n);
  if(row.kind!=='file'&&row.content!==null)throw invalid();
  const equal=(a:unknown,b:unknown)=>{if(!canonicalEqual(a,b))throw invalid();};
  if(row.kind==='state'){
   if(row.identity!==this.tenant||n!==BigInt(this.revision))throw invalid();equal(row.detail,{schemaVersion:3,payloadDigest:this.beforeDigest});this.state.mark(0);
  }else if(row.kind.startsWith('business:')){
   const key=row.kind.slice(9),marks=this.business.get(key);if(!marks||!Object.hasOwn(entityTables,key))throw invalid();const expected=(payload.business as any)[key][index];if(!expected||row.identity!==expected.id)throw invalid();equal(row.detail,expected);marks.mark(index);
  }else if(row.kind==='batch'){
   const batch=payload.imports.batches[index];if(!batch||row.identity!==batch.batchId)throw invalid();const {rows,validRows,originalBase64,...body}=batch;equal(row.detail,body);this.batchRows.mark(index);
  }else if(row.kind==='file'){
   const entry=this.batches.get(row.identity);if(!entry||n!==0n||typeof row.content!=='string')throw invalid();equal(row.detail,{sha256:entry.batch.fileSha256});if(row.content!==entry.batch.originalBase64)throw invalid();this.files.mark(entry.index);
  }else if(row.kind==='input'){
   const entry=this.batches.get(row.identity);if(!entry||!row.detail||typeof row.detail!=='object'||Array.isArray(row.detail)||Object.keys(row.detail).length!==2||!Object.hasOwn(row.detail,'body')||!Object.hasOwn(row.detail,'validOrdinal'))throw invalid();
   if(index<0||index>=entry.batch.rows.length)throw invalid();equal(row.detail.body,entry.batch.rows[index]);entry.input.mark(index);
   const valid=row.detail.validOrdinal;if(valid!==null){if(!Number.isInteger(valid)||valid<1||valid>entry.batch.validRows.length)throw invalid();equal(row.detail.body,entry.batch.validRows[valid-1]);entry.valid.mark(valid-1);}
  }else if(row.kind==='record'){
   const record=payload.imports.records[index];if(!record||row.identity!==record.batchId)throw invalid();equal(row.detail,record);this.records.mark(index);
  }else if(row.kind==='request'){
   const request=payload.imports.requests[index];if(!request||row.identity!==request.key)throw invalid();equal(row.detail,request);this.requests.mark(index);
  }else if(row.kind==='receipt'){
   const receipt=payload.idempotency[index];if(!receipt||row.identity!==receipt[0])throw invalid();equal(row.detail,receipt[1]);this.receipts.mark(index);
  }else if(row.kind==='audit'){
   const position=this.auditIndex.get(row.identity);if(position===undefined)throw invalid();const event=payload.audits[position];equal(row.detail,{event,hash:event.hash,previousHash:event.previousHash});this.audits.mark(position);this.sequences[position]=n;
  }else if(row.kind==='mirror'){
   const position=this.mirrorIndex.get(row.identity);if(position===undefined||n!==0n)throw invalid();equal(row.detail,payload.business.workOrders[position]);this.mirrors.mark(position);
  }else throw invalid();
  this.rows++;
 }
 finish(){
  if(this.closed)throw invalid();for(const slot of this.slots)slot.complete();let previous=0n;for(const n of this.sequences){if(n<=previous)throw invalid();previous=n;}
  const result={rows:this.rows,indexBytes:this.indexBytes};this.dispose();return result;
 }
 dispose(){if(this.closed)return;this.closed=true;this.expected=undefined;this.business.clear();this.batches.clear();this.auditIndex.clear();this.mirrorIndex.clear();this.sequences=new BigInt64Array(0);for(const slot of this.slots)slot.clear();this.slots.length=0;this.releaseIndex();}
}
export async function verifyPostImage(client:pg.PoolClient,tenant:string,expected:TenantPayload,revision:number,beforeDigest:string){
 let verifier:PostImageVerifier|undefined,releaseRow=()=>{};
 try{
  verifier=new PostImageVerifier(expected,tenant,revision,beforeDigest);
  await streamRows<PostImageRow>(client,postImageRowsSql,row=>{releaseRow();releaseRow=()=>{};releaseRow=holdValue(row);verifier!.accept(row);},()=>{releaseRow();verifier!.dispose();});
  return verifier.finish();
 }catch(error){if(error instanceof DomainError)throw error;throw invalid();}finally{releaseRow();verifier?.dispose();}
}
