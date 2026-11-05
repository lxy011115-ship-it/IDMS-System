import {readFile,open,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {processFacts,sameProcess} from './existing-platform-process.mjs';
const need=(v,code)=>{if(!v)throw Error(code);},uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v),hash=b=>createHash('sha256').update(b).digest('hex');
async function readExact(file){
 const before=await lstat(file,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size>0n&&before.size<=8192n&&await realpath(file)===file,'RECOVERY_COORDINATOR_FILE_INVALID');const bytes=await readFile(file),after=await lstat(file,{bigint:true});need(before.ino===after.ino&&before.dev===after.dev&&before.size===after.size&&before.mtimeNs===after.mtimeNs,'RECOVERY_COORDINATOR_CHANGED');let value;try{value=JSON.parse(bytes);}catch{throw Error('RECOVERY_COORDINATOR_FILE_INVALID');}return {bytes,value,device:before.dev,inode:before.ino};
}
async function exclusive(file,bytes){const fd=await open(file,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}}
/** Explicit same-operation recovery only. Never reclaims an ordinary startup
 * lock, a different operation, a live/reused PID, or unowned partial history. */
export async function acquireRecoveryCoordinator(file,{operationId,purpose,directory,resume=false,assertSafe,facts=processFacts}){
 need(uuid(operationId)&&['QUALIFY','APPLY','STOP'].includes(purpose)&&typeof assertSafe==='function'&&resolve(file)===file&&resolve(directory)===directory&&await realpath(dirname(file))===dirname(file)&&await realpath(directory)===directory,'RECOVERY_COORDINATOR_CONTEXT_INVALID');
 const owner={format:'IDMS_EDGE_RECOVERY_COORDINATOR_V1',operationId,purpose,nonce:randomUUID(),process:await facts(process.pid)};need(owner.process?.pid===process.pid,'RECOVERY_COORDINATOR_OWNER_UNCONFIRMED');const bytes=Buffer.from(JSON.stringify(owner));await assertSafe();
 try{await exclusive(file,bytes);}catch(error){
  if(error.code!=='EEXIST')throw error;
  const old=await readExact(file),prior=old.value;need(prior.format===owner.format&&prior.operationId===operationId&&prior.purpose===purpose&&uuid(prior.nonce)&&prior.process?.pid&&prior.process.born&&prior.process.executable,'RECOVERY_COORDINATOR_FOREIGN_OWNER');
  const current=await facts(prior.process.pid);need(!current,current&&sameProcess(current,prior.process)?'RECOVERY_COORDINATOR_ALREADY_RUNNING':'RECOVERY_COORDINATOR_PID_REUSED');need(resume,'RECOVERY_COORDINATOR_EXPLICIT_RESUME_REQUIRED');
  const oldHash=hash(old.bytes);let reserved;
  for(let attempt=1;attempt<=3;attempt++){
   const base=join(directory,'coordinator-'+prior.nonce+'.attempt-'+attempt),marker=base+'.owner.private.json',archive=base+'.archived.private.json';let record;
   try{record=await readExact(marker);}catch(e){if(e.code!=='ENOENT')throw e;}
   if(record){
    const r=record.value;need(r.format==='IDMS_EDGE_COORDINATOR_ARCHIVE_V1'&&r.operationId===operationId&&r.purpose===purpose&&r.oldNonce===prior.nonce&&r.oldSha256===oldHash&&uuid(r.nonce)&&r.process?.pid&&r.process.born&&r.process.executable,'RECOVERY_COORDINATOR_ARCHIVE_UNOWNED');const active=await facts(r.process.pid);need(!active,active&&sameProcess(active,r.process)?'RECOVERY_COORDINATOR_ARCHIVE_RUNNING':'RECOVERY_COORDINATOR_ARCHIVE_PID_REUSED');continue;
   }
   const recordBytes=Buffer.from(JSON.stringify({format:'IDMS_EDGE_COORDINATOR_ARCHIVE_V1',operationId,purpose,oldNonce:prior.nonce,oldSha256:oldHash,nonce:owner.nonce,process:owner.process}));
   await exclusive(marker,recordBytes);await exclusive(archive,old.bytes);reserved={marker,archive};break;
  }
  need(reserved,'RECOVERY_COORDINATOR_ARCHIVE_LIMIT');await assertSafe();need(!await facts(prior.process.pid),'RECOVERY_COORDINATOR_OWNER_REAPPEARED');
  const still=await readExact(file);need(still.device===old.device&&still.inode===old.inode&&hash(still.bytes)===oldHash,'RECOVERY_COORDINATOR_CHANGED');
  const temporary=join(directory,'coordinator-new-'+owner.nonce+'.private.tmp');await exclusive(temporary,bytes);
  // Keep the coordinator pathname occupied through the replacement. A normal
  // starter can never acquire a gap between archival and the new ownership.
  const last=await readExact(file);need(last.device===old.device&&last.inode===old.inode&&hash(last.bytes)===oldHash,'RECOVERY_COORDINATOR_CHANGED');await rename(temporary,file);
  need((await readExact(file)).bytes.equals(bytes),'RECOVERY_COORDINATOR_REPLACEMENT_UNCONFIRMED');
 }
 return async()=>{const current=await readExact(file);need(current.bytes.equals(bytes)&&sameProcess(current.value.process,owner.process),'RECOVERY_COORDINATOR_CHANGED');await unlink(file);};
}
