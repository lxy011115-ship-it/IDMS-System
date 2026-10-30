import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}};
/** Run only when all predictive-console QA attempts are terminal. No lifecycle mutations. */
export async function verifyPredictiveConsoleCleanupV4(){
 const r=await read('.local/postgres-runtime.json'),c=new pg.Client({host:r.host,port:r.port,user:'idms_bootstrap',password:r.bootstrapPassword,database:'postgres'}),runs=[];let databasesRemoved=0,rolesRemoved=0;
 await c.connect();
 const gone=async(kind,name,oid)=>{assert.match(name,/^idms_govqa_[a-f0-9]{12}_[a-z_]+$/);assert.match(String(oid),/^[1-9][0-9]*$/);assert.equal((await c.query('SELECT oid FROM '+(kind==='database'?'pg_database':'pg_roles')+' WHERE '+(kind==='database'?'datname':'rolname')+'=$1 OR oid=$2::oid',[name,oid])).rowCount,0,name);if(kind==='database')databasesRemoved++;else rolesRemoved++;};
 try{
  for(const e of await readdir('work/predictive-console-v4-qa-20261020',{withFileTypes:true})){
   if(!e.isDirectory()||!/^[a-f0-9]{12}$/.test(e.name))continue;
   const dir=join('work/predictive-console-v4-qa-20261020',e.name),resource=join(dir,'resources.private.json'),before={databasesRemoved,rolesRemoved};
   if(!await exists(resource)){
    const setup=await read(join(dir,'setup-failed.json'));assert.equal(setup.nonce,e.name);assert.equal(setup.resourceCreationStarted,false);
    const prefix='idms_govqa_'+e.name+'_';assert.equal((await c.query('SELECT oid FROM pg_database WHERE left(datname,length($1))=$1',[prefix])).rowCount,0);assert.equal((await c.query('SELECT oid FROM pg_roles WHERE left(rolname,length($1))=$1',[prefix])).rowCount,0);
    runs.push({nonce:e.name,setupFailedBeforeResourceCreation:true,databasesRemoved:0,rolesRemoved:0});continue;
   }
   const pins=await read(resource),cleanup=await read(join(dir,'cleanup.json'));assert.equal(pins.nonce,e.name);assert.equal(cleanup.allOwnedDatabasesRemoved,pins.databases.length);assert.equal(cleanup.allOwnedRolesRemoved,pins.roles.length);assert.equal(cleanup.noForceOrBackendTermination,true);
   for(const [name,p]of pins.databases)await gone('database',name,p.oid);for(const [name,oid]of pins.roles)await gone('role',name,oid);
   const evidence=join('work/predictive-console-pg-v4-20261020',e.name);
   if(await exists(join(evidence,'flow-database.private.json'))){const flow=await read(join(evidence,'flow-database.private.json'));await gone('database',flow.name,flow.databaseOid);await gone('role',flow.name,flow.roleOid);assert.equal(await exists(join(evidence,'flow-engine.private.json')),false);}
   runs.push({nonce:e.name,databasesRemoved:databasesRemoved-before.databasesRemoved,rolesRemoved:rolesRemoved-before.rolesRemoved});
  }
  return {at:new Date().toISOString(),runs,databasesRemoved,rolesRemoved,ownedDatabaseLeftovers:0,ownedRoleLeftovers:0,readOnlyInventory:true};
 }finally{await c.end();}
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/verify-predictive-console-cleanup-v4.mjs'))console.log(JSON.stringify(await verifyPredictiveConsoleCleanupV4()));
