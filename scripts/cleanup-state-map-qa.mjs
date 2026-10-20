import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,join,basename,dirname} from 'node:path';
import pg from 'pg';
import {privateNewFile} from './backup-support.mjs';
const path=resolve(process.argv[2]||''),base=resolve('work/incremental-state-20261019');assert.equal(dirname(path),base);assert.match(basename(path),/^[a-f0-9]{12}$/);assert.equal((await lstat(path)).isSymbolicLink(),false);
const pins=JSON.parse(await readFile(join(path,'owned-resources.private.json'),'utf8'));assert.equal(pins.nonce,basename(path));await assert.rejects(lstat(join(path,'cleanup.json')),e=>e.code==='ENOENT');await assert.rejects(lstat(join(path,'cleanup-recovered.json')),e=>e.code==='ENOENT');
const m=JSON.parse((await readFile('.local/postgres-runtime.json','utf8')).replace(/^\uFEFF/,'')),c=new pg.Client({host:m.host,port:m.port,user:'idms_bootstrap',password:m.bootstrapPassword,database:'postgres'});await c.connect();
try{
 for(const pin of pins.databases){assert.match(pin.name,new RegExp('^idms_smtqa_'+pins.nonce+'_(alpha|tbeta)_db$'));assert.equal(pin.owner,pin.name.slice(0,-3)+'_o');const row=(await c.query('SELECT oid::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[pin.name])).rows[0];assert.equal(row?.oid,pin.oid);assert.equal(row?.owner,pin.owner);
  let n;for(let i=0;i<80;i++){n=(await c.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[pin.oid])).rows[0].n;if(!n)break;await new Promise(ok=>setTimeout(ok,50));}assert.equal(n,0);await c.query('DROP DATABASE "'+pin.name+'"');
 }
 for(const pin of pins.roles.toReversed()){assert.match(pin.name,new RegExp('^idms_smtqa_'+pins.nonce+'_(alpha|tbeta)_[oar]$'));const r=(await c.query('SELECT oid::text,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[pin.name])).rows[0];assert.equal(r?.oid,pin.oid);for(const k of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])assert.equal(r[k],false);await c.query('DROP ROLE "'+pin.name+'"');}
 await privateNewFile(join(path,'cleanup-recovered.json'),JSON.stringify({at:new Date().toISOString(),ownedDatabases:pins.databases.length,ownedRoles:pins.roles.length,allOwnedRemoved:true,noForceOrBackendTermination:true}));console.log(JSON.stringify({exactInterruptedNonce:pins.nonce,databasesRemoved:pins.databases.length,rolesRemoved:pins.roles.length}));
}finally{await c.end();}
