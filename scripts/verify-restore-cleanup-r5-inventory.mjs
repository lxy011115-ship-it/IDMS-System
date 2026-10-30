import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
const read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,'')),authority=await read('.local/postgres-runtime.json'),c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres'}),runs=[];let databases=0,roles=0;
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}};
await c.connect();try{
 for(const nonce of await readdir('work/restore-cleanup-r5-qa-20261021')){if(!/^[a-f0-9]{12}$/.test(nonce))continue;const dir=join('work/restore-cleanup-r5-qa-20261021',nonce),r=await read(join(dir,'resources.json')),v=await read(join(dir,'verification.json'));assert.equal(r.nonce,nonce);
  for(const [name,pin]of r.databases){assert.match(name,/^(?:idms_restoreqa_[a-f0-9]{12}|idms_restore_acme_[a-f0-9]{12})$/);assert.equal((await c.query('SELECT oid FROM pg_database WHERE datname=$1 OR oid=$2::oid',[name,pin.oid])).rowCount,0);databases++;}
  for(const [name,oid]of r.roles){assert.match(name,/^(?:idms_restoreqa_[a-f0-9]{12}(?:_(?:owner|migrator|backup))?|idms_restore_acme_[a-f0-9]{12})$/);assert.equal((await c.query('SELECT oid FROM pg_roles WHERE rolname=$1 OR oid=$2::oid',[name,oid])).rowCount,0);roles++;}
  if(!v.passed)assert.equal((await read(join(dir,'lost-credential-target-cleanup-verification.json'))).databaseAndRoleAbsentByNameAndOid,true);
  for(const sub of ['cleanup_failure','body_and_cleanup_failure','success'])if(await exists(join(dir,sub)))for(const f of await readdir(join(dir,sub)))assert.ok(!/^idms_restore_acme_[a-f0-9]{12}\.private\.json$/.test(f),'Owned restore credential remains');
  runs.push({nonce,passed:v.passed,registeredDatabases:r.databases.length,registeredRoles:r.roles.length});
 }
 // Covers the first iteration's successful target, whose name/OID was not retained in its fixture journal.
 const unregisteredDatabases=(await c.query("SELECT datname FROM pg_database WHERE datname ~ '^idms_restore_(acme|sandbox)_[a-f0-9]{12}$'")).rows;
 const unregisteredRoles=(await c.query("SELECT rolname FROM pg_roles WHERE rolname ~ '^idms_restore_(acme|sandbox)_[a-f0-9]{12}$'")).rows;
 assert.equal(unregisteredDatabases.length,0);assert.equal(unregisteredRoles.length,0);
 console.log(JSON.stringify({checkedAt:new Date().toISOString(),runs,registeredDatabasesAbsentByNameAndOid:databases,registeredRolesAbsentByNameAndOid:roles,allGeneratedRestoreDatabaseNameInventory:0,allGeneratedRestoreRoleNameInventory:0,onlyReadOnlyInventoryQueries:true}));
}finally{await c.end();}
