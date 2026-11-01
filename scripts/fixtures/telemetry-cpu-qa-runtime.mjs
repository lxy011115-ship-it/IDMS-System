import assert from 'node:assert/strict';
import {readFile,mkdir,unlink} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {seedStore} from '../../server/store.ts';
import {appendAudit,verifyAuditChain} from '../../server/audit.ts';
import {emptyImports} from '../../server/imports.ts';
import {roleLayout,migrateTenant,businessRuntime} from '../database-migrations.mjs';
import {writePrivate} from '../keycloak-local.mjs';
export async function createCpuReceiverQa(history,{authority}={}){
 const main=authority||JSON.parse((await readFile('.local/postgres-runtime.json','utf8')).replace(/^\uFEFF/,''));assert(Number.isSafeInteger(history)&&history>=0&&history<=100000);assert(main.host==='127.0.0.1'&&Number.isInteger(main.port)&&typeof main.bootstrapPassword==='string');
 const nonce=randomUUID().replaceAll('-','').slice(0,12),base=resolve('.local'),directory=join(base,'canonical-receiver-qa-'+nonce);assert.ok(directory.startsWith(base+sep));await mkdir(directory,{recursive:false});
 const admin=new pg.Client({host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:'postgres'}),config={host:main.host,port:main.port,tenants:{},businessRoles:{}},dbPins=new Map(),rolePins=new Map(),files=[];await admin.connect();
 const save=async(name,value)=>{const file=join(directory,name);await writePrivate(file,JSON.stringify(value));files.push(file);return file;};
 const capture=async()=>{for(const [tenant,a]of Object.entries(config.tenants)){const r=config.businessRoles[tenant];for(const name of [a.user,r.owner,r.migrator.user,r.backup.user]){const row=(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0];if(row){if(rolePins.has(name))assert.equal(row.oid,rolePins.get(name));else rolePins.set(name,row.oid);}}}};
 const close=async()=>{
  for(const [name,oid]of dbPins){assert.equal((await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[name])).rows[0]?.oid,oid);let n;for(let i=0;i<50;i++){n=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[oid])).rows[0].n;if(!n)break;await new Promise(ok=>setTimeout(ok,100));}assert.equal(n,0);await admin.query(`DROP DATABASE "${name}"`);}
  await capture();for(const [name,oid]of rolePins)assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0]?.oid,oid);
  for(const [tenant,a]of Object.entries(config.tenants)){const r=config.businessRoles[tenant];for(const name of [r.migrator.user,r.backup.user,a.user,r.owner])if(rolePins.has(name))await admin.query(`DROP ROLE "${name}"`);}
  await admin.end();for(const file of files)await unlink(file);
 };
 try{
  for(const tenant of ['acme','sandbox']){const name='idms_cpucmpqa_'+tenant+'_'+nonce,a=config.tenants[tenant]={database:name,user:name,password:randomBytes(32).toString('base64url')};config.businessRoles[tenant]={...roleLayout(a),telemetry:tenant==='sandbox'};const r=config.businessRoles[tenant];assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1::text[])',[[name,r.owner,r.migrator.user,r.backup.user]])).rows[0].n,0);assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',[name])).rows[0].n,0);await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${a.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);await capture();await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);dbPins.set(name,(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[name])).rows[0].oid);await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);}
  const store=seedStore(),sandbox=store.audits.filter(a=>a.tenantId==='sandbox');while(sandbox.length<history){const tip=sandbox.at(-1);sandbox.push(appendAudit({audits:tip?[tip]:[]},{tenantId:'sandbox',objectType:'TELEMETRY_EVENT',objectId:randomUUID(),action:'TELEMETRY_STORED',actorType:'INTERFACE',actorId:'cpu-synthetic-history',correlationId:randomUUID(),metadata:{inputDigest:createHash('sha256').update(String(sandbox.length)).digest('hex'),origin:'SIMULATOR',deviceCode:'SIM-CNC-01',mapVersion:'cnc-simulator-1',pointId:randomUUID(),synthetic:true}}));}assert.ok(verifyAuditChain(sandbox,'sandbox'));store.audits=[...store.audits.filter(a=>a.tenantId!=='sandbox'),...sandbox];const {audits,idempotency,...business}=store,seed={version:2,business,audits,idempotency:[...idempotency],imports:emptyImports()};
  for(const tenant of ['acme','sandbox']){try{await migrateTenant({...config,bootstrapPassword:main.bootstrapPassword},tenant,seed);}finally{await capture();}}
  const businessFile=await save('business.json',businessRuntime(config)),source={tenantId:'sandbox',edgeId:'cpu-'+nonce,deviceCode:'SIM-CNC-01',origin:'SIMULATOR',mapVersion:'cnc-simulator-1',signingKey:randomBytes(32).toString('base64url'),acknowledgementKey:randomBytes(32).toString('base64url'),statusKey:randomBytes(32).toString('base64url'),statusUrl:'http://127.0.0.1:9/status',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',unit:'mm/s'}]},telemetryFile=await save('telemetry.json',{version:1,sources:[source]});
  return {directory,businessFile,telemetryFile,save,close,account:{host:main.host,port:main.port,user:'idms_bootstrap',password:main.bootstrapPassword,database:config.tenants.sandbox.database}};
 }catch(e){await close();throw e;}
}
