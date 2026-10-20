import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {join} from 'node:path';
import {readFile,unlink} from 'node:fs/promises';
import pg from 'pg';
import {privateNewFile} from '../backup-support.mjs';
import {launchWorkflow,workflowReady,workflowJar} from '../workflow-local.mjs';
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
const exact=n=>{assert.match(n,/^idms_govqa_[a-f0-9]{12}_mcflow$/);return '"'+n+'"';};
/** Dedicated real engine and database. Only recorded OIDs and the returned process are cleaned. */
export async function createMaintenanceConsoleFlowV4Qa(qa,work){
 const name='idms_govqa_'+qa.nonce+'_mcflow',password=randomBytes(32).toString('base64url'),serviceToken=randomBytes(32).toString('base64url'),admin=new pg.Client(qa.adminAccount),file=join(work,'flow-engine.private.json');await admin.connect();
 let roleOid,databaseOid,engine,sql,log='',configWritten=false;
 const jarSha=createHash('sha256').update(await readFile(workflowJar)).digest('hex');
 const close=async()=>{
  if(engine&&engine.exitCode===null&&engine.signalCode===null){const end=new Promise(ok=>engine.once('exit',ok));engine.kill();await end;}
  await sql?.end();
  if(databaseOid){const row=(await admin.query('SELECT oid::text,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[name])).rows[0];assert.equal(row?.oid,databaseOid);assert.equal(row.owner,name);let count;for(let i=0;i<100;i++){count=(await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datid=$1::oid',[databaseOid])).rows[0].n;if(!count)break;await wait(50);}assert.equal(count,0);await admin.query('DROP DATABASE '+exact(name));}
  if(roleOid){assert.equal((await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0]?.oid,roleOid);await admin.query('DROP ROLE '+exact(name));}
  await admin.end();if(configWritten)await unlink(file);assert.equal(createHash('sha256').update(await readFile(workflowJar)).digest('hex'),jarSha);
  return {flowDatabaseRemoved:databaseOid?1:0,flowRoleRemoved:roleOid?1:0,exactOidOwnerAndZeroBackends:true,ownedEngineTerminated:true,privateConfigRemoved:configWritten};
 };
 try{
  assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[name])).rowCount,0);assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);
  await admin.query(`CREATE ROLE ${exact(name)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);roleOid=(await admin.query('SELECT oid::text FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid;await privateNewFile(join(work,'flow-role.private.json'),JSON.stringify({name,roleOid}));
  await admin.query(`CREATE DATABASE ${exact(name)} OWNER ${exact(name)} TEMPLATE template0 ENCODING 'UTF8'`);databaseOid=(await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1',[name])).rows[0].oid;await privateNewFile(join(work,'flow-database.private.json'),JSON.stringify({name,roleOid,databaseOid}));await admin.query(`REVOKE ALL ON DATABASE ${exact(name)} FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE ${exact(name)} TO ${exact(name)}`);
  const listener=createServer();await new Promise(ok=>listener.listen(0,'127.0.0.1',ok));const port=listener.address().port;await new Promise(ok=>listener.close(ok));
  await privateNewFile(file,JSON.stringify({tenants:{sandbox:{jdbcUrl:`jdbc:postgresql://${qa.authority.host}:${qa.authority.port}/${name}`,user:name,password,serviceToken}}}));configWritten=true;engine=launchWorkflow(file,port);for(const stream of [engine.stdout,engine.stderr])stream.on('data',b=>{log=(log+b).slice(-20000);});
  const baseUrl='http://127.0.0.1:'+port;let ready=false;for(let i=0;i<160;i++){if(engine.exitCode!==null)throw Error('MAINTENANCE_QA_ENGINE_EXIT');if(await workflowReady({baseUrl,tenants:{sandbox:{serviceToken}}})){ready=true;break;}await wait(250);}assert.ok(ready,'MAINTENANCE_QA_ENGINE_TIMEOUT');
  sql=new pg.Client({host:qa.authority.host,port:qa.authority.port,user:name,password,database:name});await sql.connect();return {baseUrl,serviceToken,sql,jar:{path:workflowJar,sha256:jarSha},get log(){return log;},close};
 }catch(e){await privateNewFile(join(work,'flow-failure.private.json'),JSON.stringify({message:e.message,stack:e.stack,log}));await close();throw e;}
}
