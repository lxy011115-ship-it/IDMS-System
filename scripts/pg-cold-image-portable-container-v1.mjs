import {randomUUID,randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {backupRegular,backupUnchanged,backupDirectory,readExactly,writeExactly,eachChunk,BackupWorkspace,backupCheckSignal} from './field-backup-io.mjs';
import {coldNeedV1 as need,coldExactV1,coldUuidV1,coldManifestV1,coldImageLimitsV1 as limits} from './pg-cold-image-portable-manifest-v1.mjs';
import {coldConfigV1,coldConfigNamesV1} from './pg-cold-image-config-v1.mjs';
import {join} from 'node:path';
export const coldImageMaxBytesV1=36+4+limits.manifestBytes+limits.totalBytes+16;
const magic=Buffer.from('IDMSPCI1'),hash=()=>createHash('sha256');
async function readKey(file){const f=await backupRegular(file,512);try{const raw=new TextDecoder('utf-8',{fatal:true}).decode(await readExactly(f.file,Number(f.stat.size),0)),k=JSON.parse(raw);need(coldExactV1(k,['format','keyId','key'])&&k.format==='IDMS_PG_COLD_IMAGE_KEY_V1'&&coldUuidV1(k.keyId)&&typeof k.key==='string'&&/^[A-Za-z0-9_-]{43}$/.test(k.key)&&canonical(k)===raw,'COLD_IMAGE_KEY');const bytes=Buffer.from(k.key,'base64url');need(bytes.length===32&&bytes.toString('base64url')===k.key,'COLD_IMAGE_KEY');await backupUnchanged(f);return{keyId:k.keyId,bytes};}finally{await f.file.close();}}
export async function generateColdImageKeyV1(file){await privateNewFile(file,canonical({format:'IDMS_PG_COLD_IMAGE_KEY_V1',keyId:randomUUID(),key:randomBytes(32).toString('base64url')}));return coldImageKeyBindingV1(file);}
export async function coldImageKeyBindingV1(file){const k=await readKey(file);try{return{keyId:k.keyId,keySha256:hash().update(k.bytes).digest('hex')};}finally{k.bytes.fill(0);}}
export async function sealColdImageV1({manifest,sourceDirectory,keyFile,out,signal}){
 const m=coldManifestV1(manifest),metadata=Buffer.from(canonical(m)),k=await readKey(keyFile);
 try{const header=Buffer.concat([magic,Buffer.from(k.keyId.replaceAll('-',''),'hex'),randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',k.bytes,header.subarray(24));cipher.setAAD(header);await writeExactly(out,header,0);let position=36;
  const put=async b=>{const v=cipher.update(b);await writeExactly(out,v,position);position+=v.length;},n=Buffer.alloc(4);n.writeUInt32BE(metadata.length);await put(n);await put(metadata);
  for(const row of m.tree.files){const f=await backupRegular(join(sourceDirectory,...row.path.split('/')),limits.fileBytes);try{need(Number(f.stat.size)===row.bytes,'COLD_IMAGE_SOURCE_CHANGED');const h=hash();await eachChunk(f.file,0,row.bytes,async b=>{h.update(b);await put(b);},signal);need(h.digest('hex')===row.sha256,'COLD_IMAGE_SOURCE_CHANGED');await backupUnchanged(f);}finally{await f.file.close();}}
  const last=cipher.final();await writeExactly(out,last,position);position+=last.length;await writeExactly(out,cipher.getAuthTag(),position);position+=16;await out.sync();return{bytes:position,keyId:k.keyId};
 }finally{k.bytes.fill(0);}
}
/** Full AEAD authentication and every file SHA are checked before caller obtains plaintext. */
export async function authenticateColdImageV1({backupFile,keyFile,workDirectory,signal,onPhase=async()=>{}}){
 const input=await backupRegular(backupFile,coldImageMaxBytesV1);let k,workspace,plain;
 try{const size=Number(input.stat.size);need(size>=56,'COLD_IMAGE_TRUNCATED');const header=await readExactly(input.file,36,0);need(header.subarray(0,8).equals(magic),'COLD_IMAGE_FORMAT');k=await readKey(keyFile);need(header.subarray(8,24).toString('hex')===k.keyId.replaceAll('-',''),'COLD_IMAGE_KEY');
  workspace=await BackupWorkspace.create(await backupDirectory(workDirectory));plain=await workspace.createFile('plaintext.bin');
  const cipher=createDecipheriv('aes-256-gcm',k.bytes,header.subarray(24));cipher.setAAD(header);cipher.setAuthTag(await readExactly(input.file,16,size-16));let position=0;
  await eachChunk(input.file,36,size-52,async b=>{const out=cipher.update(b);await writeExactly(plain.file,out,position);position+=out.length;},signal);
  let last;try{last=cipher.final();}catch{need(false,'COLD_IMAGE_AUTHENTICATION');}await writeExactly(plain.file,last,position);position+=last.length;await backupUnchanged(input);
  need(position>=4,'COLD_IMAGE_MANIFEST');const n=(await readExactly(plain.file,4,0)).readUInt32BE(0);need(n>0&&n<=limits.manifestBytes&&4+n<=position,'COLD_IMAGE_MANIFEST');const raw=new TextDecoder('utf-8',{fatal:true}).decode(await readExactly(plain.file,n,4)),m=coldManifestV1(JSON.parse(raw));need(canonical(m)===raw&&position===4+n+m.totalBytes,'COLD_IMAGE_PAYLOAD');
  let at=4+n;for(const f of m.tree.files){const h=hash();await eachChunk(plain.file,at,f.bytes,b=>h.update(b),signal);need(h.digest('hex')===f.sha256,'COLD_IMAGE_FILE_HASH');if(coldConfigNamesV1.has(f.path)){need(f.bytes<=1024**2,'COLD_IMAGE_CONFIG_LIMIT');coldConfigV1(f.path,await readExactly(plain.file,f.bytes,at));}at+=f.bytes;}
  await plain.file.sync();backupCheckSignal(signal);await onPhase('AUTHENTICATED');const owned=workspace,handle=plain.file;workspace=null;plain=null;let disposed=false;
  return{manifest:m,keyId:k.keyId,plain:handle,start:4+n,fullArchiveAuthenticationVerified:true,fullFileHashesVerified:true,dispose:async()=>{if(disposed)return;await handle.close();await owned.cleanup();disposed=true;}};
 }finally{k?.bytes.fill(0);await input.file.close();await plain?.file.close();if(workspace)await workspace.cleanup();}
}
