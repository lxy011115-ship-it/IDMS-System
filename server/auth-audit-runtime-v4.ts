import {requireAuthAuditTransportV4} from './auth-audit-transport-v4.ts';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import pg from 'pg';
import type {ClientConfig} from 'pg';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {validateKeyRing} from './auth-state.ts';
import {AuthAuditCryptoV4,authAuditNeedV4 as need} from './auth-audit-event-v4.ts';
import {AuthAuditSourceV4,type AuthAuditQueueBindingV4} from './auth-audit-source-v4.ts';
import {AuthAuditMapV4Writer} from './auth-audit-map-v4.ts';
import {AuthAuditWorkerV4} from './auth-audit-worker-v4.ts';
import {DomainMapSnapshot} from './domain-map-v4.ts';
interface Runtime {format:1;purpose:'AUTH_AUDIT_DELIVERY_RUNTIME';keyFile:string;source:{account:ClientConfig;binding:AuthAuditQueueBindingV4};targets:{account:ClientConfig;binding:StateMapBinding}[]}
async function jsonFile(path:string){try{const s=await lstat(path);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=2*1024*1024);return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}catch{throw Error('AUTH_AUDIT_RUNTIME_FILE_INVALID');}}
/** Receives only the derived outbox keyring, delivery role and business APP accounts. */
export async function loadAuthAuditRuntimeV4(file:string){
 const path=resolve(file),config=await jsonFile(path) as Runtime;need(config.format===1&&config.purpose==='AUTH_AUDIT_DELIVERY_RUNTIME'&&typeof config.keyFile==='string'&&config.source&&Array.isArray(config.targets)&&config.targets.length>0&&config.targets.length<=100&&Object.keys(config).sort().join(',')==='format,keyFile,purpose,source,targets','AUTH_AUDIT_RUNTIME_CONFIG');
 const ring=validateKeyRing(await jsonFile(resolve(dirname(path),config.keyFile))),crypto=new AuthAuditCryptoV4(ring,config.source.binding),targets=new Map(config.targets.map(t=>[t.binding.tenantId,t.binding]));need(targets.size===config.targets.length&&config.targets.every(t=>t.binding.databaseOid!==config.source.binding.databaseOid),'AUTH_AUDIT_RUNTIME_TARGETS');
 const source=new AuthAuditSourceV4(config.source.account,config.source.binding,crypto,targets),writers=new Map<string,AuthAuditMapV4Writer>();await source.delivery('00000000-0000-0000-0000-000000000000');
 for(const target of config.targets){requireAuthAuditTransportV4(target.account);const s=await DomainMapSnapshot.open(target.account,target.binding);await s.close();const c=new pg.Client(target.account);await c.connect();try{const r=(await c.query("SELECT r.*,has_function_privilege(session_user,'state_map_v1.apply_delta_v1(text,uuid,bigint,bytea,jsonb)','EXECUTE') AS write FROM pg_roles r WHERE r.oid=session_user::regrole::oid")).rows[0];need(r.write&&!r.rolsuper&&!r.rolinherit&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolreplication&&!r.rolbypassrls,'AUTH_AUDIT_RUNTIME_BUSINESS_ROLE');}finally{await c.end();}writers.set(target.binding.tenantId,new AuthAuditMapV4Writer(target.account,target.binding,{deployment:config.source.binding.deployment,databaseOid:config.source.binding.databaseOid,scope:config.source.binding.scope}));}
 const c=new pg.Client(config.source.account);await c.connect();try{const role=(await c.query("SELECT has_table_privilege(session_user,(SELECT p.oid FROM pg_class p JOIN pg_namespace n ON n.oid=p.relnamespace WHERE n.nspname='public' AND p.relname='auth_state'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS session_access")).rows[0];need(!role.session_access,'AUTH_AUDIT_RUNTIME_NO_SESSION_ACCESS');for(const target of config.targets){const p=(await c.query("SELECT has_database_privilege(session_user,$1,'CONNECT') AS source_business,has_database_privilege($2,current_database(),'CONNECT') AS business_auth",[target.account.database,target.account.user])).rows[0];need(!p.source_business&&!p.business_auth,'AUTH_AUDIT_RUNTIME_DATABASE_ISOLATION');}}finally{await c.end();}
 const worker=new AuthAuditWorkerV4({source,sourceAccount:config.source.account,writers,onError:async()=>{console.error('AUTH_AUDIT_DELIVERY_RETRY');}});return {config,source,writers,worker};
}
