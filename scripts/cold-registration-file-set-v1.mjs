import {open,lstat,realpath} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {canonical} from '../server/imports.ts';

const records=new WeakMap();
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const normalize=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const within=(p,root)=>{const rel=relative(normalize(root),normalize(p));return rel!==''&&rel!=='..'&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(rel);};
const pathValue=p=>typeof p==='string'&&p.length<=4096&&isAbsolute(p)&&p===resolve(p)&&!/[\u0000-\u001f\u007f]/.test(p);
const same=(a,b)=>canonical(a)===canonical(b);
function binding(value){
 need(exact(value,['controlId','sourceHash','sourceInventorySha256','recoveryId','intentSha256'])&&uuid(value.controlId)&&uuid(value.recoveryId)&&[value.sourceHash,value.sourceInventorySha256,value.intentSha256].every(hex),'COLD_REGISTRATION_FILES_BINDING');return structuredClone(value);
}
function config(raw){
 need(exact(raw,['binding','roots','forbiddenRoots','files']),'COLD_REGISTRATION_FILES_CONFIG');
 const c=structuredClone(raw);c.binding=binding(c.binding);
 for(const key of['roots','forbiddenRoots'])need(Array.isArray(c[key])&&c[key].length>0&&c[key].length<=16&&c[key].every(pathValue)&&new Set(c[key].map(normalize)).size===c[key].length,'COLD_REGISTRATION_FILES_ROOTS');
 need(c.roots.every(a=>c.forbiddenRoots.every(b=>normalize(a)!==normalize(b)&&!within(a,b))),'COLD_REGISTRATION_FILES_ROOT_OVERLAP');
 need(Array.isArray(c.files)&&c.files.length>0&&c.files.length<=256,'COLD_REGISTRATION_FILES_COUNT');
 const ids=new Set(),paths=new Set();let maximum=0;
 for(const f of c.files){
  need(exact(f,['id','purpose','path','maximumBytes'])&&typeof f.id==='string'&&/^[a-z][a-z0-9_.-]{0,127}$/.test(f.id)&&!ids.has(f.id)&&['PRIVATE_JSON','PRIVATE_BINARY','PUBLIC_PROGRAM'].includes(f.purpose)&&pathValue(f.path),'COLD_REGISTRATION_FILES_DESCRIPTOR');ids.add(f.id);
  need(!paths.has(normalize(f.path))&&c.roots.some(p=>within(f.path,p))&&c.forbiddenRoots.every(p=>normalize(f.path)!==normalize(p)&&!within(f.path,p)),'COLD_REGISTRATION_FILES_PATH');paths.add(normalize(f.path));
  need(Number.isSafeInteger(f.maximumBytes)&&f.maximumBytes>0&&f.maximumBytes<=256*1024**2,'COLD_REGISTRATION_FILES_SIZE');maximum+=f.maximumBytes;
 }need(maximum<=512*1024**2,'COLD_REGISTRATION_FILES_TOTAL_LIMIT');
 c.files.sort((a,b)=>a.id.localeCompare(b.id));return c;
}
const identity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),nlink:String(s.nlink)});
async function chain(path){
 const parents=[];
 for(let p=dirname(path);;p=dirname(p)){
  const s=await lstat(p,{bigint:true});need(s.isDirectory()&&!s.isSymbolicLink()&&normalize(await realpath(p))===normalize(p),'COLD_REGISTRATION_FILES_PARENT');
  parents.push({path:p,dev:String(s.dev),ino:String(s.ino)});if(dirname(p)===p)break;
 }return parents;
}
function current(r){need(!r.closed&&!r.controller.signal.aborted,'COLD_REGISTRATION_FILES_CLOSED');need(Date.now()>=r.wall&&Date.now()<r.wall+30000&&performance.now()-r.monotonic<30000,'COLD_REGISTRATION_FILES_EXPIRED');}
async function file(r,f){
 current(r);const parents=await chain(f.path),before=await lstat(f.path,{bigint:true});
 need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size>0n&&before.size<=BigInt(f.maximumBytes)&&normalize(await realpath(f.path))===normalize(f.path),'COLD_REGISTRATION_FILES_REGULAR');
 const snapshot=identity(before),h=createHmac('sha256',r.key).update('IDMS_COLD_REGISTRATION_FILE_V1\n'+canonical({binding:r.config.binding,id:f.id,purpose:f.purpose,path:f.path,identity:snapshot})+'\n'),buffer=Buffer.alloc(65536);let handle,total=0;
 try{
  handle=await open(f.path,'r');const opened=await handle.stat({bigint:true});need(opened.isFile()&&same(identity(opened),snapshot),'COLD_REGISTRATION_FILES_CHANGED');
  for(;;){current(r);const{bytesRead}=await handle.read(buffer,0,buffer.length,total);if(bytesRead===0)break;total+=bytesRead;need(total<=f.maximumBytes&&total<=Number(before.size),'COLD_REGISTRATION_FILES_CHANGED');h.update(buffer.subarray(0,bytesRead));buffer.fill(0);}
  const final=await handle.stat({bigint:true}),after=await lstat(f.path,{bigint:true});
  need(final.isFile()&&after.isFile()&&!after.isSymbolicLink()&&same(identity(final),snapshot)&&same(identity(after),snapshot)&&total===Number(before.size)&&normalize(await realpath(f.path))===normalize(f.path)&&same(await chain(f.path),parents),'COLD_REGISTRATION_FILES_CHANGED');
  current(r);return{id:f.id,purpose:f.purpose,bytes:total,mac:h.digest('hex')};
 }finally{buffer.fill(0);await handle?.close();}
}
async function observe(r){
 const files=[];for(const f of r.config.files)files.push(await file(r,f));current(r);
 const mac=createHmac('sha256',r.key).update('IDMS_COLD_REGISTRATION_FILE_SET_V1\n'+canonical({binding:r.config.binding,files})).digest('hex');
 return{format:'COLD_REGISTRATION_FILE_SET_EVIDENCE_V1',binding:structuredClone(r.config.binding),materialMac:mac,files:files.map(({mac,...publicFile})=>publicFile),fileCount:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0),capturedAt:new Date(r.wall).toISOString(),expiresAt:new Date(r.wall+30000).toISOString(),actualFileBytesVerified:true,privatePathsPublished:false,unkeyedPrivateDigestsPublished:false,completeDeploymentMaterialsVerified:false,currentIdentityVerified:false,independentApprovalGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false,fullGoalComplete:false};
}
/** Trusted coordinator primitive; its file list still needs the domain material coverage validator. */
export function createColdRegistrationFileSetV1(input){
 const r={config:config(input),key:randomBytes(32),wall:Date.now(),monotonic:performance.now(),controller:new AbortController(),closed:false,job:null,evidence:null,closeJob:null};
 const run=(operation)=>{need(!r.job,'COLD_REGISTRATION_FILES_BUSY');current(r);const job=Promise.resolve().then(operation);r.job=job;return job.finally(()=>{if(r.job===job)r.job=null;});};
 const api=Object.freeze({
  capture(){need(!r.evidence,'COLD_REGISTRATION_FILES_ALREADY_CAPTURED');return run(async()=>{try{r.evidence=await observe(r);return structuredClone(r.evidence);}catch(e){r.closed=true;r.controller.abort();r.key.fill(0);throw e;}});},
  revalidate(){need(r.evidence,'COLD_REGISTRATION_FILES_CAPTURE_REQUIRED');return run(async()=>{try{const actual=await observe(r);need(timingSafeEqual(Buffer.from(actual.materialMac,'hex'),Buffer.from(r.evidence.materialMac,'hex'))&&same(actual.files,r.evidence.files),'COLD_REGISTRATION_FILES_DRIFT');return structuredClone(r.evidence);}catch(e){r.closed=true;r.controller.abort();r.key.fill(0);throw e;}});},
  close(){if(r.closeJob)return r.closeJob;r.closed=true;r.controller.abort();return r.closeJob=Promise.resolve().then(async()=>{try{await r.job?.catch(()=>{});}finally{r.key.fill(0);}});}
 });records.set(api,r);return api;
}
/** Serialized evidence or caller-supplied flags cannot recreate the original in-memory owner. */
export function assertColdRegistrationFileSetV1(value,expectedBinding){
 const r=records.get(value);need(r&&same(r.config.binding,binding(expectedBinding)),'COLD_REGISTRATION_FILES_OWNER');current(r);need(!r.job&&r.evidence,'COLD_REGISTRATION_FILES_CAPTURE_REQUIRED');return structuredClone(r.evidence);
}
