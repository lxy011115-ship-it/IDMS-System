import {open,lstat,realpath,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname,isAbsolute} from 'node:path';
import {randomBytes,createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {canonical} from '../server/imports.ts';

const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});},normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const identity=stat=>Object.fromEntries(['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(key=>[key,String(stat[key])]));
const same=(a,b)=>canonical(a)===canonical(b),pathValue=p=>typeof p==='string'&&p.length<=4096&&isAbsolute(p)&&p===resolve(p)&&!/[\u0000-\u001f\u007f]/.test(p);
async function parents(path){const rows=[];for(let p=dirname(path);;p=dirname(p)){const stat=await lstat(p,{bigint:true});need(stat.isDirectory()&&!stat.isSymbolicLink()&&normal(await realpath(p))===normal(p),'COLD_FIELD_INPUT_PARENT');rows.push({path:p,dev:String(stat.dev),ino:String(stat.ino)});if(dirname(p)===p)break;}return rows;}
const entries=values=>values.map(value=>({name:value.name,file:value.isFile(),directory:value.isDirectory(),symbolicLink:value.isSymbolicLink()})).sort((a,b)=>a.name.localeCompare(b.name));

/** Private byte/identity witness only. It performs no domain compilation or authorization. */
export async function captureColdFieldInputWitnessV1({privateFiles,sourceFiles,directories}){
 need(Array.isArray(privateFiles)&&privateFiles.length<=512&&Array.isArray(sourceFiles)&&sourceFiles.length<=256&&Array.isArray(directories)&&directories.length<=1024,'COLD_FIELD_INPUT_CONFIG');
 const key=randomBytes(32),files=[],directoryRows=[],seen=new Set();let closed=false,active=null,closeJob;
 const live=()=>need(!closed,'COLD_FIELD_INPUT_CLOSED');
 const mac=(path,bytes)=>createHmac('sha256',key).update('IDMS_COLD_FIELD_INPUT_BYTES_V1\n'+path+'\n').update(bytes).digest('hex');
 async function file(row){
  live();const chain=await parents(row.path),before=await lstat(row.path,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size>=0n&&before.size<=BigInt(row.maximumBytes)&&(row.empty?before.size===0n:before.size>0n)&&normal(await realpath(row.path))===normal(row.path),'COLD_FIELD_INPUT_FILE');
  const binding=identity(before);if(row.identity)need(same(binding,row.identity)&&same(chain,row.parents),'COLD_FIELD_INPUT_IDENTITY_CHANGED');
  const digest=row.source?createHash('sha256'):createHmac('sha256',key).update('IDMS_COLD_FIELD_INPUT_BYTES_V1\n'+row.path+'\n'),buffer=Buffer.alloc(65536);let handle,total=0;
  try{
   handle=await open(row.path,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0));need(same(identity(await handle.stat({bigint:true})),binding),'COLD_FIELD_INPUT_IDENTITY_CHANGED');
   for(;;){live();const {bytesRead}=await handle.read(buffer,0,buffer.length,total);if(!bytesRead)break;total+=bytesRead;need(total<=row.maximumBytes,'COLD_FIELD_INPUT_SIZE');digest.update(buffer.subarray(0,bytesRead));buffer.fill(0);}
   const after=await lstat(row.path,{bigint:true});need(after.isFile()&&!after.isSymbolicLink()&&same(identity(after),binding)&&same(identity(await handle.stat({bigint:true})),binding)&&same(await parents(row.path),chain)&&normal(await realpath(row.path))===normal(row.path)&&total===Number(before.size),'COLD_FIELD_INPUT_IDENTITY_CHANGED');
   need(timingSafeEqual(Buffer.from(digest.digest('hex'),'hex'),Buffer.from(row.expectedDigest,'hex')),'COLD_FIELD_INPUT_BYTES_CHANGED');live();return{identity:binding,parents:chain,bytes:total};
  }finally{buffer.fill(0);await handle?.close();}
 }
 async function directory(row){live();const before=await lstat(row.path,{bigint:true}),chain=await parents(row.path);need(before.isDirectory()&&!before.isSymbolicLink()&&normal(await realpath(row.path))===normal(row.path),'COLD_FIELD_INPUT_DIRECTORY');const names=entries(await readdir(row.path,{withFileTypes:true}));need(names.length<=32768&&names.every(value=>!value.symbolicLink),'COLD_FIELD_INPUT_DIRECTORY');const after=await lstat(row.path,{bigint:true});need(after.isDirectory()&&!after.isSymbolicLink()&&String(after.dev)===String(before.dev)&&String(after.ino)===String(before.ino)&&same(await parents(row.path),chain)&&normal(await realpath(row.path))===normal(row.path),'COLD_FIELD_INPUT_DIRECTORY_CHANGED');if(row.names)need(same(names,row.names),'COLD_FIELD_INPUT_DIRECTORY_CHANGED');if(row.identity)need(same({dev:String(before.dev),ino:String(before.ino)},row.identity)&&same(chain,row.parents),'COLD_FIELD_INPUT_DIRECTORY_CHANGED');live();return{names,parents:chain,identity:{dev:String(before.dev),ino:String(before.ino)}};}
 async function close(){closed=true;return closeJob??=(async()=>{await active?.catch(()=>{});key.fill(0);})();}
 try{
  for(const value of privateFiles){need(pathValue(value.path)&&Buffer.isBuffer(value.bytes)&&value.bytes.length<=256*1024**2&&!seen.has(normal(value.path)),'COLD_FIELD_INPUT_PRIVATE_FILE');seen.add(normal(value.path));const row={path:value.path,maximumBytes:value.bytes.length,empty:value.bytes.length===0,source:false,expectedDigest:mac(value.path,value.bytes)};Object.assign(row,await file(row));files.push(row);}
  for(const value of sourceFiles){need(pathValue(value.path)&&/^[a-f0-9]{64}$/.test(value.sha256)&&!seen.has(normal(value.path)),'COLD_FIELD_INPUT_SOURCE_FILE');seen.add(normal(value.path));const row={path:value.path,maximumBytes:2*1024**3,empty:false,source:true,expectedDigest:value.sha256};Object.assign(row,await file(row));files.push(row);}
  const directoryNames=new Set();for(const value of [...directories,...files.map(value=>({path:dirname(value.path)}))]){need(pathValue(value.path),'COLD_FIELD_INPUT_DIRECTORY');const normalized=normal(value.path);if(directoryNames.has(normalized)){if(value.entries){const prior=directoryRows.find(row=>normal(row.path)===normalized);need(same(prior.names,entries(value.entries)),'COLD_FIELD_INPUT_DIRECTORY_CHANGED');}continue;}directoryNames.add(normalized);const row={path:value.path,names:value.entries?entries(value.entries):undefined};Object.assign(row,await directory(row));directoryRows.push(row);}
  return Object.freeze({
   revalidate(){live();need(!active,'COLD_FIELD_INPUT_BUSY');const task=(async()=>{try{for(const row of files)await file(row);for(const row of directoryRows)await directory(row);live();return Object.freeze({format:'COLD_FIELD_INPUT_WITNESS_V1',privateFiles:privateFiles.length,sourceFiles:sourceFiles.length,directories:directoryRows.length,allOriginalBytesAndIdentitiesVerified:true,allDirectoryEntriesVerified:true,domainCompilationPerformed:false,authorizationGranted:false,fullGoalComplete:false});}catch(error){closed=true;key.fill(0);throw error;}})();active=task;return task.finally(()=>{if(active===task)active=null;});},
   close,
   toJSON(){need(false,'COLD_FIELD_INPUT_PRIVATE_ONLY');}
  });
 }catch(error){closed=true;key.fill(0);throw error;}
}
