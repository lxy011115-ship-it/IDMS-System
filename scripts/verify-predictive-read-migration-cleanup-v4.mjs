import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,'')),r=await read('.local/postgres-runtime.json'),c=new pg.Client({host:r.host,port:r.port,user:'idms_bootstrap',password:r.bootstrapPassword,database:'postgres'}),runs=[];let databases=0,roles=0;
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}};
await c.connect();try{for(const nonce of await readdir('work/predictive-read-migration-v4-qa-20261021')){if(!/^[a-f0-9]{12}$/.test(nonce))continue;const dir=join('work/predictive-read-migration-v4-qa-20261021',nonce),resources=await read(join(dir,'resources.private.json')),cleanup=await read(join(dir,'cleanup.json'));assert.equal(resources.nonce,nonce);assert.equal(cleanup.allOwnedDatabasesRemoved,resources.databases.length);assert.equal(cleanup.allOwnedRolesRemoved,resources.roles.length);assert.equal(cleanup.noForceOrBackendTermination,true);
 for(const [name,p]of resources.databases){assert.ok(name.startsWith('idms_govqa_'+nonce+'_'));assert.equal((await c.query('SELECT 1 FROM pg_database WHERE datname=$1 OR oid=$2::oid',[name,p.oid])).rowCount,0);databases++;}
 for(const [name,oid]of resources.roles){assert.ok(name.startsWith('idms_govqa_'+nonce+'_'));assert.equal((await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1 OR oid=$2::oid',[name,oid])).rowCount,0);roles++;}
 const evidence=join('work/predictive-read-migration-v4-20261021',nonce);assert.equal(await exists(join(evidence,'predictor.private.json')),false);assert.equal(await exists(join(evidence,'migration.private.json')),false);runs.push({nonce,databases:resources.databases.length,roles:resources.roles.length});
}console.log(JSON.stringify({at:new Date().toISOString(),runs,databasesRemoved:databases,rolesRemoved:roles,ownedDatabaseLeftovers:0,ownedRoleLeftovers:0,onlyReadOnlyInventoryQueries:true}));}finally{await c.end();}
