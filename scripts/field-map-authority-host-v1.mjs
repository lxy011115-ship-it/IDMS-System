import pg from 'pg';
import {resolve,dirname,isAbsolute,relative} from 'node:path';
import {realpath} from 'node:fs/promises';
import {canonical} from '../server/imports.ts';
import {IdentityAuthorityGuardV1,authorityRuntimeV1} from '../server/identity-authority-live-v1.ts';
import {RuntimeColdGuardV1} from './runtime-cold-portable-entry-v1.mjs';
import {readApplicationFileV1,applicationHashV1 as hash} from './runtime-application-config-v1.mjs';
import {inspectStateMapCatalog} from '../server/state-map-catalog-v1.ts';
import {checkFieldMapSignalV1} from '../server/field-map-transaction-v1.ts';

const need=(v,code)=>{if(!v)throw Error(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const oid=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v)&&BigInt(v)<=4294967295n;
const normalize=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const same=(a,b)=>normalize(a)===normalize(b);
const outside=(file,dir)=>{const p=relative(normalize(dir),normalize(file));return p!==''&&(p==='..'||p.startsWith('../')||p.startsWith('..\\')||isAbsolute(p));};
const account=v=>exact(v,['host','port','database','user','password'])&&['127.0.0.1','::1'].includes(v.host)&&Number.isInteger(v.port)&&v.port>1024&&v.port<=65535&&[v.database,v.user].every(x=>typeof x==='string'&&/^[a-z][a-z0-9_]{1,62}$/.test(x))&&typeof v.password==='string'&&v.password.length>=24&&v.password.length<=4096&&!/[\r\n\0]/.test(v.password);

export function fieldMapAuthorityHostConfigV1(raw){
 need(exact(raw,['format','purpose','authorityRuntimeFile','coldTrustFile','controlAccount','tenants'])&&raw.format===1&&raw.purpose==='FIELD_MAP_AUTHORITY_HOST_V1','FIELD_HOST_FIELDS');
 need(text(raw.authorityRuntimeFile)&&text(raw.coldTrustFile)&&raw.authorityRuntimeFile!==raw.coldTrustFile,'FIELD_HOST_REFERENCES');
 need(account(raw.controlAccount)&&raw.controlAccount.database==='postgres','FIELD_HOST_CONTROL_ACCOUNT');
 need(Array.isArray(raw.tenants)&&raw.tenants.length>0&&raw.tenants.length<=32,'FIELD_HOST_TENANTS');const seen=new Set(),roles=new Set();
 for(const t of raw.tenants){
  need(exact(t,['tenantId','account','binding'])&&typeof t.tenantId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(t.tenantId)&&!seen.has(t.tenantId),'FIELD_HOST_TENANT');seen.add(t.tenantId);
  need(account(t.account)&&t.account.host===raw.controlAccount.host&&t.account.port===raw.controlAccount.port&&t.account.user!==raw.controlAccount.user,'FIELD_HOST_ACCOUNT');
  need(exact(t.binding,['tenantId','databaseOid','roleOid','catalogHash'])&&t.binding.tenantId===t.tenantId&&oid(t.binding.databaseOid)&&oid(t.binding.roleOid)&&/^[a-f0-9]{64}$/.test(t.binding.catalogHash),'FIELD_HOST_BINDING');
  const key=t.binding.databaseOid+':'+t.binding.roleOid;need(!roles.has(key),'FIELD_HOST_DUPLICATE_ACCOUNT');roles.add(key);
 }
 return structuredClone(raw);
}

export async function loadFieldMapAuthorityHostV1(file){
 const pins=new Map();let config,cold,initialFingerprint,initialState,credentialFile,closing=false,closed=false,closeJob;const stop=new AbortController(),active=new Set(),clients=new Set();let created=0,retired=0;
 async function json(file){const item=await readApplicationFileV1(file);if(pins.has(item.path))need(pins.get(item.path)===item.sha256,'FIELD_HOST_FILE_CHANGED');else pins.set(item.path,item.sha256);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(item.bytes).replace(/^\uFEFF/,''));}
 function fingerprint(state){return canonical({controlId:state.source.controlId,sourceHash:hash(canonical(state.source)),targetDirectory:state.details.targetDirectory,admission:state.details.admission});}
 function signalCheck(signal){need(!closing,'FIELD_HOST_CLOSING');checkFieldMapSignalV1(stop.signal);checkFieldMapSignalV1(signal);}
 async function connection(account,signal,work){
  signalCheck(signal);const c=new pg.Client({...account,application_name:'idms-field-map-authority-host-v1',connectionTimeoutMillis:5000,statement_timeout:5000});c.on('error',()=>{});clients.add(c);created++;
  try{await c.connect();signalCheck(signal);return await work(c);}finally{const socket=c.connection?.stream,done=!socket||socket.closed?Promise.resolve():new Promise(ok=>socket.once('close',ok));await c.end();await done;clients.delete(c);retired++;}
 }
 function registered(state,t,credentials){
  const inventory=state.source.inventory,db=inventory.databases.find(d=>d.datname===t.account.database),role=inventory.roles.find(r=>r.rolname===t.account.user),gate=state.source.active.find(d=>d.database===t.account.database);
  need(db&&role&&gate&&db.oid===t.binding.databaseOid&&role.oid===t.binding.roleOid&&role.rolcanlogin&&!role.rolsuper&&!role.rolinherit&&!role.rolcreaterole&&!role.rolcreatedb&&!role.rolreplication&&!role.rolbypassrls&&gate.databaseOid===t.binding.databaseOid&&credentials.controlId===state.source.controlId&&credentials.roles[t.account.user]===t.account.password,'FIELD_HOST_REGISTERED_ACCOUNT');return gate;
 }
 async function current(t,signal){
  signalCheck(signal);for(const [path,digest]of pins){need((await readApplicationFileV1(path)).sha256===digest,'FIELD_HOST_FILE_CHANGED');signalCheck(signal);}
  const state=await cold.assertCurrent();signalCheck(signal);need(fingerprint(state)===initialFingerprint,'FIELD_HOST_ADMISSION_CHANGED');
  const credentials=await json(credentialFile);need(pins.get(resolve(credentialFile))===state.details.admission.credentialHash,'FIELD_HOST_CREDENTIAL_HASH');const gate=registered(state,t,credentials),target=await realpath(state.details.targetDirectory);
  need(same(target,state.details.targetDirectory),'FIELD_HOST_TARGET_ALIAS');
  await connection({...config.controlAccount,database:t.account.database},signal,async c=>{
   const id=(await c.query("SELECT (pg_control_system()).system_identifier::text AS system_id,current_setting('data_directory') AS directory,session_user::regrole::oid::text AS control_oid,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,pg_is_in_recovery() AS standby")).rows[0];
   need(id.system_id===state.source.inventory.identity.system_id&&id.system_id===gate.systemIdentifier&&same(await realpath(id.directory),target)&&id.control_oid===state.source.inventory.identity.control_oid&&id.control_oid===gate.controlOid&&id.database_oid===t.binding.databaseOid&&!id.standby,'FIELD_HOST_DATABASE_IDENTITY');
   const s=(await c.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0],epoch=(await c.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS value FROM runtime_write_fence_v1._ddl_epoch')).rows[0].value;
   need(s&&s.state==='OPEN'&&s.finalized===true&&s.deployment===gate.deployment&&String(s.database_oid)===gate.databaseOid&&String(s.owner_oid)===gate.ownerOid&&String(s.control_oid)===gate.controlOid&&s.catalog_hash===gate.catalogHash&&String(s.ddl_epoch)===String(epoch)&&s.operation===state.details.admission.openOperations[t.account.database]&&s.authority_id===state.source.sourceAuthority.authorityId&&String(s.authority_epoch)===String(state.details.admission.authorityEpoch)&&s.authority_hash===state.details.admission.authorityHash,'FIELD_HOST_SQL_FENCE');
  });signalCheck(signal);
  await connection(t.account,signal,async c=>{const id=(await c.query("SELECT session_user::regrole::oid::text AS role,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,has_function_privilege(session_user,'state_map_v1.apply_delta_v1(text,uuid,bigint,bytea,jsonb)','EXECUTE') AS writer")).rows[0];need(id.role===t.binding.roleOid&&id.db===t.binding.databaseOid,'FIELD_HOST_ACTUAL_ACCOUNT');need(id.writer===true,'FIELD_HOST_ROLE_NOT_WRITER');need(await inspectStateMapCatalog(c)===t.binding.catalogHash,'FIELD_HOST_STATE_CATALOG');});signalCheck(signal);
  // An external transition while SQL identities were checked must also fail.
  need(fingerprint(await cold.assertCurrent())===initialFingerprint,'FIELD_HOST_ADMISSION_CHANGED');signalCheck(signal);
 }
 const api={state(){return Object.freeze({closing,closed,active:active.size,connectionsActive:clients.size,connectionsCreated:created,connectionsRetired:retired});},tenantBindings(){need(!closing&&config,'FIELD_HOST_CLOSING');return new Map(config.tenants.map(t=>[t.tenantId,{account:structuredClone(t.account),binding:structuredClone(t.binding),guard:(phase,signal)=>api.assertCurrent(t.tenantId,phase,signal)}]));},assertCurrent(tenant,phase='READ',signal){need(['READ','WRITE','PRECOMMIT','POSTCOMMIT'].includes(phase),'FIELD_HOST_PHASE');signalCheck(signal);const t=config?.tenants.find(t=>t.tenantId===tenant);need(t,'FIELD_HOST_TENANT_UNKNOWN');need(active.size<32,'FIELD_HOST_CAPACITY');const task=Promise.resolve().then(()=>current(t,signal));active.add(task);void task.finally(()=>active.delete(task)).catch(()=>{});return task;},close(){if(closeJob)return closeJob;closing=true;stop.abort();return closeJob=(async()=>{await Promise.allSettled([...active]);need(clients.size===0&&created===retired,'FIELD_HOST_SQL_NOT_RETIRED');if(config){config.controlAccount.password='';for(const t of config.tenants)t.account.password='';}config=null;cold=null;initialState=null;closed=true;})();}};
 try{
  const path=resolve(file);config=fieldMapAuthorityHostConfigV1(await json(path));const authorityFile=resolve(dirname(path),config.authorityRuntimeFile),trustFile=resolve(dirname(path),config.coldTrustFile);need(new Set([path,authorityFile,trustFile]).size===3,'FIELD_HOST_REFERENCE_ALIAS');
  cold=new RuntimeColdGuardV1(await json(trustFile),new IdentityAuthorityGuardV1(authorityRuntimeV1(await json(authorityFile))));initialState=await cold.assertCurrent();initialFingerprint=fingerprint(initialState);credentialFile=initialState.details.admission.credentialFile;need(text(credentialFile)&&isAbsolute(credentialFile),'FIELD_HOST_CREDENTIAL_FILE');await json(credentialFile);
  for(const path of pins.keys())for(const dir of [initialState.source.inventory.identity.directory,initialState.details.targetDirectory])need(outside(path,dir),'FIELD_HOST_CONFIG_IN_PGDATA');
  for(const t of config.tenants)await api.assertCurrent(t.tenantId);return api;
 }catch(error){await api.close();throw error;}
}
