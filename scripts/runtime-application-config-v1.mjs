import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';

export const applicationHashV1=value=>createHash('sha256').update(value).digest('hex');
export const applicationNeedV1=(value,code)=>{if(!value)throw Error(code);};
const need=applicationNeedV1,exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const pathValue=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const normalize=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
export function applicationOutsideV1(directory,parent){const p=relative(resolve(parent),resolve(directory));return p!==''&&(p==='..'||p.startsWith('../')||p.startsWith('..\\')||isAbsolute(p));}
export function applicationManifestV1(raw){
 need(exact(raw,['format','purpose','registryDirectory','trustFile','authorityRuntimeFile','binding','tenantIds','components'])&&raw.format===1&&raw.purpose==='RUNTIME_APPLICATION_SUITE_V1','APPLICATION_MANIFEST_FIELDS');
 need([raw.registryDirectory,raw.trustFile,raw.authorityRuntimeFile].every(pathValue),'APPLICATION_MANIFEST_PATH');
 need(exact(raw.binding,['controlId','sourceHash','authorityHash'])&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(raw.binding.controlId)&&digest(raw.binding.sourceHash)&&digest(raw.binding.authorityHash),'APPLICATION_MANIFEST_BINDING');
 need(Array.isArray(raw.tenantIds)&&raw.tenantIds.length>0&&raw.tenantIds.length<=32&&raw.tenantIds.every(id)&&new Set(raw.tenantIds).size===raw.tenantIds.length,'APPLICATION_MANIFEST_TENANTS');
 need(Array.isArray(raw.components)&&raw.components.length===1+4*raw.tenantIds.length,'APPLICATION_MANIFEST_COVERAGE');
 const seen=new Set(),slots=new Set();
 for(const c of raw.components){
  need(exact(c,['id','kind','tenantId','runtimeFile'])&&id(c.id)&&!seen.has(c.id)&&pathValue(c.runtimeFile),'APPLICATION_COMPONENT_FIELDS');seen.add(c.id);
  need(['SITE','GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION'].includes(c.kind)&&(c.kind==='SITE'?c.tenantId===null:raw.tenantIds.includes(c.tenantId)),'APPLICATION_COMPONENT_KIND_OR_TENANT');
  const slot=c.kind+':'+c.tenantId;need(!slots.has(slot),'APPLICATION_COMPONENT_DUPLICATE');slots.add(slot);
 }
 need(slots.has('SITE:null')&&raw.tenantIds.every(t=>['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION'].every(k=>slots.has(k+':'+t))),'APPLICATION_MANIFEST_COVERAGE');
 return structuredClone(raw);
}
export function applicationBindingV1(state){return{controlId:state.source.controlId,sourceHash:applicationHashV1(canonical(state.source)),authorityHash:state.details.admission.authorityHash};}
export async function readApplicationFileV1(file){
 const path=resolve(file),before=await lstat(path);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=2*1024**2&&normalize(await realpath(path))===normalize(path),'APPLICATION_PRIVATE_FILE');
 const bytes=await readFile(path),after=await lstat(path);need(after.isFile()&&!after.isSymbolicLink()&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'APPLICATION_FILE_CHANGED');return{path,bytes,sha256:applicationHashV1(bytes)};
}
/** JSON references only: live SQLite stores and service artifacts retain their existing validators. */
export async function collectApplicationJsonGraphV1(files){
 const pins=new Map();let total=0;
 async function visit(file){
  const path=resolve(file),key=normalize(path);if(pins.has(key))return;
  need(pins.size<256,'APPLICATION_CONFIG_FILE_LIMIT');const item=await readApplicationFileV1(path);total+=item.bytes.length;need(total<=8*1024**2,'APPLICATION_CONFIG_BYTE_LIMIT');pins.set(key,{path,sha256:item.sha256});
  const value=JSON.parse(item.bytes.toString('utf8').replace(/^\uFEFF/,''));
  async function refs(v){
   if(Array.isArray(v)){for(const x of v)await refs(x);return;}
   if(!v||typeof v!=='object')return;
   for(const[k,x]of Object.entries(v)){
    if(/File$/.test(k)&&typeof x==='string'&&/\.json$/i.test(x)){need(pathValue(x),'APPLICATION_CONFIG_REFERENCE');await visit(resolve(dirname(path),x));}
    else if(/Files$/.test(k)&&Array.isArray(x)){for(const ref of x){need(pathValue(ref)&&/\.json$/i.test(ref),'APPLICATION_CONFIG_REFERENCES');await visit(resolve(dirname(path),ref));}}
    else await refs(x);
   }
  }
  await refs(value);
 }
 for(const file of files)await visit(file);
 return [...pins.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
export async function assertApplicationPinsV1(pins){need(Array.isArray(pins)&&pins.length>0&&pins.length<=256,'APPLICATION_PINS');for(const p of pins)need((await readApplicationFileV1(p.path)).sha256===p.sha256,'APPLICATION_CONFIG_CHANGED');}
