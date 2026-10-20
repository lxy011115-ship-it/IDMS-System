import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
export async function verifyAiReviewTransportCleanupV4(){
 const authority=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),base=resolve('work/ai-review-transport-v4-20261020'),c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres'});await c.connect();const runs=[];let databases=0,roles=0;
 try{for(const item of await readdir(base,{withFileTypes:true})){if(!item.isDirectory()||!/^[a-f0-9]{12}$/.test(item.name))continue;const work=join(base,item.name),journal=JSON.parse(await readFile(join(work,'resources.private.json'),'utf8')),cleanup=JSON.parse(await readFile(join(work,'cleanup.json'),'utf8'));assert.equal(journal.nonce,item.name);assert.equal(cleanup.databasesRemoved,journal.dbs.length);assert.equal(cleanup.rolesRemoved,journal.roles.length);assert.equal(cleanup.exactOidOwnerAndZeroBackend,true);assert.equal(cleanup.noForceOrBackendTermination,true);
  for(const pin of journal.dbs){assert.equal(pin.name,'idms_aiqa_'+item.name+'_db');assert.match(pin.oid,/^[1-9][0-9]*$/);assert.equal((await c.query('SELECT oid FROM pg_database WHERE datname=$1 OR oid=$2::oid',[pin.name,pin.oid])).rowCount,0);databases++;}
  for(const pin of journal.roles){assert.match(pin.name,new RegExp('^idms_aiqa_'+item.name+'_(owner|app|reader)$'));assert.match(pin.oid,/^[1-9][0-9]*$/);assert.equal((await c.query('SELECT oid FROM pg_roles WHERE rolname=$1 OR oid=$2::oid',[pin.name,pin.oid])).rowCount,0);roles++;}
  for(const file of ['child.private.json','gateway.private.json']){let exists=true;try{await access(join(work,file));}catch(e){if(e.code!=='ENOENT')throw e;exists=false;}assert.equal(exists,false);}
  runs.push({nonce:item.name,databasesRemoved:journal.dbs.length,rolesRemoved:journal.roles.length,privateConfigsAbsent:true});
 }return {checkedAt:new Date().toISOString(),runs,databasesRemoved:databases,rolesRemoved:roles,ownedDatabaseLeftovers:0,ownedRoleLeftovers:0,onlyReadOnlyInventoryQueries:true};
 }finally{await c.end();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)console.log(JSON.stringify(await verifyAiReviewTransportCleanupV4()));
