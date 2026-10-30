import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
const read=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const exists=async path=>{try{await access(path);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}};
/** Read-only exact-name/OID inventory. A live or incompletely cleaned run is an error. */
export async function verifySiteConsoleCleanupV4R3(){
 const r=await read('.local/postgres-runtime.json'),c=new pg.Client({host:r.host,port:r.port,user:'idms_bootstrap',password:r.bootstrapPassword,database:'postgres'}),runs=[];let databasesRemoved=0,rolesRemoved=0;await c.connect();
 const gone=async(kind,name,oid)=>{assert.match(name,/^(?:idms_(?:govqa|authqa|audqa)_[a-f0-9_]+[a-z_]*|idms_govqa_[a-f0-9]{12}_r3flow_(?:acme|sandbox))$/);assert.match(String(oid),/^[1-9][0-9]*$/);assert.equal((await c.query('SELECT oid FROM '+(kind==='database'?'pg_database':'pg_roles')+' WHERE '+(kind==='database'?'datname':'rolname')+'=$1 OR oid=$2::oid',[name,oid])).rowCount,0,name);if(kind==='database')databasesRemoved++;else rolesRemoved++;};
 try{for(const e of await readdir('work/site-console-r3-v4-qa-20261021',{withFileTypes:true})){if(!e.isDirectory()||!/^[a-f0-9]{12}$/.test(e.name))continue;const dir=join('work/site-console-r3-v4-qa-20261021',e.name),resources=await read(join(dir,'resources.private.json')),cleanup=await read(join(dir,'cleanup.json'));assert.equal(resources.nonce,e.name);assert.equal(cleanup.allOwnedDatabasesRemoved,resources.databases.length);assert.equal(cleanup.allOwnedRolesRemoved,resources.roles.length);assert.equal(cleanup.noForceOrBackendTermination,true);const before={databasesRemoved,rolesRemoved};for(const [name,p]of resources.databases)await gone('database',name,p.oid);for(const [name,oid]of resources.roles)await gone('role',name,oid);
  const auth=await read(join(dir,'auth-resources.private.json'));await gone('database',auth.database.name,auth.database.oid);for(const role of auth.roles)await gone('role',role.rolname,role.oid);const delivery=await read(join(dir,'auth-audit-delivery-role.private.json'));await gone('role',delivery.name,delivery.oid);assert.equal((await read(join(dir,'auth-cleanup.json'))).databaseRemoved,1);
  const evidence=join('work/site-console-r3-v4-20261021',e.name);if(await exists(evidence))for(const file of await readdir(evidence)){assert.ok(!/^(?:site|base-site|predictor|.*-jobs|.*-http|.*-worker|audit-key|audit-delivery|negative-.*|ui-credentials)\.private\.json$/.test(file),'Private runtime remains: '+file);}
  for(const tenant of ['acme','sandbox']){const flow=join(evidence,'flow-'+tenant),pinFile=join(flow,'flow-database.private.json');if(await exists(pinFile)){const pin=await read(pinFile);assert.equal(pin.name,'idms_govqa_'+e.name+'_r3flow_'+tenant);await gone('database',pin.name,pin.databaseOid);await gone('role',pin.name,pin.roleOid);assert.equal(await exists(join(flow,'flow-engine.private.json')),false);}}
  runs.push({nonce:e.name,databasesRemoved:databasesRemoved-before.databasesRemoved,rolesRemoved:rolesRemoved-before.rolesRemoved});
 }return {checkedAt:new Date().toISOString(),runs,databasesRemoved,rolesRemoved,ownedDatabaseLeftovers:0,ownedRoleLeftovers:0,onlyReadOnlyInventoryQueries:true};}finally{await c.end();}
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/verify-site-console-cleanup-v4-r3.mjs'))console.log(JSON.stringify(await verifySiteConsoleCleanupV4R3()));
