import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {localConfig,adminToken} from './keycloak-local.mjs';
const read=async p=>JSON.parse(await readFile(p,'utf8'));
export async function verifyPredictiveCancelCleanupV1(){
 const runtime=await read('.local/postgres-runtime.json'),identity=await localConfig(),client=new pg.Client({host:runtime.host,port:runtime.port,user:'idms_bootstrap',password:runtime.bootstrapPassword,database:'postgres'}),runs=[];let databasesRemoved=0,rolesRemoved=0;await client.connect();
 try{await client.query('BEGIN READ ONLY');
  const base='work/predictive-cancel-v1-qa-20261021';
  for(const entry of await readdir(base,{withFileTypes:true})){
   if(!entry.isDirectory()||!/^[a-f0-9]{12}$/.test(entry.name))continue;
   const directory=join(base,entry.name),work=join('work/predictive-cancel-v1-20261021',entry.name),r=await read(join(directory,'resources.private.json')),auth=await read(join(directory,'auth-resources.private.json')),flow=await read(join(work,'flow-resources.private.json')),proof=await read(join(work,'verification.json')),cleanup=await read(join(directory,'cleanup.json')),authCleanup=await read(join(directory,'auth-cleanup.json'));
   assert.equal(r.nonce,entry.name);assert.equal(flow.nonce,entry.name);assert.equal(proof.cleanup.force,false);assert.equal(proof.cleanup.businessAndAuthClosed,true);assert.equal(proof.cleanup.flow.exactOidOwnerAndZeroBackends,true);assert.equal(proof.cleanup.flow.onlyOwnedJavaHandlesStopped,true);assert.equal(proof.cleanup.realm.realmRemoved,true);
   const databases=[...r.databases.map(([name,pin])=>({name,...pin})),auth.database,...flow.databases],roles=[...r.roles.map(([name,oid])=>({name,oid})),...auth.roles.map(({rolname,oid})=>({name:rolname,oid})),...flow.roles];
   assert.equal(cleanup.allOwnedDatabasesRemoved,r.databases.length);assert.equal(cleanup.allOwnedRolesRemoved,r.roles.length);assert.equal(cleanup.noForceOrBackendTermination,true);assert.equal(authCleanup.databaseRemoved,1);assert.equal(authCleanup.rolesRemoved,auth.roles.length);assert.equal(authCleanup.exactOidAndOwnerChecked,true);assert.equal(authCleanup.backendCountZero,true);assert.equal(authCleanup.force,false);assert.equal(proof.cleanup.flow.databasesRemoved,flow.databases.length);assert.equal(proof.cleanup.flow.rolesRemoved,flow.roles.length);
   for(const [kind,rows]of [['database',databases],['role',roles]])for(const row of rows){
    assert.match(row.name,new RegExp('^(idms_govqa_'+entry.name+'_(acme|sandbox)_[a-z]+|idms_reconflow_'+entry.name+'_(acme|sandbox)_(app|owner|reconciler)|idms_authqa_[a-f0-9]{16}(_[a-z]+)?)$'));assert.match(row.oid,/^[1-9][0-9]*$/);
    assert.equal((await client.query('SELECT oid FROM '+(kind==='database'?'pg_database':'pg_roles')+' WHERE '+(kind==='database'?'datname':'rolname')+'=$1 OR oid=$2::oid',[row.name,row.oid])).rowCount,0,row.name);
   }
   for(const name of await readdir(work))assert.ok(!/^(flow-(runtime|cancel|reservation)|predictor)\.private\.json$/.test(name),'Live runtime remains: '+name);
   const realm='reconqa-'+entry.name;assert.equal(proof.cleanup.realm.realm,realm);const response=await fetch(identity.origin+'/admin/realms/'+realm,{headers:{Authorization:'Bearer '+await adminToken(identity)},signal:AbortSignal.timeout(10000)});assert.equal(response.status,404);
   databasesRemoved+=databases.length;rolesRemoved+=roles.length;runs.push({nonce:entry.name,passed:proof.passed,checks:proof.checks.length,databases:databases.length,roles:roles.length,realmRemoved:true});
  }
  await client.query('COMMIT');return {checkedAt:new Date().toISOString(),runs,databasesRemoved,rolesRemoved,databaseLeftovers:0,roleLeftovers:0,realmLeftovers:0,readOnlyInventory:true,noForceOrBackendTermination:true};
 }finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await verifyPredictiveCancelCleanupV1()));
