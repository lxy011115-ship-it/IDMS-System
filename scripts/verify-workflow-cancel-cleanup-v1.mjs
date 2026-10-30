import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
export async function verifyWorkflowCancelCleanupV1(){
 const read=async p=>JSON.parse(await readFile(p,'utf8')),runtime=await read('.local/postgres-runtime.json');
 const client=new pg.Client({host:runtime.host,port:runtime.port,user:'idms_bootstrap',password:runtime.bootstrapPassword,database:'postgres'}),runs=[];let databases=0,roles=0;await client.connect();
 try{await client.query('BEGIN READ ONLY');
  for(const entry of await readdir('work/workflow-cancel-v1-20261021',{withFileTypes:true})){if(!entry.isDirectory()||!/^[a-f0-9]{12}$/.test(entry.name))continue;const directory=join('work/workflow-cancel-v1-20261021',entry.name),resources=await read(join(directory,'resources.private.json')),proof=await read(join(directory,'verification.json'));assert.equal(resources.nonce,entry.name);assert.equal(proof.cleanup.databasesRemoved,resources.databases.length);assert.equal(proof.cleanup.rolesRemoved,resources.roles.length);assert.equal(proof.cleanup.force,false);assert.equal(proof.cleanup.exactOidOwnerAndZeroBackends,true);
   for(const [kind,rows]of [['database',resources.databases],['role',resources.roles]])for(const row of rows){assert.match(row.name,new RegExp('^idms_cancelqa_'+entry.name+'_(acme|sandbox)_(workflow|owner|reconciler)$'));assert.match(row.oid,/^[1-9][0-9]*$/);const table=kind==='database'?'pg_database':'pg_roles',column=kind==='database'?'datname':'rolname';assert.equal((await client.query('SELECT oid FROM '+table+' WHERE '+column+'=$1 OR oid=$2::oid',[row.name,row.oid])).rowCount,0,row.name);if(kind==='database')databases++;else roles++;}
   for(const name of await readdir(directory))assert.ok(!/^(workflow|cancel|negative-.+)\.private\.json$/.test(name),'Live private runtime remains: '+name);
   runs.push({nonce:entry.name,passed:proof.passed,checks:proof.checks.length,databases:resources.databases.length,roles:resources.roles.length});
  }
  await client.query('COMMIT');return {checkedAt:new Date().toISOString(),runs,databasesRemoved:databases,rolesRemoved:roles,databaseLeftovers:0,roleLeftovers:0,onlyReadOnlyInventoryQueries:true};
 }finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await verifyWorkflowCancelCleanupV1()));
