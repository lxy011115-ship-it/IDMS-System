import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {stageFieldRuntimePrivileges} from '../field-activation-security.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const client=new pg.Client({...config.connection,connectionTimeoutMillis:5000,query_timeout:10000,options:'-c statement_timeout=8000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=30000'});
client.on('error',()=>{});
try{
 await client.connect();
 await client.query('BEGIN');
 const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await stageFieldRuntimePrivileges(client,config.account,config.migrator,config.tenantId);
 process.send({type:'STAGED',pid});
 const command=await new Promise((ok,no)=>{process.once('message',ok);process.once('disconnect',()=>no(Error('Owner disconnected')));});
 if(command?.type!=='COMMIT')throw Error('Unexpected activation security QA command');
 await client.query('COMMIT');
 // The actual COMMIT reaches PostgreSQL; no success acknowledgement is sent.
 await client.end();
 process.exitCode=23;
}catch(e){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});process.stderr.write(JSON.stringify({code:e.code||'ACTIVATION_SECURITY_PROBE_FAILED'})+'\n');process.exitCode=1;}
finally{if(process.connected)process.disconnect();}
