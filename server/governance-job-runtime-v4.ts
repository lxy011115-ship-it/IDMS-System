import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import pg from 'pg';
import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {AuthConfig} from './auth.ts';
import {createAuth} from './auth.ts';
import {PostgresAuthStore,validateAuthRuntime,verifyAuthStore} from './auth-store.ts';
import {validateKeyRing,sha,stable} from './auth-state.ts';
import {GovernanceJobStoreV4,type GovernanceQueueBindingV4} from './governance-job-store-v4.ts';
import {GovernanceJobCryptoV4} from './governance-job-crypto-v4.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import {DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import type {PublicGovernedSource} from './source-governance.ts';
interface RuntimeV4 {format:1;mode:'HTTP'|'WORKER';queue:{account:ClientConfig;binding:GovernanceQueueBindingV4};business:{account:ClientConfig;binding:StateMapBinding};jobKeyFile:string;auth:AuthConfig;authRuntimeFile:string;authDeploymentDigest:string;sources?:PublicGovernedSource[];host?:string;port?:number}
async function jsonFile(path:string){const stat=await lstat(path);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2*1024*1024,'GOVERNANCE_RUNTIME_FILE');return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}
/** Explicit private runtime; no production setup or fallback to memory authentication. */
export async function loadGovernanceJobRuntimeV4(file:string){
 const path=resolve(file),config=await jsonFile(path) as RuntimeV4,from=(p:string)=>resolve(dirname(path),p);need(config.format===1&&['HTTP','WORKER'].includes(config.mode)&&config.auth.mode==='oidc'&&config.queue.binding.databaseOid===config.business.binding.databaseOid&&config.queue.binding.tenantId===config.business.binding.tenantId,'GOVERNANCE_RUNTIME_BINDING');const queue=new GovernanceJobStoreV4(config.queue.account,config.queue.binding),ring=validateKeyRing(await jsonFile(from(config.jobKeyFile))),crypto=new GovernanceJobCryptoV4(ring,config.queue.binding);
 const s=await DomainMapSnapshot.open(config.business.account,config.business.binding);await s.close();const c=new pg.Client(config.business.account);await c.connect();try{const p=(await c.query("SELECT has_function_privilege(session_user,'state_map_v1.apply_delta_v1(text,uuid,bigint,bytea,jsonb)','EXECUTE') AS write,has_function_privilege(session_user,'state_map_v1.publish_branch_v1(text,uuid,uuid,bigint,bytea,bigint,bytea,bytea)','EXECUTE') AS publish")).rows[0];need(!p.publish&&(config.mode==='HTTP'?!p.write:p.write),'GOVERNANCE_RUNTIME_ROLE');}finally{await c.end();}
 const qi=new pg.Client(config.queue.account);await qi.connect();try{const p=(await qi.query("SELECT has_function_privilege(session_user,'governance_jobs_v4.claim_v4(text,uuid,uuid)','EXECUTE') AS claim,has_function_privilege(session_user,(SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='state_map_v1' AND p.proname='read_head_v1'),'EXECUTE') AS business")).rows[0];need(config.mode==='HTTP'?!p.claim&&!p.business:p.claim,'GOVERNANCE_RUNTIME_QUEUE_ROLE');}finally{await qi.end();}await queue.find('__runtime_probe__','00000000-0000-0000-0000-000000000000');
 const authFile=from(config.authRuntimeFile),runtime=validateAuthRuntime(await jsonFile(authFile),config.authDeploymentDigest),authRing=validateKeyRing(await jsonFile(resolve(dirname(authFile),runtime.keyFile))),pool=new pg.Pool({host:runtime.host,port:runtime.port,...runtime.account,max:4,connectionTimeoutMillis:5000,statement_timeout:15000});pool.on('error',()=>{});
 try{const client=await pool.connect();try{await verifyAuthStore(client,runtime,authRing);const denied=(await client.query("SELECT has_database_privilege(current_user,$1,'CONNECT') AS app,has_database_privilege($2,$1,'CONNECT') AS backup",[config.business.account.database,runtime.account.backupRole])).rows[0];need(!denied.app&&!denied.backup,'GOVERNANCE_RUNTIME_AUTH_ISOLATION');}finally{client.release();}}catch(e){await pool.end();throw e;}
 const scope=sha(stable({deployment:runtime.deploymentDigest,issuer:config.auth.issuer,clientId:config.auth.clientId,audience:config.auth.audience,origin:new URL(config.auth.origin!).origin})),state=new PostgresAuthStore(pool,runtime,authRing,scope),auth=createAuth(config.auth,undefined,state),provider=new GovernanceJobAuthV4(auth,state);return {config,queue,crypto,auth,provider,close:()=>auth.close()};
}
