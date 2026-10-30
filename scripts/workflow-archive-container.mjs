import {randomUUID,randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {open,lstat,link,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {canonical} from '../server/imports.ts';
import {privateNewFile} from './backup-support.mjs';
import {backupRegular,backupUnchanged,backupDirectory,readExactly,writeExactly,eachChunk,BackupWorkspace,backupCheckSignal} from './field-backup-io.mjs';
import {workflowArchiveLimits as limits,workflowArchiveManifest,workflowArchiveUuid} from './workflow-archive-format.mjs';
import {workflowRequire as need} from './workflow-archive-facts.mjs';
const magic=Buffer.from('IDMSWFA2'),maxArchive=36+4+limits.manifestBytes+limits.dumpBytes+16;
const hash=()=>createHash('sha256');
async function key(file){const f=await backupRegular(file,512);try{const bytes=await readExactly(f.file,Number(f.stat.size),0),raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes),k=JSON.parse(raw);
 need(k&&Object.keys(k).sort().join(',')==='format,key,keyId'&&k.format==='idms-workflow-archive-key-v2'&&workflowArchiveUuid(k.keyId)&&typeof k.key==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(k.key)&&canonical(k)===raw,'WF_ARCHIVE_KEY');
 const value=Buffer.from(k.key,'base64');need(value.length===32&&value.toString('base64')===k.key,'WF_ARCHIVE_KEY');await backupUnchanged(f);return {keyId:k.keyId,bytes:value};}finally{await f.file.close();}}
export async function generateWorkflowArchiveKey(file){await privateNewFile(file,canonical({format:'idms-workflow-archive-key-v2',keyId:randomUUID(),key:randomBytes(32).toString('base64')}));return workflowArchiveKeyBinding(file);}
export async function workflowArchiveKeyBinding(file){const k=await key(file);try{return {keyId:k.keyId,keySha256:hash().update(k.bytes).digest('hex')};}finally{k.bytes.fill(0);}}
export async function hashWorkflowArchiveFile(file,max=maxArchive){const f=await backupRegular(file,max);try{const h=hash();await eachChunk(f.file,0,Number(f.stat.size),b=>h.update(b));await backupUnchanged(f);return {bytes:Number(f.stat.size),sha256:h.digest('hex')};}finally{await f.file.close();}}
export async function sealWorkflowArchive({manifest,dumpFile,keyFile,stageFile,signal}){
 const m=workflowArchiveManifest(manifest,manifest?.tenantId),metadata=Buffer.from(canonical(m)),dump=await backupRegular(dumpFile,limits.dumpBytes);let k,out,created;
 try{
  await backupDirectory(resolve(stageFile,'..'));need(Number(dump.stat.size)===m.dump.bytes&&(await readExactly(dump.file,5,0)).toString()==='PGDMP','WF_ARCHIVE_DUMP');k=await key(keyFile);out=await open(stageFile,'wx+',0o600);created=await out.stat({bigint:true});
  const header=Buffer.concat([magic,Buffer.from(k.keyId.replaceAll('-',''),'hex'),randomBytes(12)]),cipher=createCipheriv('aes-256-gcm',k.bytes,header.subarray(24));cipher.setAAD(header);let offset=36;await writeExactly(out,header,0);
  const put=async b=>{const v=cipher.update(b);await writeExactly(out,v,offset);offset+=v.length;},n=Buffer.alloc(4);n.writeUInt32BE(metadata.length);await put(n);await put(metadata);const h=hash();
  await eachChunk(dump.file,0,m.dump.bytes,async b=>{h.update(b);await put(b);},signal);need(h.digest('hex')===m.dump.sha256,'WF_ARCHIVE_DUMP');await backupUnchanged(dump);
  const last=cipher.final();await writeExactly(out,last,offset);offset+=last.length;await writeExactly(out,cipher.getAuthTag(),offset);offset+=16;await out.sync();await out.close();out=null;
  return {file:resolve(stageFile),...(await hashWorkflowArchiveFile(stageFile)),identity:{dev:String(created.dev),ino:String(created.ino)},backupId:m.backupId};
 }finally{k?.bytes.fill(0);await out?.close();await dump.file.close();}
}
export async function authenticateWorkflowArchiveV2({backupFile,keyFile,tenantId,workDirectory,signal,registerWorkspace=async()=>{},onPhase=async()=>{}}){
 const input=await backupRegular(backupFile,maxArchive);let k,workspace,plain,dump;
 try{
  const size=Number(input.stat.size);need(size>=61,'WF_ARCHIVE_TRUNCATED');const header=await readExactly(input.file,36,0);need(header.subarray(0,8).equals(magic),'WF_ARCHIVE_FORMAT');k=await key(keyFile);need(header.subarray(8,24).toString('hex')===k.keyId.replaceAll('-',''),'WF_ARCHIVE_KEY');
  workspace=await BackupWorkspace.create(await backupDirectory(workDirectory));await registerWorkspace(workspace.path);plain=await workspace.createFile('plaintext.bin');
  const cipher=createDecipheriv('aes-256-gcm',k.bytes,header.subarray(24));cipher.setAAD(header);cipher.setAuthTag(await readExactly(input.file,16,size-16));let position=0;
  await eachChunk(input.file,36,size-52,async b=>{const out=cipher.update(b);await writeExactly(plain.file,out,position);position+=out.length;},signal);
  let final;try{final=cipher.final();}catch{need(false,'WF_ARCHIVE_AUTHENTICATION');}await writeExactly(plain.file,final,position);position+=final.length;await backupUnchanged(input);
  const n=(await readExactly(plain.file,4,0)).readUInt32BE(0);need(n>0&&n<=limits.manifestBytes&&4+n+5<=position,'WF_ARCHIVE_MANIFEST');const raw=new TextDecoder('utf-8',{fatal:true}).decode(await readExactly(plain.file,n,4)),m=workflowArchiveManifest(JSON.parse(raw),tenantId);
  need(canonical(m)===raw&&m.dump.bytes===position-4-n&&(await readExactly(plain.file,5,4+n)).toString()==='PGDMP','WF_ARCHIVE_DUMP');
  dump=await workspace.createFile('dump.pgdump');const h=hash();let at=0;await eachChunk(plain.file,4+n,m.dump.bytes,async b=>{h.update(b);await writeExactly(dump.file,b,at);at+=b.length;},signal);need(h.digest('hex')===m.dump.sha256,'WF_ARCHIVE_DUMP');
  await dump.file.sync();await dump.file.close();dump=null;await plain.file.close();plain=null;backupCheckSignal(signal);await onPhase('AUTHENTICATED');const owned=workspace;workspace=null;
  return {manifest:m,dumpFile:join(owned.path,'dump.pgdump'),fullArchiveAuthenticationVerified:true,fullDumpSha256Verified:true,dispose:()=>owned.cleanup()};
 }finally{k?.bytes.fill(0);await dump?.file.close();await plain?.file.close();await input.file.close();if(workspace)await workspace.cleanup();}
}
export async function publishWorkflowArchive({manifest,stageProof,outputDirectory,signal}){
 const m=workflowArchiveManifest(manifest,manifest.tenantId),root=await backupDirectory(outputDirectory),stage=await backupRegular(stageProof.file,maxArchive);
 try{need(stageProof.backupId===m.backupId,'WF_ARCHIVE_PUBLICATION');need(String(stage.stat.dev)===stageProof.identity.dev&&String(stage.stat.ino)===stageProof.identity.ino,'WF_ARCHIVE_STAGE_CHANGED');need(canonical(await hashWorkflowArchiveFile(stageProof.file))===canonical({bytes:stageProof.bytes,sha256:stageProof.sha256}),'WF_ARCHIVE_STAGE_CHANGED');
  const destination=join(root,m.tenantId+'-'+m.backupId+'.idmsworkflowbackup');backupCheckSignal(signal);await link(stageProof.file,destination);await backupUnchangedAfterLink(stage);await unlink(stageProof.file);return {file:destination,backupId:m.backupId,bytes:stageProof.bytes,sha256:stageProof.sha256};
 }finally{await stage.file.close();}
}
async function backupUnchangedAfterLink(entry){const s=await entry.file.stat({bigint:true});need(s.dev===entry.stat.dev&&s.ino===entry.stat.ino&&s.size===entry.stat.size&&s.mtimeNs===entry.stat.mtimeNs&&s.nlink===2n,'WF_ARCHIVE_PUBLICATION');}
// A controller crash between link and unlink leaves exactly two known aliases.
export async function finishWorkflowArchiveLink({stageProof,backupFile}){
 need(resolve(stageProof.file)!==resolve(backupFile),'WF_ARCHIVE_PUBLICATION');
 await backupDirectory(resolve(stageProof.file,'..'));await backupDirectory(resolve(backupFile,'..'));
 const a=await lstat(stageProof.file,{bigint:true}),b=await lstat(backupFile,{bigint:true});need(a.isFile()&&b.isFile()&&!a.isSymbolicLink()&&!b.isSymbolicLink()&&a.nlink===2n&&b.nlink===2n&&a.dev===b.dev&&a.ino===b.ino&&String(a.dev)===stageProof.identity.dev&&String(a.ino)===stageProof.identity.ino&&Number(a.size)===stageProof.bytes,'WF_ARCHIVE_PUBLICATION');
 const file=await open(stageProof.file,'r');try{const s=await file.stat({bigint:true});need(s.dev===a.dev&&s.ino===a.ino&&s.nlink===2n,'WF_ARCHIVE_PUBLICATION');const h=hash();await eachChunk(file,0,Number(s.size),part=>h.update(part));need(h.digest('hex')===stageProof.sha256,'WF_ARCHIVE_PUBLICATION');const last=await file.stat({bigint:true});need(last.size===s.size&&last.mtimeNs===s.mtimeNs&&last.ctimeNs===s.ctimeNs&&last.nlink===2n,'WF_ARCHIVE_PUBLICATION');}finally{await file.close();}
 await unlink(stageProof.file);return hashWorkflowArchiveFile(backupFile);
}
