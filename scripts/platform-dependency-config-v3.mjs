import {resolve,dirname,isAbsolute,relative} from 'node:path';
import {canonical} from '../server/imports.ts';
import {platformDependencyConfigV2} from './platform-dependency-config-v2.mjs';
import {applicationManifestV2,inspectApplicationFieldSlotV2} from './runtime-application-config-v2.mjs';
import {readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {predictorRuntimeV1} from './predictor-runtime-v1.mjs';
import {inspectPlatformFieldFilesV1} from './platform-field-inspection-v1.mjs';

const need=(v,c)=>{if(!v)throw Error(c);},exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v),edgeId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v),path=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&isAbsolute(v)&&!/[\u0000-\u001f\u007f]/.test(v);
const outside=(a,b)=>{const p=relative(resolve(b),resolve(a));return p!==''&&(p==='..'||p.startsWith('../')||p.startsWith('..\\')||isAbsolute(p));};

export function platformDependencyConfigV3(value){
 need(exact(value,['format','purpose','workDirectory','postgres','identity','workflows','predictor','applicationManifestFile','field'])&&value.format===3&&value.purpose==='PLATFORM_DEPENDENCIES_V3','PLATFORM_DEPENDENCY_FIELDS');
 const {field,...prior}=value,base=platformDependencyConfigV2({...prior,format:2,purpose:'PLATFORM_DEPENDENCIES_V2'});
 need(![...base.postgres.map(p=>p.id),base.identity.id,...base.workflows.map(w=>w.id),base.predictor.id].includes('applications'),'PLATFORM_DEPENDENCY_RESERVED_ID');
 need(field&&typeof field.enabled==='boolean'&&(field.enabled?exact(field,['enabled','brokers','edges']):exact(field,['enabled'])),'PLATFORM_FIELD_FIELDS');
 if(field.enabled){
  need(Array.isArray(field.brokers)&&field.brokers.length>0&&field.brokers.length<=8&&Array.isArray(field.edges)&&field.edges.length>0&&field.edges.length<=128,'PLATFORM_FIELD_COUNT');
  const ids=new Set([...base.postgres.map(p=>p.id),base.identity.id,...base.workflows.map(w=>w.id),base.predictor.id,'applications']),ports=new Set([...base.postgres.map(p=>p.port),base.identity.port,base.identity.port+10000,...base.workflows.map(w=>w.port),base.predictor.port]),brokers=new Set(),channels=new Set(),paths=[];
  for(const b of field.brokers){need(exact(b,['id','runtimeFile','workDirectory','port'])&&id(b.id)&&!ids.has(b.id),'PLATFORM_FIELD_BROKER_FIELDS');ids.add(b.id);brokers.add(b.id);need(path(b.runtimeFile)&&path(b.workDirectory),'PLATFORM_FIELD_PATH');need(Number.isInteger(b.port)&&b.port>1024&&b.port<=65535&&!ports.has(b.port),'PLATFORM_FIELD_PORT_COLLISION');ports.add(b.port);paths.push(b.runtimeFile,b.workDirectory);}
  for(const e of field.edges){need(exact(e,['id','brokerId','tenantId','edgeId','configurationFile','edgeConfigurationFile','registrationFile','workDirectory'])&&id(e.id)&&!ids.has(e.id)&&brokers.has(e.brokerId)&&id(e.tenantId)&&edgeId(e.edgeId),'PLATFORM_FIELD_EDGE_FIELDS');ids.add(e.id);const channel=e.tenantId+'/'+e.edgeId;need(!channels.has(channel),'PLATFORM_FIELD_EDGE_DUPLICATE');channels.add(channel);need([e.configurationFile,e.edgeConfigurationFile,e.registrationFile,e.workDirectory].every(path),'PLATFORM_FIELD_PATH');paths.push(e.configurationFile,e.edgeConfigurationFile,e.registrationFile,e.workDirectory);}
  need([...brokers].every(id=>field.edges.some(e=>e.brokerId===id)),'PLATFORM_FIELD_UNUSED_BROKER');for(const p of base.postgres)for(const file of paths)need(outside(file,p.dataDirectory)&&outside(p.dataDirectory,file),'PLATFORM_RECORD_OR_PROGRAM_IN_PGDATA');
 }
 return structuredClone(value);
}

async function json(file){try{const item=await readApplicationFileV1(file);return{...item,value:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(item.bytes).replace(/^\uFEFF/,''))};}catch{throw Error('PLATFORM_DEPENDENCY_FILE_READ');}}

/** Preserve prior workflow/predictor checks while actually parsing the V2 application manifest. */
export async function inspectPlatformDependencyFilesV3(input){
 const config=platformDependencyConfigV3(input),pins=new Map(),pg=new Map(config.postgres.map(p=>[p.id,p])),remember=item=>pins.set(item.path,{path:item.path,sha256:item.sha256});let field=null;
 try{
  for(const w of config.workflows){const declared=new Set(w.postgresIds.map(id=>pg.get(id).port)),used=new Set();let tenants;
   for(const file of [w.runtimeFile,w.cancelFile,w.reservationFile].filter(Boolean)){const item=await json(file),v=item.value;need(v&&typeof v.tenants==='object'&&v.tenants&&!Array.isArray(v.tenants),'PLATFORM_WORKFLOW_TENANTS');const names=Object.keys(v.tenants).sort();need(names.length>0&&names.length<=64&&names.every(id),'PLATFORM_WORKFLOW_TENANTS');if(tenants)need(canonical(names)===canonical(tenants),'PLATFORM_WORKFLOW_TENANT_SET');else tenants=names;
    for(const account of Object.values(v.tenants)){const match=typeof account?.jdbcUrl==='string'&&/^jdbc:postgresql:\/\/127\.0\.0\.1:([0-9]{4,5})\/([a-z][a-z0-9_]{1,62})$/.exec(account.jdbcUrl);need(match&&declared.has(Number(match[1])),'PLATFORM_WORKFLOW_DATABASE_ENDPOINT');used.add(Number(match[1]));}remember(item);
   }need(used.size===declared.size,'PLATFORM_WORKFLOW_UNUSED_DATABASE_REFERENCE');
  }
  const service=await json(config.predictor.runtimeFile);let runtime;try{runtime=predictorRuntimeV1(service.value);}catch{throw Error('PLATFORM_PREDICTOR_RUNTIME');}need(runtime.port===config.predictor.port,'PLATFORM_PREDICTOR_RUNTIME_ENDPOINT');remember(service);
  const manifest=await json(config.applicationManifestFile),app=applicationManifestV2(manifest.value);remember(manifest);need(app.field.enabled===config.field.enabled,'PLATFORM_FIELD_ENABLED_MISMATCH');const slot=await inspectApplicationFieldSlotV2(manifest.path,app);pins.set(slot.pin.path,slot.pin);
  for(const member of app.components.filter(c=>c.kind==='PREDICTIVE')){const wrapper=await json(resolve(dirname(manifest.path),member.runtimeFile)),entry=wrapper.value;need(exact(entry,['format','purpose','kind','baseRuntimeFile','authorityRuntimeFile','trustFile'])&&entry.format===1&&entry.purpose==='RUNTIME_COLD_BACKGROUND_V1'&&entry.kind==='PREDICTIVE'&&typeof entry.baseRuntimeFile==='string'&&entry.baseRuntimeFile.length>0,'PLATFORM_PREDICTOR_WORKER_ENTRY');const base=await json(resolve(dirname(wrapper.path),entry.baseRuntimeFile)),client=base.value?.predictor;need(exact(client,['baseUrl','serviceToken'])&&client.baseUrl==='http://127.0.0.1:'+runtime.port&&client.serviceToken===runtime.serviceToken,'PLATFORM_PREDICTOR_CLIENT_BINDING');need(base.value.mode==='WORKER'&&base.value.business?.binding?.tenantId===member.tenantId,'PLATFORM_PREDICTOR_CLIENT_TENANT');remember(wrapper);remember(base);}
  if(config.field.enabled){field=await inspectPlatformFieldFilesV1(config,app,manifest.path);for(const p of field.pins)pins.set(p.path,p);}
  return{config,pins:[...pins.values()],field};
 }catch(e){field?.clear();throw e;}
}
