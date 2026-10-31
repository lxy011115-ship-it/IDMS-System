import net from 'node:net';
import pg from 'pg';
import {runtimeReadOnly} from '../server/runtime-db-probe.ts';
import {cancelSpareQuery} from '../server/spares-cancel.ts';
import {InspectionError,need,localHost,localUrl} from './runtime-inspection-input.mjs';

export function checkSignal(signal,deadline=Infinity){if(signal?.aborted||performance.now()>=deadline)throw new InspectionError('OBSERVATION_TIMEOUT','UNKNOWN');}
export {runtimeHttpJson as httpJson} from '../server/runtime-http.ts';
export async function tcpReachable(host,port,{signal,timeoutMs=2000}={}){
 host=localHost(host);need(Number.isInteger(port)&&port>=1&&port<=65535,'LOCAL_ENDPOINT_REQUIRED');
 const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);checkSignal(combined);
 return new Promise((resolve,reject)=>{let outcome;const socket=net.connect({host,port});
  const abort=()=>{outcome=new InspectionError('OBSERVATION_TIMEOUT','UNKNOWN');socket.destroy();};
  socket.once('connect',()=>{outcome=true;socket.destroy();});socket.once('error',()=>{outcome??=new InspectionError('TCP_UNAVAILABLE');socket.destroy();});
  socket.once('close',()=>{combined.removeEventListener('abort',abort);if(outcome===true)resolve(true);else reject(outcome||new InspectionError('TCP_UNAVAILABLE'));});combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();
 });
}
/** Every statement runs on one owned read-only session. Wait for the original
 * query, CancelRequest, rollback and transport end; no timeout-driven retries. */
export async function readOnlyDatabase(config,account,check,{signal,timeoutMs=3000,Pool=pg.Pool,cancel=cancelSpareQuery}={}){
 const host=localHost(config.host);need(Number.isInteger(config.port)&&config.port>=1&&config.port<=65535,'DATABASE_CONFIG_INVALID');
 need(account&&[account.user,account.database].every(x=>typeof x==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(x))&&typeof account.password==='string'&&account.password.length>0,'DATABASE_CONFIG_INVALID');
 const pool=new Pool({host,port:config.port,user:account.user,password:account.password,database:account.database,max:1,connectionTimeoutMillis:timeoutMs,statement_timeout:timeoutMs,lock_timeout:timeoutMs,idle_in_transaction_session_timeout:10000,application_name:'idms-readonly-inspection'});pool.on('error',()=>{});
 try{return await runtimeReadOnly(pool,async client=>{
  const r=(await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];need(r?.database===account.database&&r?.role===account.user,'DATABASE_BINDING_MISMATCH');
  const role=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0];need(role&&!Object.values(role).some(Boolean),'DATABASE_ROLE_UNSAFE');
  const rights=(await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS create_db,has_database_privilege(current_user,current_database(),'TEMP') AS temp,has_schema_privilege(current_user,'public','CREATE') AS create_schema,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS memberships")).rows[0];need(rights&&!Object.values(rights).some(Boolean),'DATABASE_ROLE_UNSAFE');
  await check(client);return true;
 },{signal,timeoutMs,cancel});}finally{await pool.end();}
}
