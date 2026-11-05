import {readFile,lstat,realpath,open,rename} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalDigest,canonicalEqual} from '../server/canonical-state.ts';
import {openExistingSqlite} from '../services/existing-sqlite.ts';
import {readSpoolReceipt,spoolVersion} from '../services/edge/spool-v2.ts';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),need=(v,code)=>{if(!v)throw Error(code);},exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export function baseRuntimeBinding(binding){const {recovery,...base}=binding;return {...base,format:1};}
export const runtimeBindingDigest=binding=>hash(JSON.stringify(baseRuntimeBinding(binding)));
function shape(binding){
 const r=binding.recovery;need(binding.format===2&&exact(binding,['format','purpose','project','runtime','identity','files','recovery'])&&exact(r,['contract','operationId','beforeBinding','completion','source','spool'])&&r.contract==='IDMS_EDGE_RECOVERY_BOUND_V2'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.operationId),'RECOVERY_BINDING_SHAPE_INVALID');
 const directory=resolve(binding.project,'.local/edge-recovery',r.operationId);
 for(const [pin,name]of [[r.beforeBinding,'binding-before.json'],[r.completion,'completion.private.json']])need(exact(pin,['path','bytes','sha256'])&&pin.path===join(directory,name)&&Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=262144&&/^[a-f0-9]{64}$/.test(pin.sha256),'RECOVERY_BINDING_PIN_INVALID');
 need(exact(r.source,['digest','files'])&&/^[a-f0-9]{64}$/.test(r.source.digest)&&Number.isSafeInteger(r.source.files)&&r.source.files>0&&r.source.files<=4096,'RECOVERY_SOURCE_BINDING_INVALID');
 need(exact(r.spool,['path','device','inode','receiptDigest'])&&resolve(r.spool.path)===r.spool.path&&[r.spool.device,r.spool.inode].every(v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(v))&&/^[a-f0-9]{64}$/.test(r.spool.receiptDigest),'RECOVERY_SPOOL_BINDING_INVALID');return r;
}
export async function validateRecoveryBinding(binding,{verifyPin,sourceEvidence,requireCurrentSource=true}={}){
 const r=shape(binding);await verifyPin(r.beforeBinding);await verifyPin(r.completion);
 const before=JSON.parse(await readFile(r.beforeBinding.path,'utf8')),completion=JSON.parse(await readFile(r.completion.path,'utf8'));
 need(before.format===1&&canonicalEqual(before,baseRuntimeBinding(binding)),'RECOVERY_INPUT_BINDINGS_CHANGED');
 need(completion.format==='IDMS_EDGE_RECOVERY_COMPLETE_V2'&&completion.operationId===r.operationId&&completion.originalBindingSha256===r.beforeBinding.sha256&&canonicalEqual(completion.source,r.source)&&canonicalEqual(completion.spoolIdentity,{path:r.spool.path,device:r.spool.device,inode:r.spool.inode})&&canonicalDigest(completion.receipt)===r.spool.receiptDigest&&completion.structureAndPrivilegesUnchanged===true,'RECOVERY_COMPLETION_BINDING_INVALID');
 const directory=resolve(binding.project,'.local/edge-recovery',r.operationId);
 const names=['backup','restore-check'].flatMap(kind=>[1,2,3].map(attempt=>'edge-'+r.operationId+(attempt===1?'':'.attempt-'+attempt)+'.'+kind+'.sqlite'));
 need(Array.isArray(completion.backups)&&completion.backups.length===2&&completion.backups.every(p=>exact(p,['path','bytes','sha256'])&&typeof p.path==='string'&&dirname(p.path)===directory&&names.includes(basename(p.path)))&&completion.backups.some(p=>p.path.endsWith('.backup.sqlite')&&p.sha256===completion.receipt.backupDigest)&&completion.backups.some(p=>p.path.endsWith('.restore-check.sqlite')),'RECOVERY_BACKUP_BINDING_INVALID');
 // Paths use the host separator; compare through a resolved parent instead of
 // accepting an arbitrary file supplied in a completion receipt.
 for(const pin of completion.backups){need(Number.isSafeInteger(pin.bytes)&&pin.bytes>0&&pin.bytes<=256*1024**2&&/^[a-f0-9]{64}$/.test(pin.sha256),'RECOVERY_BACKUP_BINDING_INVALID');await verifyPin(pin);}
 const telemetry=JSON.parse(await readFile(binding.files.telemetry.path,'utf8'));need(telemetry.sources?.length===1&&resolve(telemetry.edge.spool)===r.spool.path,'RECOVERY_SPOOL_BINDING_INVALID');
 const s=await lstat(r.spool.path,{bigint:true});need(s.isFile()&&s.nlink===1n&&!s.isSymbolicLink()&&await realpath(r.spool.path)===r.spool.path&&s.dev.toString()===r.spool.device&&s.ino.toString()===r.spool.inode,'RECOVERY_SPOOL_FILE_CHANGED');
 const db=openExistingSqlite(r.spool.path,'edge',telemetry.sources[0],{readOnly:true});try{need(spoolVersion(db)===2&&canonicalDigest(readSpoolReceipt(db,telemetry.sources[0]))===r.spool.receiptDigest,'RECOVERY_SPOOL_RECEIPT_CHANGED');}finally{db.close();}
 if(requireCurrentSource){const current=await sourceEvidence();need(current.digest===r.source.digest&&current.files===r.source.files,'RECOVERY_RUNTIME_SOURCE_CHANGED');}
 return completion;
}
export function recoveredRuntimeBinding(before,{operationId,beforeBinding,completion,source,spool,receipt}){
 need(before.format===1,'RECOVERY_INITIAL_BINDING_REQUIRED');const binding={...before,format:2,recovery:{contract:'IDMS_EDGE_RECOVERY_BOUND_V2',operationId,beforeBinding,completion,source:{digest:source.digest,files:source.files},spool:{...spool,receiptDigest:canonicalDigest(receipt)}}};shape(binding);return binding;
}
/** Same-operation resume accepts its exact already-written descriptor or exact
 * reserved temporary bytes. Any other descriptor is left untouched. */
export async function replaceRecoveryBinding(file,beforeHash,value,operationId){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),targetHash=hash(bytes),current=await readFile(file);
 if(hash(current)===targetHash)return {replayed:true,sha256:targetHash};need(hash(current)===beforeHash,'RECOVERY_BINDING_CHANGED');
 const temporary=file+'.recovery-'+operationId+'.tmp';let fd;
 try{fd=await open(temporary,'wx',0o600);await fd.writeFile(bytes);await fd.sync();}catch(e){if(e.code!=='EEXIST')throw e;const s=await lstat(temporary);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&hash(await readFile(temporary))===targetHash,'RECOVERY_BINDING_TEMPORARY_CHANGED');}finally{await fd?.close();}
 need(hash(await readFile(file))===beforeHash,'RECOVERY_BINDING_CHANGED');await rename(temporary,file);need(hash(await readFile(file))===targetHash,'RECOVERY_BINDING_WRITE_UNCONFIRMED');return {replayed:false,sha256:targetHash};
}
