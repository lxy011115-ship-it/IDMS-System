import assert from 'node:assert/strict';
import {readFile,unlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import pg from 'pg';
import {provisionAuthStore} from '../auth-session-store.mjs';
import {PostgresAuthStore} from '../../server/auth-store.ts';
import {sha,stable} from '../../server/auth-state.ts';
export async function siteConsoleColdAuthQaV4(qa){
 const ref=await provisionAuthStore(qa.business,qa.authority,{qa:true}),runtime=JSON.parse(await readFile(ref.runtimeFile,'utf8')),ring=JSON.parse(await readFile(runtime.keyFile,'utf8')),d=JSON.parse(await readFile(ref.deploymentFile,'utf8')),admin=new pg.Client(qa.adminAccount);await admin.connect();const names=[d.app.user,d.migrator.user,d.backup.user,d.ownerRole],roles=(await admin.query('SELECT rolname,oid::text FROM pg_roles WHERE rolname=ANY($1::text[])',[names])).rows;assert.equal(roles.length,4);const database=(await admin.query('SELECT oid::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[d.database])).rows[0];assert.equal(database.owner,d.ownerRole);const pools=[];
 await writeFile(join(qa.work,'auth-resources.private.json'),JSON.stringify({database:{name:d.database,...database},roles}));
 let detached=false;const detach=async()=>{if(detached)return;for(const store of pools.splice(0))await store.close();await admin.end();detached=true;};
 return {runtime,ring,detach,make(config){const pool=new pg.Pool({host:runtime.host,port:runtime.port,...runtime.account}),scope=sha(stable({deployment:runtime.deploymentDigest,issuer:config.issuer,clientId:config.clientId,audience:config.audience,origin:config.origin})),store=new PostgresAuthStore(pool,runtime,ring,scope);pools.push(store);return store;},async close(){if(detached)return;
  for(const store of pools)await store.close();const now=(await admin.query('SELECT oid::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[d.database])).rows[0];assert.deepEqual(now,database);assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[database.oid])).rows[0].n,0);assert.match(d.database,/^idms_authqa_[a-f0-9]{16}$/);await admin.query('DROP DATABASE "'+d.database+'"');for(const name of names){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0]?.oid,roles.find(r=>r.rolname===name).oid);await admin.query('DROP ROLE "'+name+'"');}await admin.end();for(const path of [ref.runtimeFile,ref.deploymentFile,join(dirname(ref.runtimeFile),'keys.json')])await unlink(path);await writeFile(join(qa.work,'auth-cleanup.json'),JSON.stringify({databaseRemoved:1,rolesRemoved:4,exactOidAndOwnerChecked:true,backendCountZero:true,force:false}));
 }};
}
