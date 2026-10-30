import {resolve,relative,isAbsolute} from 'node:path';
import {canonical} from '../server/imports.ts';
import {backupRegular,backupUnchanged,readExactly} from './field-backup-io.mjs';
import {createHash} from 'node:crypto';
import {applicationManifestV1} from './runtime-application-config-v1.mjs';

const need=(v,c)=>{if(!v)throw Error(c);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v);
const path=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&isAbsolute(v)&&!/[\u0000-\u001f\u007f]/.test(v);
const key=v=>process.platform==='win32'?resolve(v).toLowerCase():resolve(v);
const outside=(a,b)=>{const r=relative(key(b),key(a));return r!==''&&(r==='..'||r.startsWith('../')||r.startsWith('..\\')||isAbsolute(r));};
const port=v=>Number.isInteger(v)&&v>1024&&v<=65535;
const secret=v=>typeof v==='string'&&v.length>=32&&v.length<=4096&&!/[\r\n\0]/.test(v);
const sqlId=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{1,62}$/.test(v);
const sha=b=>createHash('sha256').update(b).digest('hex');

/** Pure preflight: no processes, SQL, filesystem writes or ownership adoption. */
export function platformDependencyConfigV1(value){
 need(exact(value,['format','purpose','workDirectory','postgres','identity','workflows','applicationManifestFile'])&&value.format===1&&value.purpose==='PLATFORM_DEPENDENCIES_V1','PLATFORM_DEPENDENCY_FIELDS');
 need(path(value.workDirectory)&&path(value.applicationManifestFile),'PLATFORM_DEPENDENCY_PATH');
 need(Array.isArray(value.postgres)&&value.postgres.length>0&&value.postgres.length<=8&&Array.isArray(value.workflows)&&value.workflows.length>0&&value.workflows.length<=8,'PLATFORM_DEPENDENCY_COUNT');
 const ids=new Set(),ports=new Set(),databases=new Map(),paths=[value.workDirectory,value.applicationManifestFile];
 const addId=v=>{need(id(v)&&!ids.has(v),'PLATFORM_DEPENDENCY_ID');ids.add(v);};
 const addPort=v=>{need(port(v)&&!ports.has(v),'PLATFORM_DEPENDENCY_PORT_COLLISION');ports.add(v);};
 for(const p of value.postgres){
  need(exact(p,['id','binDirectory','dataDirectory','workDirectory','expectedSystemIdentifier','port','account']),'PLATFORM_POSTGRES_FIELDS');addId(p.id);addPort(p.port);
  need([p.binDirectory,p.dataDirectory,p.workDirectory].every(path)&&typeof p.expectedSystemIdentifier==='string'&&/^\d{16,20}$/.test(p.expectedSystemIdentifier),'PLATFORM_POSTGRES_INPUT');
  need(exact(p.account,['user','password','database'])&&sqlId(p.account.user)&&secret(p.account.password)&&p.account.database==='postgres','PLATFORM_POSTGRES_ACCOUNT');
  for(const previous of databases.values())need(outside(p.dataDirectory,previous.dataDirectory)&&outside(previous.dataDirectory,p.dataDirectory),'PLATFORM_POSTGRES_DIRECTORY_OVERLAP');
  databases.set(p.id,p);paths.push(p.binDirectory,p.workDirectory);
 }
 const i=value.identity;need(exact(i,['id','postgresId','javaHome','keycloakDirectory','workDirectory','port','database','admin']),'PLATFORM_IDENTITY_FIELDS');addId(i.id);addPort(i.port);addPort(i.port+10000);
 need(i.port>=30000&&i.port<40000&&[i.javaHome,i.keycloakDirectory,i.workDirectory].every(path),'PLATFORM_IDENTITY_INPUT');
 need(exact(i.database,['host','port','database','user','password'])&&i.database.host==='127.0.0.1'&&sqlId(i.database.database)&&sqlId(i.database.user)&&secret(i.database.password)&&/^[\w-]{32,4096}$/.test(i.database.password)&&exact(i.admin,['username','password'])&&typeof i.admin.username==='string'&&/^[a-z][a-z0-9_-]{1,63}$/.test(i.admin.username)&&secret(i.admin.password)&&/^[\w-]{32,4096}$/.test(i.admin.password),'PLATFORM_IDENTITY_ACCOUNT');
 need(databases.has(i.postgresId)&&databases.get(i.postgresId).port===i.database.port,'PLATFORM_IDENTITY_DATABASE_ENDPOINT');paths.push(i.javaHome,i.keycloakDirectory,i.workDirectory);
 for(const w of value.workflows){
  need(exact(w,['id','postgresIds','javaHome','workDirectory','jarFile','jarSha256','runtimeFile','cancelFile','reservationFile','port']),'PLATFORM_WORKFLOW_FIELDS');addId(w.id);addPort(w.port);
  need(Array.isArray(w.postgresIds)&&w.postgresIds.length>0&&w.postgresIds.length<=8&&new Set(w.postgresIds).size===w.postgresIds.length&&w.postgresIds.every(v=>databases.has(v)),'PLATFORM_WORKFLOW_DATABASE_REFERENCE');
  need([w.javaHome,w.workDirectory,w.jarFile,w.runtimeFile].every(path)&&typeof w.jarSha256==='string'&&/^[a-f0-9]{64}$/.test(w.jarSha256)&&(w.cancelFile===null||path(w.cancelFile))&&(w.reservationFile===null||path(w.reservationFile))&&(!w.reservationFile||w.cancelFile),'PLATFORM_WORKFLOW_INPUT');
  paths.push(w.javaHome,w.workDirectory,w.jarFile,w.runtimeFile,...[w.cancelFile,w.reservationFile].filter(Boolean));
 }
 for(const p of databases.values())for(const candidate of paths)need(outside(candidate,p.dataDirectory)&&outside(p.dataDirectory,candidate),'PLATFORM_RECORD_OR_PROGRAM_IN_PGDATA');
 return structuredClone(value);
}

async function readJson(file){
 let f;try{f=await backupRegular(file,2*1024**2);const bytes=await readExactly(f.file,Number(f.stat.size),0);await backupUnchanged(f);return{value:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'')),pin:{path:resolve(file),sha256:sha(bytes)}};}catch{throw Error('PLATFORM_DEPENDENCY_FILE_READ');}finally{await f?.file.close();}
}

/** Check every workflow credential file against declared owned PG endpoints. */
export async function inspectPlatformDependencyFilesV1(input){
 const config=platformDependencyConfigV1(input),pins=[],pg=new Map(config.postgres.map(p=>[p.id,p]));
 for(const w of config.workflows){
  const declared=new Set(w.postgresIds.map(id=>pg.get(id).port)),used=new Set();let tenants;
  for(const file of [w.runtimeFile,w.cancelFile,w.reservationFile].filter(Boolean)){
   const item=await readJson(file),v=item.value;need(v&&typeof v.tenants==='object'&&v.tenants&&!Array.isArray(v.tenants),'PLATFORM_WORKFLOW_TENANTS');
   const names=Object.keys(v.tenants).sort();need(names.length>0&&names.length<=64&&names.every(id),'PLATFORM_WORKFLOW_TENANTS');
   if(tenants)need(canonical(names)===canonical(tenants),'PLATFORM_WORKFLOW_TENANT_SET');else tenants=names;
   for(const account of Object.values(v.tenants)){
    const match=typeof account?.jdbcUrl==='string'&&/^jdbc:postgresql:\/\/127\.0\.0\.1:([0-9]{4,5})\/([a-z][a-z0-9_]{1,62})$/.exec(account.jdbcUrl);
    need(match&&declared.has(Number(match[1])),'PLATFORM_WORKFLOW_DATABASE_ENDPOINT');used.add(Number(match[1]));
   }
   pins.push(item.pin);
  }
  need(used.size===declared.size,'PLATFORM_WORKFLOW_UNUSED_DATABASE_REFERENCE');
 }
 const app=await readJson(config.applicationManifestFile);applicationManifestV1(app.value);pins.push(app.pin);
 return{config,pins};
}
