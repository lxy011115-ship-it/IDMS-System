import {join} from 'node:path';
import {databaseRead} from './existing-platform-probes.mjs';
import {jsonFile,sha} from './existing-platform-binding.mjs';
import {openExistingSqlite} from '../services/existing-sqlite.ts';
export async function deploymentEvidence(binding){
 const root=await jsonFile(binding.files.database.path),business=await jsonFile(binding.files.business.path),id=await jsonFile(binding.files.identity.path),auth=await jsonFile(binding.files.session.path);
 const connect=database=>({host:root.host,port:root.port,user:'idms_bootstrap',password:root.bootstrapPassword,database});
 const roles=await databaseRead(connect('postgres'),async c=>({
  roles:(await c.query('SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolvaliduntil FROM pg_roles ORDER BY rolname')).rows,
  memberships:(await c.query('SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY role,member')).rows
 }));
 const databases={};
 const names=[...Object.values(business.tenants).map(a=>a.database),...Object.values(root.workflowTenants).map(a=>a.database),id.database.database,auth.account.database];
 for(const name of names)databases[name]=await databaseRead(connect(name),async c=>{
  const catalog=(await c.query("SELECT c.relname,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' ORDER BY c.relname,a.attnum")).rows;
  const constraints=(await c.query("SELECT c.relname,x.conname,pg_get_constraintdef(x.oid) AS def FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,x.conname")).rows;
  const indexes=(await c.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows;
  const functions=(await c.query("SELECT p.proname,p.prosrc,p.proacl,p.prosecdef,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,p.oid")).rows;
  const schemas=(await c.query("SELECT nspname,pg_get_userbyid(nspowner) AS owner,nspacl FROM pg_namespace WHERE nspname='public'")).rows;
  const result={schemaAndPrivileges:sha(JSON.stringify({catalog,constraints,indexes,functions,schemas}))};
  if((await c.query("SELECT to_regclass('public.business_state') AS name")).rows[0].name)result.businessRevisions=(await c.query('SELECT tenant_id,revision FROM business_state ORDER BY tenant_id')).rows;
  if((await c.query("SELECT to_regclass('public.act_re_procdef') AS name")).rows[0].name)result.workflowDefinitions=sha(JSON.stringify((await c.query('SELECT id_,key_,version_,tenant_id_,deployment_id_,resource_name_ FROM act_re_procdef ORDER BY id_')).rows));
  return result;
 });
 const t=await jsonFile(binding.files.telemetry.path),spool=openExistingSqlite(t.edge.spool,'edge',t.sources[0],{readOnly:true});let queue;
 try{queue={pending:spool.prepare('SELECT count(*) AS n FROM pending').get().n,acknowledged:spool.prepare('SELECT count(*) AS n FROM acknowledged').get().n};}finally{spool.close();}
 return {rolesAndMemberships:sha(JSON.stringify(roles)),databases,queue,observedAt:new Date().toISOString()};
}
export function sameDeploymentStructure(before,after){
 return before.rolesAndMemberships===after.rolesAndMemberships&&JSON.stringify(Object.keys(before.databases))===JSON.stringify(Object.keys(after.databases))&&Object.entries(before.databases).every(([name,b])=>b.schemaAndPrivileges===after.databases[name]?.schemaAndPrivileges&&b.workflowDefinitions===after.databases[name]?.workflowDefinitions);
}
