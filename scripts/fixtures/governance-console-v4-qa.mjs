import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {seedStore} from '../../server/store.ts';
import {readEntities} from '../../server/entity-repository.ts';
import {validateRuntimeConfig,verifyDatabaseSecurity,connectionFor} from '../../server/postgres-security.ts';
import {roleLayout,migrateTenant,businessRuntime} from '../database-migrations.mjs';
import {inspectStateMapCatalog} from '../state-map-schema-v1.mjs';
import {stateMapSchemaSqlV4 as stateMapSchemaSql} from '../state-map-schema-v4.mjs';
import {governanceConsoleSchemaSqlV4 as governanceJobsSchemaSqlV4} from '../governance-console-schema-v4.mjs';
import {inspectGovernanceJobCatalogV4} from '../../server/governance-job-catalog-v4.ts';
import {canonicalDigest} from '../../server/canonical-state.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const q=n=>{assert.match(n,/^idms_govqa_[a-z0-9_]+$/);return '"'+n+'"';};
export async function createGovernanceConsoleV4Qa(){
 const authority=await read('.local/postgres-runtime.json'),nonce=randomUUID().replaceAll('-','').slice(0,12),work=resolve('work/governance-console-v4-qa-20261020',nonce);await privateDirectory(work);
 const adminAccount={host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres'},admin=new pg.Client(adminAccount);await admin.connect();
 const dbPins=new Map(),rolePins=new Map(),roleNames=[],config={host:authority.host,port:authority.port,bootstrapPassword:authority.bootstrapPassword,tenants:{},businessRoles:{}},targets={};
 const journal=async()=>writeFile(join(work,'resources.private.json'),JSON.stringify({nonce,databases:[...dbPins],roles:[...rolePins]},null,2));
 const captureRoles=async()=>{for(const name of roleNames){const row=(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0];if(row){if(rolePins.has(name))assert.equal(rolePins.get(name),row.oid);else rolePins.set(name,row.oid);}}await journal();};
 const close=async()=>{
  await captureRoles();for(const [name,pin]of dbPins){const row=(await admin.query('SELECT oid::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[name])).rows[0];assert.equal(row?.oid,pin.oid);assert.equal(row.owner,pin.owner);let n;for(let i=0;i<80;i++){n=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[pin.oid])).rows[0].n;if(!n)break;await new Promise(ok=>setTimeout(ok,50));}assert.equal(n,0);await admin.query('DROP DATABASE '+q(name));}
  for(const [name,oid]of [...rolePins].toReversed()){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0]?.oid,oid);await admin.query('DROP ROLE '+q(name));}
  await admin.end();await privateNewFile(join(work,'cleanup.json'),JSON.stringify({at:new Date().toISOString(),allOwnedDatabasesRemoved:dbPins.size,allOwnedRolesRemoved:rolePins.size,noForceOrBackendTermination:true}));
 };
 try{
  // The only original-database operation is this repeatable-read, read-only capture.
  const original=validateRuntimeConfig(await read('.local/postgres-business.json')),a=original.tenants.acme,c=new pg.Client(connectionFor(original,a));await c.connect();let real,originalEvidence;
  try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verifyDatabaseSecurity(c,a,'acme');const loaded=await readEntities(c,'acme');real=loaded.payload;originalEvidence={capturedAt:new Date().toISOString(),readOnly:(await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only==='on',revision:loaded.revision,files:real.imports.batches.map(b=>({sha256:b.fileSha256,bytes:Buffer.from(b.originalBase64,'base64').length}))};await c.query('COMMIT');}finally{await c.end();}
  assert.equal(originalEvidence.readOnly,true);assert.equal(originalEvidence.files.length,6);assert.equal(originalEvidence.files.reduce((n,f)=>n+f.bytes,0),14513);
  const s=seedStore(),{audits,idempotency,...business}=s,seed={version:2,business:Object.fromEntries(Object.keys(business).map(key=>[key,[...real.business[key],...business[key].filter(r=>key==='tenants'?r.id!=='acme':r.tenantId!=='acme')]])),audits:[...real.audits,...audits.filter(a=>a.tenantId!=='acme')],idempotency:[...real.idempotency,...[...idempotency].filter(([key])=>!key.startsWith('acme:'))],imports:real.imports};
  for(const tenant of ['acme','sandbox']){
   const base='idms_govqa_'+nonce+'_'+tenant,a=config.tenants[tenant]={database:base+'_src',user:base+'_app',password:randomBytes(32).toString('base64url')},layout=config.businessRoles[tenant]={...roleLayout(a),telemetry:tenant==='sandbox'};
   for(const name of [a.user,layout.owner,layout.migrator.user,layout.backup.user]){assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount,0);roleNames.push(name);}
   assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[a.database])).rowCount,0);await admin.query(`CREATE ROLE ${q(a.user)} LOGIN PASSWORD '${a.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);await captureRoles();await admin.query(`CREATE DATABASE ${q(a.database)} OWNER ${q(a.user)}`);dbPins.set(a.database,{oid:(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[a.database])).rows[0].oid,owner:a.user});await journal();
   try{await migrateTenant(config,tenant,seed);}finally{await captureRoles();const row=(await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[a.database])).rows[0];dbPins.get(a.database).owner=row.owner;await journal();}
   // A real large auxiliary SQL row exercises chunk migration outside TenantPayload.
   const source=new pg.Client({...adminAccount,database:a.database});await source.connect();try{await source.query('INSERT INTO workflow_outbox(command_id,entity_id,request_digest,envelope,proposed,before_digest,context,status,response) VALUES($1,$2,$3,$4,$4,$3,$4,\'SYNCED\',$5)',[randomUUID(),randomUUID(),'0'.repeat(64),{}, {qaSynthetic:true,large:'中😀'.repeat(70000)}]);}finally{await source.end();}
   const name=base+'_map',owner=base+'_mo',app=base+'_ma',reader=base+'_mr',ingress=base+'_qi',password=randomBytes(32).toString('base64url'),readPassword=randomBytes(32).toString('base64url'),ingressPassword=randomBytes(32).toString('base64url');
   for(const [r,login,pw]of [[owner,false,null],[app,true,password],[reader,true,readPassword],[ingress,true,ingressPassword]]){assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[r])).rowCount,0);roleNames.push(r);await admin.query(`CREATE ROLE ${q(r)} ${login?"LOGIN PASSWORD '"+pw+"'":'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);await captureRoles();}
   assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);await admin.query(`CREATE DATABASE ${q(name)} OWNER ${q(owner)} TEMPLATE template0 ENCODING 'UTF8'`);dbPins.set(name,{oid:(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[name])).rows[0].oid,owner});await journal();await admin.query(`REVOKE ALL ON DATABASE ${q(name)} FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE ${q(name)} TO ${q(app)},${q(reader)},${q(ingress)}`);
   const root=new pg.Client({...adminAccount,database:name});await root.connect();try{await root.query('BEGIN');await root.query(await stateMapSchemaSql({tenant,owner,app,reader}));await root.query('COMMIT');targets[tenant]={account:{host:authority.host,port:authority.port,user:app,password,database:name},binding:{tenantId:tenant,databaseOid:dbPins.get(name).oid,roleOid:rolePins.get(app),catalogHash:await inspectStateMapCatalog(root)}};targets[tenant].readAccount={host:authority.host,port:authority.port,user:reader,password:readPassword,database:name};targets[tenant].readBinding={...targets[tenant].binding,roleOid:rolePins.get(reader)};const deployment=canonicalDigest({nonce,tenant,database:name});await root.query('BEGIN');await root.query(await governanceJobsSchemaSqlV4({tenant,owner,worker:app,ingress,deployment}));await root.query('COMMIT');assert.equal(await inspectStateMapCatalog(root),targets[tenant].binding.catalogHash);const queueCatalog=await inspectGovernanceJobCatalogV4(root);targets[tenant].queue={deployment,worker:{databaseOid:dbPins.get(name).oid,roleOid:rolePins.get(app),catalogHash:queueCatalog,tenantId:tenant,deployment},ingressBinding:{databaseOid:dbPins.get(name).oid,roleOid:rolePins.get(ingress),catalogHash:queueCatalog,tenantId:tenant,deployment},ingressAccount:{host:authority.host,port:authority.port,user:ingress,password:ingressPassword,database:name}};}finally{await root.end();}
  }
  await privateNewFile(join(work,'original-read-only-evidence.json'),JSON.stringify(originalEvidence));
  return {nonce,work,authority,adminAccount,business:businessRuntime(config),targets,originalEvidence,close};
 }catch(e){await close();throw e;}
}
