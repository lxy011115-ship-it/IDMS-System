import {createHash,timingSafeEqual} from 'node:crypto';
import {csvParts} from './data-export.ts';
import {holdAllocation} from './capacity.ts';
import {DomainError} from './service.ts';
export const csvChunkBytes=65536;
export class CsvExportError extends DomainError {readonly code:string;constructor(status:number,code:string,message:string){super(status,message);this.code=code;}}
export const csvIntegrityError=()=>new CsvExportError(503,'CSV_EXPORT_INTEGRITY','导出一致性核对失败，请重试或联系管理员');
export async function* csvChunks(headers:string[],rows:AsyncIterable<unknown[]>,check:()=>void):AsyncGenerator<Buffer>{
 let buffer=Buffer.alloc(csvChunkBytes),used=0;
 async function* append(parts:Iterable<string>){for(const part of parts){const bytes=Buffer.from(part,'utf8');let offset=0;while(offset<bytes.length){check();const length=Math.min(csvChunkBytes-used,bytes.length-offset);bytes.copy(buffer,used,offset,offset+length);used+=length;offset+=length;if(used===csvChunkBytes){yield buffer;buffer=Buffer.alloc(csvChunkBytes);used=0;}}}}
 yield* append(['\uFEFF']);yield* append(csvParts(headers));for await(const row of rows){check();yield* append(csvParts(row));}if(used){check();yield buffer.subarray(0,used);}
}
export interface CsvSummary {bytes:number;rows:number;sha256:string;chunks:number}
export class CsvManifest {
 private hashes:Buffer[]=[];private leases:(()=>void)[]=[];private bytes=0;private short=false;private sealed?:CsvSummary;private closed=false;private completed=false;private hash=createHash('sha256');private delivery=createHash('sha256');private deliveredBytes=0;private next=0;
 readonly maximum:number;
 constructor(maximum:number){if(!Number.isSafeInteger(maximum)||maximum<1)throw csvIntegrityError();this.maximum=maximum;}
 add(chunk:Buffer){
  if(this.closed||this.sealed||this.short||!Buffer.isBuffer(chunk)||!chunk.length||chunk.length>csvChunkBytes)throw csvIntegrityError();
  if(this.bytes+chunk.length>this.maximum)throw new CsvExportError(422,'CSV_EXPORT_BYTES_LIMIT','导出结果超过当前文件大小限制，请缩小筛选范围');
  const release=holdAllocation(256);try{this.hashes.push(createHash('sha256').update(chunk).digest());this.leases.push(release);}catch(error){release();throw error;}this.hash.update(chunk);this.bytes+=chunk.length;this.short=chunk.length<csvChunkBytes;
 }
 seal(rows:number){if(this.closed||this.sealed||!Number.isSafeInteger(rows)||rows<0)throw csvIntegrityError();this.sealed=Object.freeze({bytes:this.bytes,rows,sha256:this.hash.digest('hex'),chunks:this.hashes.length});return this.sealed;}
 verify(chunk:Buffer){
  if(this.closed||!this.sealed||!Buffer.isBuffer(chunk)||!chunk.length||chunk.length>csvChunkBytes||this.next>=this.hashes.length||!timingSafeEqual(createHash('sha256').update(chunk).digest(),this.hashes[this.next]))throw csvIntegrityError();this.next++;this.deliveredBytes+=chunk.length;this.delivery.update(chunk);
 }
 finishDelivery(rows:number){if(this.closed||this.completed||!this.sealed||rows!==this.sealed.rows||this.next!==this.hashes.length||this.deliveredBytes!==this.sealed.bytes)throw csvIntegrityError();this.completed=true;if(this.delivery.digest('hex')!==this.sealed.sha256)throw csvIntegrityError();}
 dispose(){if(this.closed)return;this.closed=true;this.hashes.length=0;for(const release of this.leases)release();this.leases.length=0;}
}
