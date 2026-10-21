import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import pg from 'pg';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}};
/** Read-only inventory, including failed but cleaned runs. Does not trust a PASS flag for absence. */
export async function verifyPredictiveConsoleAuthCleanupV4(){
 const runtime=await read('.local/postgres-runtime.json'),c=new pg.Client({host:runtime.host,port:runtime.port,user:'idms_bootstrap',password:runtime.bootstrapPassword,database:'postgres'}),runs=[];let databasesRemoved=0,rolesRemoved=0;await c.connect();
 const gone=async(kind,name,oid)=>{assert.match(name,/^idms_(?:govqa|authqa|audqa)_[a-f0-9_]+(?:[a-z_]+)?$/);assert.match(oid,/^[1-9][0-9]*$/);const table=kind==='database'?'pg_database':'pg_roles',column=kind==='database'?'datname':'rolname';assert.equal((await c.query('SELECT oid FROM '+table+' WHERE '+column+'=$1 OR oid=$2::oid',[name,oid])).rowCount,0,name);if(kind==='database')databasesRemoved++;else rolesRemoved++;};
 try{
  for(const base of ['work/predictive-console-auth-v4-qa-20261021']){
   for(const entry of await readdir(base,{withFileTypes:true})){if(!entry.isDirectory()||!/^[a-f0-9]{12}$/.test(entry.name))continue;const directory=join(base,entry.name),resources=await read(join(directory,'resources.private.json')),cleanup=await read(join(directory,'cleanup.json'));assert.equal(resources.nonce,entry.name);assert.equal(cleanup.allOwnedDatabasesRemoved,resources.databases.length);assert.equal(cleanup.allOwnedRolesRemoved,resources.roles.length);assert.ok(cleanup.noForceOrBackendTermination);
    const before={databasesRemoved,rolesRemoved};for(const [name,pin]of resources.databases)await gone('database',name,pin.oid);for(const [name,oid]of resources.roles)await gone('role',name,oid);
    if(await exists(join(directory,'auth-resources.private.json'))){const auth=await read(join(directory,'auth-resources.private.json')),authCleanup=await read(join(directory,'auth-cleanup.json'));assert.equal(authCleanup.databaseRemoved,1);assert.equal(authCleanup.rolesRemoved,auth.roles.length);await gone('database',auth.database.name,auth.database.oid);for(const r of auth.roles)await gone('role',r.rolname,r.oid);const delivery=await read(join(directory,'auth-audit-delivery-role.private.json'));await gone('role',delivery.name,delivery.oid);}
    const evidenceCandidates=['work/predictive-console-auth-v4-20261021','work/predictive-controls-auth-v4-20261021'];for(const root of evidenceCandidates){const evidence=join(root,entry.name),pinPath=join(evidence,'flow-database.private.json');if(await exists(pinPath)){const pin=await read(pinPath);await gone('database',pin.name,pin.databaseOid);await gone('role',pin.name,pin.roleOid);assert.equal(await exists(join(evidence,'flow-engine.private.json')),false);}
     if(await exists(evidence))for(const filename of ['http.private.json','worker.private.json','job-key.private.json','predictor.private.json',...Array.from({length:6},(_,i)=>'negative-'+i+'.private.json')])assert.equal(await exists(join(evidence,filename)),false,filename);
    }
    runs.push({nonce:entry.name,databasesRemoved:databasesRemoved-before.databasesRemoved,rolesRemoved:rolesRemoved-before.rolesRemoved});
   }
  }
  return {checkedAt:new Date().toISOString(),runs,databasesRemoved,rolesRemoved,ownedDatabaseLeftovers:0,ownedRoleLeftovers:0,onlyReadOnlyInventoryQueries:true};
 }finally{await c.end();}
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/verify-predictive-console-auth-cleanup-v4.mjs'))console.log(JSON.stringify(await verifyPredictiveConsoleAuthCleanupV4()));
