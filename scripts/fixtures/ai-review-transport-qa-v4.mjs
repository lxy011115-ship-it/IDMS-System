import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {stateMapSchemaSql,inspectStateMapCatalog} from '../state-map-schema-v1.mjs';
import {aiReviewTransportSchemaV4} from '../ai-review-transport-schema-v4.mjs';
import {inspectAiReviewCatalogV4} from '../../server/ai-review-catalog-v4.ts';
import {AiReviewCryptoV4} from '../../server/ai-review-crypto-v4.ts';
import {AiReviewSourceV4} from '../../server/ai-review-source-v4.ts';
import {privateDirectory,privateNewFile} from '../backup-support.mjs';
const ident=name=>{assert.match(name,/^idms_aiqa_[a-f0-9]{12}_(db|owner|app|reader)$/);return '"'+name+'"';};
export async function createAiReviewTransportQaV4(config,sourceFiles){
 const authority=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),nonce=randomUUID().replaceAll('-','').slice(0,12),base='idms_aiqa_'+nonce,work=resolve('work/ai-review-transport-v4-20261020',nonce);await privateDirectory(work);
 const sourcePins={};for(const file of sourceFiles){const bytes=await readFile(file);sourcePins[file]=createHash('sha256').update(bytes).digest('hex');await privateNewFile(join(work,'source-'+Object.keys(sourcePins).length+'.txt'),bytes);}
 await privateNewFile(join(work,'source-pins.json'),JSON.stringify(sourcePins,null,2));
 const adminAccount={host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres'},admin=new pg.Client(adminAccount);await admin.connect();
 const roles=[],dbs=[],journal=()=>writeFile(join(work,'resources.private.json'),JSON.stringify({nonce,roles,dbs},null,2));let closed=false;
 const close=async()=>{if(closed)return;for(const pin of dbs){const found=(await admin.query('SELECT oid::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[pin.name])).rows[0];assert.equal(found?.oid,pin.oid);assert.equal(found.owner,pin.owner);let n=1;for(let i=0;i<100&&n;i++){n=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[pin.oid])).rows[0].n;if(n)await new Promise(ok=>setTimeout(ok,50));}assert.equal(n,0);await admin.query('DROP DATABASE '+ident(pin.name));}
  for(const pin of roles.toReversed()){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[pin.name])).rows[0]?.oid,pin.oid);await admin.query('DROP ROLE '+ident(pin.name));}await admin.end();closed=true;await privateNewFile(join(work,'cleanup.json'),JSON.stringify({databasesRemoved:dbs.length,rolesRemoved:roles.length,exactOidOwnerAndZeroBackend:true,noForceOrBackendTermination:true,at:new Date().toISOString()}));};
 try{await journal();const owner=base+'_owner',app=base+'_app',reader=base+'_reader',database=base+'_db',password=randomBytes(32).toString('base64url');
  for(const [name,login,pw]of [[owner,false,null],[app,true,password],[reader,true,randomBytes(32).toString('base64url')]]){assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount,0);await admin.query('CREATE ROLE '+ident(name)+(login?" LOGIN PASSWORD '"+pw+"'":' NOLOGIN')+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION');roles.push({name,oid:(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid});await journal();}
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0);await admin.query('CREATE DATABASE '+ident(database)+' OWNER '+ident(owner)+" TEMPLATE template0 ENCODING 'UTF8'");dbs.push({name:database,oid:(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[database])).rows[0].oid,owner});await journal();await admin.query('REVOKE ALL ON DATABASE '+ident(database)+' FROM PUBLIC');await admin.query('GRANT CONNECT ON DATABASE '+ident(database)+' TO '+ident(app)+','+ident(reader));
  const databaseOid=dbs[0].oid,deployment=createHash('sha256').update(nonce).digest('hex'),baseBinding={deployment,databaseOid,tenantId:config.tenantId},key=randomBytes(32),crypto=new AiReviewCryptoV4(key,baseBinding,config),root=new pg.Client({...adminAccount,database});await root.connect();let catalogHash,stateCatalog;
  try{await root.query('BEGIN');await root.query(await stateMapSchemaSql({tenant:config.tenantId,owner,app,reader}));await root.query(await aiReviewTransportSchemaV4({owner,app,tenant:config.tenantId,deployment,keyCheck:crypto.witness()}));await root.query('COMMIT');catalogHash=await inspectAiReviewCatalogV4(root);stateCatalog=await inspectStateMapCatalog(root);}finally{await root.end();}
  const account={host:authority.host,port:authority.port,user:app,password,database},binding={...baseBinding,roleOid:roles.find(r=>r.name===app).oid,catalogHash},source=new AiReviewSourceV4(account,binding,crypto);
  return {nonce,work,sourcePins,roles,dbs,config,key,account,binding,crypto,source,rootAccount:{...adminAccount,database},stateBinding:{databaseOid,roleOid:binding.roleOid,tenantId:config.tenantId,catalogHash:stateCatalog},close};
 }catch(error){await close();throw error;}
}
