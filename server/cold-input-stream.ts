import {createHash} from 'node:crypto';
import type pg from 'pg';
import type {BatchBody,Row} from './imports.ts';
import type {BatchMetadata,FrozenInputEvidence} from './batch-evidence.ts';
import {profileReferenceText} from './equipment-profiles.ts';
import {batchInputFields} from './import-revisions.ts';
import {emitCanonical,canonicalDigest} from './canonical-state.ts';
import {holdAllocation,holdValue} from './capacity.ts';
import {streamRows} from './pg-row-stream.ts';
import {ColdCorrectionIndex,coldImportIntegrity,coldRank,coldObject} from './cold-import-corrections.ts';
import {coldCount,checkColdImport} from './cold-import-sources.ts';

// One fixed entry per selected input: SHA256, original SQL ordinal, input
// position. Zero ordinal means unfilled. Reserve before allocating the buffer.
const entryBytes=48;
export class ColdInputStream {
 private manifest:Buffer;private releaseManifest:()=>void;private leases:(()=>void)[]=[];
 private rows?:Row[];private valid?:Row[];private phase=0;private digestValue?:string;
 private profileRef:string|undefined;private sameProfile=true;private validEqualsInput=true;
 private client:pg.PoolClient;private meta:BatchMetadata;readonly count:number;private selected:number;private corrections:ColdCorrectionIndex;
 private constructor(client:pg.PoolClient,meta:BatchMetadata,count:number,selected:number,corrections:ColdCorrectionIndex,capture:boolean){
  this.client=client;this.meta=meta;this.count=count;this.selected=selected;this.corrections=corrections;
  const bytes=selected*entryBytes;if(!Number.isSafeInteger(bytes))throw coldImportIntegrity();
  const release=holdAllocation(bytes);try{this.manifest=Buffer.alloc(bytes);this.releaseManifest=release;}catch(e){release();throw e;}
  try{this.profileRef=meta.equipmentProfileBinding?profileReferenceText(meta.equipmentProfileBinding):undefined;if(this.profileRef!==undefined)this.leases.push(holdValue(this.profileRef));if(capture){this.rows=[];this.valid=[];}}catch(e){release();throw e;}
 }
 static async open(client:pg.PoolClient,meta:BatchMetadata,corrections:ColdCorrectionIndex,capture=false){
  checkColdImport();const rows=(await client.query('/* IDMS_COLD_INPUT_COUNTS */ SELECT count(*)::text AS inputs,count(*) FILTER (WHERE valid_ordinal IS NOT NULL)::text AS selected FROM business_import_input_rows WHERE tenant_id=$1 AND batch_id=$2::uuid',[meta.tenantId,meta.batchId])).rows;
  checkColdImport();if(rows.length!==1)throw coldImportIntegrity();const count=coldCount(rows[0].inputs),selected=coldCount(rows[0].selected);
  if(selected>count||!Array.isArray(meta.lineNumbers)||meta.lineNumbers.length!==count||meta.lineNumbers.some(n=>!Number.isSafeInteger(n)||n<2))throw coldImportIntegrity();
  corrections.beginBatch(meta,count);return new ColdInputStream(client,meta,count,selected,corrections,capture);
 }
 private capture(target:Row[]|undefined,row:Row){if(!target)return;const release=holdValue(row);let slot=()=>{};try{slot=holdAllocation(128);this.leases.push(()=>{release();slot();});target.push(row);}catch(e){release();slot();throw e;}}
 async inputRows(write:(text:string)=>void){
  checkColdImport();if(this.phase!==0)throw coldImportIntegrity();this.phase=1;
  const hash=createHash('sha256'),frozen=(text:string)=>hash.update(text),field=(v:unknown)=>v===undefined?frozen('undefined'):emitCanonical(v,frozen),fields=batchInputFields(this.meta),keys=[...Object.keys(fields),'rows'].sort(),at=keys.indexOf('rows');
  frozen('{');for(let i=0;i<=at;i++){if(i)frozen(',');emitCanonical(keys[i],frozen);frozen(':');if(i<at)field((fields as any)[keys[i]]);}frozen('[');write('[');
  let previous=0n,count=0,selected=0,rowLease=()=>{};
  try{await streamRows<any>(this.client,'/* IDMS_COLD_IMPORT_INPUTS */ SELECT r.tenant_id,r.batch_id::text,r.ordinal::text,r.valid_ordinal,r.body FROM business_import_input_rows r WHERE r.tenant_id=$1 AND r.batch_id=$2::uuid ORDER BY r.ordinal',row=>{
   rowLease();rowLease=()=>{};checkColdImport();rowLease=holdValue(row);const ordinal=coldRank(row.ordinal),valid=row.valid_ordinal;
   if(row.tenant_id!==this.meta.tenantId||row.batch_id!==this.meta.batchId||ordinal<=previous||count>=this.count||!coldObject(row.body)||valid!==null&&(!Number.isSafeInteger(valid)||valid<1||valid>this.selected))throw coldImportIntegrity();previous=ordinal;
   if(valid!==null){const offset=(valid-1)*entryBytes;if(this.manifest.readBigUInt64BE(offset+32)!==0n)throw coldImportIntegrity();this.manifest.write(canonicalDigest(row.body),offset,32,'hex');this.manifest.writeBigUInt64BE(ordinal,offset+32);this.manifest.writeBigUInt64BE(BigInt(count+1),offset+40);selected++;if(valid!==count+1)this.validEqualsInput=false;}
   if(count){write(',');frozen(',');}emitCanonical(row.body,text=>{write(text);frozen(text);});
   if(row.body.source_profile_ref!==this.profileRef)this.sameProfile=false;
   this.corrections.addInput(this.meta,count,row.body);this.capture(this.rows,row.body);count++;
  },()=>{},[this.meta.tenantId,this.meta.batchId]);}finally{rowLease();}
  if(count!==this.count||selected!==this.selected)throw coldImportIntegrity();write(']');frozen(']');for(let i=at+1;i<keys.length;i++){frozen(',');emitCanonical(keys[i],frozen);frozen(':');field((fields as any)[keys[i]]);}frozen('}');
  this.digestValue=hash.digest('hex');if(this.digestValue!==this.meta.snapshotDigest)throw coldImportIntegrity();this.phase=2;
 }
 async validRows(write:(text:string)=>void){
  checkColdImport();if(this.phase!==2)throw coldImportIntegrity();this.phase=3;write('[');let count=0,rowLease=()=>{};
  try{await streamRows<any>(this.client,'/* IDMS_COLD_VALID_INPUTS */ SELECT r.tenant_id,r.batch_id::text,r.ordinal::text,r.valid_ordinal,r.body FROM business_import_input_rows r WHERE r.tenant_id=$1 AND r.batch_id=$2::uuid AND r.valid_ordinal IS NOT NULL ORDER BY r.valid_ordinal',row=>{
   rowLease();rowLease=()=>{};checkColdImport();rowLease=holdValue(row);const ordinal=coldRank(row.ordinal),valid=row.valid_ordinal;
   if(row.tenant_id!==this.meta.tenantId||row.batch_id!==this.meta.batchId||count>=this.selected||valid!==count+1||!coldObject(row.body))throw coldImportIntegrity();const offset=count*entryBytes;
   if(ordinal!==this.manifest.readBigUInt64BE(offset+32)||canonicalDigest(row.body)!==this.manifest.toString('hex',offset,offset+32))throw coldImportIntegrity();
   if(this.manifest.readBigUInt64BE(offset+40)!==BigInt(count+1))this.validEqualsInput=false;
   if(count)write(',');emitCanonical(row.body,write);this.capture(this.valid,row.body);count++;
  },()=>{},[this.meta.tenantId,this.meta.batchId]);}finally{rowLease();}
  if(count!==this.selected)throw coldImportIntegrity();write(']');this.validEqualsInput &&=this.selected===this.count;this.corrections.endBatch(this.meta,this.count,this.validEqualsInput);this.phase=4;
 }
 evidence():FrozenInputEvidence{
  if(this.phase!==4||!this.digestValue)throw coldImportIntegrity();return {rowCount:this.count,digest:()=>this.digestValue!,profileReferencesMatch:ref=>this.count===0||this.sameProfile&&this.profileRef===ref};
 }
 capturedBatch():BatchBody{if(this.phase!==4||!this.rows||!this.valid)throw coldImportIntegrity();return {...this.meta,rows:[...this.rows],validRows:[...this.valid]};}
 dispose(){if(this.phase===5)return;this.phase=5;this.releaseManifest();this.manifest=Buffer.alloc(0);this.rows?.splice(0);this.valid?.splice(0);for(const release of this.leases)release();this.leases.length=0;}
}
