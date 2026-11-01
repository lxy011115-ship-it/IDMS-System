import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,statfsSync,openSync,writeFileSync,readFileSync,fsyncSync,closeSync,createReadStream} from 'node:fs';
import {join} from 'node:path';
import {stable} from '../../integrations/telemetry.ts';
import {spoolRecoveryLimits} from './spool-v2.ts';
export interface SpoolCheckpoint {stage:string;path:string;attempt?:number;digest?:string}
export type SpoolCheckpointObserver=(checkpoint:SpoolCheckpoint)=>unknown;
export function spoolCheckpoint(observer:SpoolCheckpointObserver|undefined,event:SpoolCheckpoint){if(observer&&observer(event)!==undefined)throw Error('SPOOL_CHECKPOINT_MUST_BE_SYNCHRONOUS');}
function json(path:string){try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>65536||realpathSync(path)!==path)throw Error('SPOOL_ARTIFACT_PROOF_INVALID');return JSON.parse(readFileSync(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
function exclusiveJson(path:string,value:unknown){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
export function ensureSpoolIntent(directory:string,operationId:string,proposal:unknown){
 const path=join(directory,'edge-'+operationId+'.intent.private.json'),value={format:'IDMS_EDGE_RECOVERY_INTENT_V2',proposal},prior=json(path);
 if(prior===undefined)exclusiveJson(path,value);else if(stable(prior)!==stable(value))throw Error('SPOOL_RECOVERY_INTENT_CHANGED');
}
function identity(path:string){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||realpathSync(path)!==path||s.size>spoolRecoveryLimits.databaseBytes)throw Error('SPOOL_ARTIFACT_FILE_INVALID');return {path,device:s.dev,inode:s.ino};}
async function digest(path:string){
 const pin=identity(path),before=lstatSync(path),h=createHash('sha256');for await(const chunk of createReadStream(path,{highWaterMark:65536}))h.update(chunk);
 const after=lstatSync(path);if(stable(identity(path))!==stable(pin)||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('SPOOL_ARTIFACT_FILE_CHANGED');return {digest:h.digest('hex'),bytes:after.size};
}
/** A partial, owned artifact is preserved; at most three bounded generations
 * may be allocated. A changed completed artifact NEVER falls back to another. */
export async function verifiedSpoolCopy(source:DatabaseSync,kind:'backup'|'restore-check',options:{directory:string;operationId:string;check:(db:DatabaseSync)=>void;onCheckpoint?:SpoolCheckpointObserver}){
 for(let attempt=1;attempt<=3;attempt++){
  const path=join(options.directory,'edge-'+options.operationId+(attempt===1?'':'.attempt-'+attempt)+'.'+kind+'.sqlite'),pinPath=path+'.owner.private.json',completePath=path+'.complete.private.json';
  let pin=json(pinPath);const complete=json(completePath);
  if(pin===undefined){
   if(complete!==undefined)throw Error('SPOOL_ARTIFACT_OWNERSHIP_UNCONFIRMED');
   const space=statfsSync(options.directory);if(space.bavail*space.bsize<spoolRecoveryLimits.freeBytes)throw Error('SPOOL_RECOVERY_FREE_SPACE_REQUIRED');
   const fd=openSync(path,'wx',0o600);try{fsyncSync(fd);}finally{closeSync(fd);}
   pin={format:'IDMS_EDGE_RECOVERY_ARTIFACT_V2',operationId:options.operationId,kind,attempt,...identity(path)};exclusiveJson(pinPath,pin);
   spoolCheckpoint(options.onCheckpoint,{stage:kind==='backup'?'BACKUP_RESERVED':'RESTORE_RESERVED',path,attempt});
   await backup(source,path,{rate:64});
  }
  if(pin.format!=='IDMS_EDGE_RECOVERY_ARTIFACT_V2'||pin.operationId!==options.operationId||pin.kind!==kind||pin.attempt!==attempt||stable({path:pin.path,device:pin.device,inode:pin.inode})!==stable(identity(path)))throw Error('SPOOL_ARTIFACT_OWNERSHIP_CHANGED');
  let valid=false;try{const db=new DatabaseSync(path,{readOnly:true});try{options.check(db);valid=true;}finally{db.close();}}catch(error){if(complete!==undefined)throw Error('SPOOL_COMPLETED_ARTIFACT_INVALID');}
  if(!valid){
   // Do not remove/overwrite a partial result or conceal its existence.
   const observation=path+'.incomplete.private.json';if(json(observation)===undefined)exclusiveJson(observation,{format:'IDMS_EDGE_RECOVERY_INCOMPLETE_V2',operationId:options.operationId,kind,attempt,path});continue;
  }
  const measured=await digest(path),proof={...pin,...measured,verified:true};
  if(complete===undefined)exclusiveJson(completePath,proof);else if(stable(complete)!==stable(proof))throw Error('SPOOL_COMPLETED_ARTIFACT_CHANGED');
  spoolCheckpoint(options.onCheckpoint,{stage:kind==='backup'?'BACKUP_VERIFIED':'RESTORE_VERIFIED',path,attempt,digest:measured.digest});
  return {path,...measured};
 }
 throw Error('SPOOL_PARTIAL_ARTIFACT_REVIEW_REQUIRED');
}
