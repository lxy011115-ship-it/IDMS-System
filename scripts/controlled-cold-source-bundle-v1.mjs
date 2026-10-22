import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {privateNewFile} from './backup-support.mjs';
import {canonical} from '../server/imports.ts';
import {validateTenantPayload} from '../server/entity-repository.ts';

const hash=v=>createHash('sha256').update(v).digest('hex');
export function validateControlledColdSourceBundleV1(value){
 assert.equal(value?.format,'IDMS_CONTROLLED_COLD_SOURCE_BUNDLE_V1');assert.equal(value.tenantId,'acme');
 assert(['PRIVATE_READ_ONLY_ACME_V1','PUBLIC_APPROVED_TEMPLATES_V1'].includes(value.profile));
 validateTenantPayload(value.payload,'acme');assert.equal(hash(canonical(value.payload)),value.payloadSha256);
 const files=value.payload.imports.batches.map(b=>{const bytes=Buffer.from(b.originalBase64,'base64');assert.equal(bytes.toString('base64'),b.originalBase64);assert.equal(hash(bytes),b.fileSha256);return{sha256:b.fileSha256,bytes:bytes.length};});
 assert.equal(canonical(files),canonical(value.evidence.files));assert.equal(value.evidence.fileCount,files.length);assert.equal(value.evidence.totalBytes,files.reduce((n,f)=>n+f.bytes,0));assert(files.length>0&&files.length<=64);
 if(value.profile==='PRIVATE_READ_ONLY_ACME_V1'){assert.equal(value.evidence.readOnly,true);assert.equal(files.length,6);assert.equal(value.evidence.totalBytes,14513);}
 else{assert.equal(value.evidence.readOnly,false);assert.equal(value.evidence.publicTemplateInputs.length,8);assert.equal(files.length,8);assert(value.payload.imports.batches.every(b=>b.status==='COMMITTED'));}
 return value;
}
export async function writeControlledColdSourceBundleV1(file,{profile,payload,evidence}){
 const value={format:'IDMS_CONTROLLED_COLD_SOURCE_BUNDLE_V1',tenantId:'acme',profile,payload,payloadSha256:hash(canonical(payload)),evidence},bytes=canonical(validateControlledColdSourceBundleV1(value));
 await privateNewFile(file,bytes);return{file,sha256:hash(bytes),bytes:Buffer.byteLength(bytes),profile,fileCount:evidence.fileCount,totalOriginalBytes:evidence.totalBytes};
}
export async function readControlledColdSourceBundleV1(file,expectedSha256){
 assert.match(expectedSha256,/^[a-f0-9]{64}$/);const f=await backupRegular(file,32*1024**2);try{const bytes=await readExactly(f.file,Number(f.stat.size),0);await backupUnchanged(f);assert.equal(hash(bytes),expectedSha256,'CONTROLLED_COLD_SOURCE_BUNDLE_SHA');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return validateControlledColdSourceBundleV1(value);}finally{await f.file.close();}
}
