import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {platformDependencyConfigV1,inspectPlatformDependencyFilesV1} from './platform-dependency-config-v1.mjs';
import {applicationManifestV1,readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {predictorRuntimeV1} from './predictor-runtime-v1.mjs';

const need=(v,c)=>{if(!v)throw Error(c);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const path=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&isAbsolute(v)&&!/[\u0000-\u001f\u007f]/.test(v);
const normal=v=>process.platform==='win32'?resolve(v).toLowerCase():resolve(v);
const outside=(a,b)=>{const p=relative(normal(b),normal(a));return p!==''&&(p==='..'||p.startsWith('../')||p.startsWith('..\\')||isAbsolute(p));};
const core=value=>{const {predictor,...rest}=value;return{...rest,format:1,purpose:'PLATFORM_DEPENDENCIES_V1'};};

/** This configuration always has predictive consumers, so their service is required. */
export function platformDependencyConfigV2(value){
 need(exact(value,['format','purpose','workDirectory','postgres','identity','workflows','predictor','applicationManifestFile'])&&value.format===2&&value.purpose==='PLATFORM_DEPENDENCIES_V2','PLATFORM_DEPENDENCY_FIELDS');
 const base=platformDependencyConfigV1(core(value)),p=value.predictor;
 need(exact(p,['id','runtimeFile','workDirectory','port']),'PLATFORM_PREDICTOR_FIELDS');
 const ids=[...base.postgres.map(p=>p.id),base.identity.id,...base.workflows.map(w=>w.id),'applications'];
 need(typeof p.id==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(p.id)&&!ids.includes(p.id),'PLATFORM_PREDICTOR_ID');
 need(path(p.runtimeFile)&&path(p.workDirectory),'PLATFORM_PREDICTOR_PATH');
 const ports=[...base.postgres.map(p=>p.port),base.identity.port,base.identity.port+10000,...base.workflows.map(w=>w.port)];
 need(Number.isInteger(p.port)&&p.port>1024&&p.port<=65535&&!ports.includes(p.port),'PLATFORM_PREDICTOR_PORT_COLLISION');
 for(const database of base.postgres)for(const file of [p.runtimeFile,p.workDirectory])need(outside(file,database.dataDirectory)&&outside(database.dataDirectory,file),'PLATFORM_RECORD_OR_PROGRAM_IN_PGDATA');
 return structuredClone(value);
}

async function json(file){
 try{const item=await readApplicationFileV1(file);return{...item,value:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(item.bytes).replace(/^\uFEFF/,''))};}
 catch{throw Error('PLATFORM_DEPENDENCY_FILE_READ');}
}

/** Inspect the exact wrapper and base file of every tenant's predictive worker. */
export async function inspectPlatformDependencyFilesV2(input){
 const config=platformDependencyConfigV2(input),prior=await inspectPlatformDependencyFilesV1(core(config)),pins=new Map(prior.pins.map(p=>[p.path,p]));
 const remember=item=>pins.set(item.path,{path:item.path,sha256:item.sha256});
 const service=await json(config.predictor.runtimeFile);let runtime;
 try{runtime=predictorRuntimeV1(service.value);}catch{throw Error('PLATFORM_PREDICTOR_RUNTIME');}
 need(runtime.port===config.predictor.port,'PLATFORM_PREDICTOR_RUNTIME_ENDPOINT');remember(service);
 const manifest=await json(config.applicationManifestFile),app=applicationManifestV1(manifest.value);remember(manifest);
 let count=0;
 for(const member of app.components.filter(c=>c.kind==='PREDICTIVE')){
  const wrapper=await json(resolve(dirname(manifest.path),member.runtimeFile)),entry=wrapper.value;
  need(exact(entry,['format','purpose','kind','baseRuntimeFile','authorityRuntimeFile','trustFile'])&&entry.format===1&&entry.purpose==='RUNTIME_COLD_BACKGROUND_V1'&&entry.kind==='PREDICTIVE','PLATFORM_PREDICTOR_WORKER_ENTRY');
  need(typeof entry.baseRuntimeFile==='string'&&entry.baseRuntimeFile.length>0,'PLATFORM_PREDICTOR_WORKER_ENTRY');
  const base=await json(resolve(dirname(wrapper.path),entry.baseRuntimeFile)),client=base.value?.predictor;
  need(exact(client,['baseUrl','serviceToken'])&&client.baseUrl==='http://127.0.0.1:'+runtime.port&&client.serviceToken===runtime.serviceToken,'PLATFORM_PREDICTOR_CLIENT_BINDING');
  need(base.value.mode==='WORKER'&&base.value.business?.binding?.tenantId===member.tenantId,'PLATFORM_PREDICTOR_CLIENT_TENANT');
  remember(wrapper);remember(base);count++;
 }
 need(count===app.tenantIds.length,'PLATFORM_PREDICTOR_CLIENT_COVERAGE');
 return{config,pins:[...pins.values()]};
}
