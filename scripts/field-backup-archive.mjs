import {randomUUID,randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {link,unlink,lstat,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {fieldBackupManifest,fieldBackupLimits,backupError} from './field-backup-manifest.mjs';
import {backupRegular,backupUnchanged,backupDirectory,readExactly,writeExactly,eachChunk,backupCheckSignal,BackupWorkspace} from './field-backup-io.mjs';
const magic=Buffer.from('IDMSFLB1'),headerBytes=36,tagBytes=16,maxArchiveBytes=headerBytes+4+fieldBackupLimits.manifestBytes+fieldBackupLimits.dumpBytes+tagBytes;
const sha=()=>createHash('sha256'),fail=code=>{throw backupError(code);};
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s)&&s!=='00000000-0000-0000-0000-000000000000';
async function key(file){const entry=await backupRegular(file,512);try{const raw=new TextDecoder('utf-8',{fatal:true}).decode(await readExactly(entry.file,Number(entry.stat.size),0)),k=JSON.parse(raw);if(!k||Object.keys(k).sort().join(',')!=='format,key,keyId'||k.format!=='idms-field-backup-key-v1'||!uuid(k.keyId)||typeof k.key!=='string'||! /^(?:[A-Za-z0-9+/]{43}=)$/.test(k.key)||raw!==canonical(k))fail('FIELD_BACKUP_KEY_INVALID');const bytes=Buffer.from(k.key,'base64');if(bytes.length!==32||bytes.toString('base64')!==k.key)fail('FIELD_BACKUP_KEY_INVALID');await backupUnchanged(entry);return {keyId:k.keyId,bytes};}catch(e){if(e.code?.startsWith('FIELD_BACKUP_'))throw e;fail('FIELD_BACKUP_KEY_INVALID');}finally{await entry.file.close();}}
export async function generateFieldBackupKey(file){const k={format:'idms-field-backup-key-v1',keyId:randomUUID(),key:randomBytes(32).toString('base64')};await privateNewFile(file,canonical(k));return {keyId:k.keyId,file:resolve(file)};}

async function encryptToHandle(m,metadata,dump,k,archive,signal){
  const header=Buffer.concat([magic,Buffer.from(k.keyId.replaceAll('-',''),'hex'),randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',k.bytes,header.subarray(24));cipher.setAAD(header);await writeExactly(archive.file,header,0);let offset=header.length;
  const put=async data=>{const out=cipher.update(data);await writeExactly(archive.file,out,offset);offset+=out.length;},length=Buffer.alloc(4);length.writeUInt32BE(metadata.length);await put(length);await put(metadata);const digest=sha();
  await eachChunk(dump.file,0,m.dump.bytes,async part=>{digest.update(part);await put(part);},signal);if(digest.digest('hex')!==m.dump.sha256)fail('FIELD_BACKUP_DUMP_INVALID');await backupUnchanged(dump);
  const final=cipher.final();await writeExactly(archive.file,final,offset);offset+=final.length;const tag=cipher.getAuthTag();await writeExactly(archive.file,tag,offset);offset+=tag.length;await archive.file.sync();return offset;
}
// This module does not connect to any database or execute pg_restore. A caller
// receives a dump only after the complete GCM tag, strict manifest and dump hash.
export async function sealFieldBackup({manifest,dumpFile,keyFile,outputDirectory,signal}){
 const m=fieldBackupManifest(manifest,manifest?.tenantId),metadata=Buffer.from(canonical(m)),outputRoot=await backupDirectory(outputDirectory),dump=await backupRegular(dumpFile,fieldBackupLimits.dumpBytes);let k,workspace,archive;
 try{
  k=await key(keyFile);
  backupCheckSignal(signal);
  if(Number(dump.stat.size)!==m.dump.bytes||(await readExactly(dump.file,5,0)).toString()!=='PGDMP')fail('FIELD_BACKUP_DUMP_INVALID');
  workspace=await BackupWorkspace.create(outputRoot);archive=await workspace.createFile('archive.bin');
  const offset=await encryptToHandle(m,metadata,dump,k,archive,signal);await archive.file.close();archive=null;
  const destination=join(outputRoot,m.tenantId+'-'+m.backupId+'.idmsfieldbackup');
  backupCheckSignal(signal);
  // Creating a link is atomic and refuses an existing name. No rename may
  // silently overwrite an unrelated backup. A crash leaving two links makes
  // the regular-file guard reject the archive until explicitly inspected.
  await link(join(workspace.path,'archive.bin'),destination);await unlink(join(workspace.path,'archive.bin'));const s=await lstat(destination);if(!s.isFile()||s.nlink!==1||s.size!==offset)fail('FIELD_BACKUP_PUBLICATION_UNCONFIRMED');await workspace.cleanup();workspace=null;
  return {format:'idms-field-backup-created-v1',backupId:m.backupId,tenantId:m.tenantId,file:destination,encryptedBytes:offset,dumpBytes:m.dump.bytes,fullyAuthenticatedOnOpenRequired:true,restorePerformed:false,productionAcceptance:false};
 }finally{k?.bytes.fill(0);await archive?.file.close();await dump.file.close();if(workspace)await workspace.cleanup();}
}

export async function authenticateFieldBackup({backupFile,keyFile,tenantId,workDirectory,signal}){
 const archive=await backupRegular(backupFile,maxArchiveBytes);let k,workspace,plaintext,dump;
 try{
  k=await key(keyFile);
  backupCheckSignal(signal);
  const size=Number(archive.stat.size);if(size<headerBytes+4+2+5+tagBytes)fail('FIELD_BACKUP_ARCHIVE_INVALID');const header=await readExactly(archive.file,headerBytes,0);if(!header.subarray(0,8).equals(magic))fail('FIELD_BACKUP_ARCHIVE_INVALID');if(header.subarray(8,24).toString('hex')!==k.keyId.replaceAll('-',''))fail('FIELD_BACKUP_KEY_MISMATCH');
  workspace=await BackupWorkspace.create(await backupDirectory(workDirectory));plaintext=await workspace.createFile('plaintext.bin');const decipher=createDecipheriv('aes-256-gcm',k.bytes,header.subarray(24));decipher.setAAD(header);decipher.setAuthTag(await readExactly(archive.file,tagBytes,size-tagBytes));let position=0;
  await eachChunk(archive.file,headerBytes,size-headerBytes-tagBytes,async part=>{const clear=decipher.update(part);await writeExactly(plaintext.file,clear,position);position+=clear.length;},signal);let final;try{final=decipher.final();}catch{fail('FIELD_BACKUP_AUTHENTICATION_FAILED');}await writeExactly(plaintext.file,final,position);position+=final.length;await backupUnchanged(archive);
  const length=(await readExactly(plaintext.file,4,0)).readUInt32BE(0);if(length<2||length>fieldBackupLimits.manifestBytes||length>position-9)fail('FIELD_BACKUP_MANIFEST_INVALID');const metadata=await readExactly(plaintext.file,length,4);let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(metadata);}catch{fail('FIELD_BACKUP_MANIFEST_INVALID');}let parsed;try{parsed=JSON.parse(raw);}catch{fail('FIELD_BACKUP_MANIFEST_INVALID');}const manifest=fieldBackupManifest(parsed,tenantId);if(raw!==canonical(manifest)||manifest.dump.bytes!==position-4-length||(await readExactly(plaintext.file,5,4+length)).toString()!=='PGDMP')fail('FIELD_BACKUP_MANIFEST_INVALID');
  dump=await workspace.createFile('dump.pgdump');const digest=sha();let at=0;await eachChunk(plaintext.file,4+length,manifest.dump.bytes,async part=>{digest.update(part);await writeExactly(dump.file,part,at);at+=part.length;},signal);if(digest.digest('hex')!==manifest.dump.sha256)fail('FIELD_BACKUP_DUMP_INVALID');await dump.file.sync();await dump.file.close();dump=null;await plaintext.file.close();plaintext=null;backupCheckSignal(signal);
  const owned=workspace;workspace=null;return {manifest,dumpFile:join(owned.path,'dump.pgdump'),fullArchiveAuthenticationVerified:true,fullDumpSha256Verified:true,restorePerformed:false,dispose:()=>owned.cleanup()};
 }finally{k?.bytes.fill(0);await dump?.file.close();await plaintext?.file.close();await archive.file.close();if(workspace)await workspace.cleanup();}
}

export async function fieldBackupKeyBinding(file){const k=await key(file);try{return {keyId:k.keyId,keySha256:createHash('sha256').update(k.bytes).digest('hex')};}finally{k.bytes.fill(0);}}
export async function hashFieldBackupFile(path){const f=await backupRegular(path,maxArchiveBytes);try{const h=sha();await eachChunk(f.file,0,Number(f.stat.size),async b=>{h.update(b);});await backupUnchanged(f);return {bytes:Number(f.stat.size),sha256:h.digest('hex')};}finally{await f.file.close();}}
// Only the formal coordinator publishes this deterministic, intent-owned
// partial. The crypto operation itself never replaces a completed backup.
export async function stageFieldBackup({manifest,dumpFile,keyFile,outputDirectory,expectedKeyBinding,signal}){
 const m=fieldBackupManifest(manifest,manifest?.tenantId),metadata=Buffer.from(canonical(m)),root=await backupDirectory(outputDirectory),path=join(root,'.'+m.tenantId+'-'+m.backupId+'.idmsfieldpartial'),dump=await backupRegular(dumpFile,fieldBackupLimits.dumpBytes);let k,archive;
 try{k=await key(keyFile);if(!expectedKeyBinding||expectedKeyBinding.keyId!==k.keyId||expectedKeyBinding.keySha256!==createHash('sha256').update(k.bytes).digest('hex'))fail('FIELD_BACKUP_KEY_MISMATCH');backupCheckSignal(signal);if(Number(dump.stat.size)!==m.dump.bytes||(await readExactly(dump.file,5,0)).toString()!=='PGDMP')fail('FIELD_BACKUP_DUMP_INVALID');let before;try{const f=await backupRegular(path,maxArchiveBytes);before=f.stat;await f.file.close();}catch(e){if(e.code!=='ENOENT')throw e;}const handle=await open(path,before?'r+':'wx+',0o600);archive={file:handle,path};const current=await handle.stat({bigint:true});if(!current.isFile()||current.nlink!==1n||before&&(current.dev!==before.dev||current.ino!==before.ino))fail('FIELD_BACKUP_FILE_INVALID');await handle.truncate(0);const encryptedBytes=await encryptToHandle(m,metadata,dump,k,archive,signal);await handle.close();archive=null;const verified=await hashFieldBackupFile(path);if(verified.bytes!==encryptedBytes)fail('FIELD_BACKUP_INPUT_CHANGED');return {file:path,encryptedBytes,archiveSha256:verified.sha256};
 }finally{k?.bytes.fill(0);await archive?.file.close();await dump.file.close();}
}
