import {createHash} from 'node:crypto';
import type {Client} from 'pg';
export async function inspectAuthAuditCatalogV4(c:Pick<Client,'query'>){
 const prior=(await c.query("SELECT current_setting('search_path') AS path")).rows[0].path;await c.query("SELECT set_config('search_path','pg_catalog,pg_temp',false)");
 let failed=false;try{const sql=[
  "SELECT oid::text,nspowner::text,nspacl::text FROM pg_namespace WHERE nspname='auth_audit_v4'",
  "SELECT c.oid::text,c.relname,c.relkind,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace='auth_audit_v4'::regnamespace ORDER BY c.oid",
  "SELECT a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='auth_audit_v4'::regnamespace AND a.attnum>0 ORDER BY a.attrelid,a.attnum",
  "SELECT oid::text,proowner::text,proacl::text,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='auth_audit_v4'::regnamespace ORDER BY oid",
  "SELECT t.oid::text,t.tgrelid::text,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='auth_audit_v4'::regnamespace OR (t.tgrelid=(SELECT p.oid FROM pg_class p JOIN pg_namespace n ON n.oid=p.relnamespace WHERE n.nspname='public' AND p.relname='auth_state') AND t.tgname LIKE 'auth_audit_%') ORDER BY t.oid",
  "SELECT oid::text,pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint WHERE connamespace='auth_audit_v4'::regnamespace ORDER BY oid",
  "SELECT i.indexrelid::text,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='auth_audit_v4'::regnamespace ORDER BY i.indexrelid",
  "SELECT oid::text,evtname,evtevent,evtenabled,evtfoid::text,evtowner::text,evttags FROM pg_event_trigger WHERE evtname IN('auth_audit_ddl_start_v4','auth_audit_ddl_end_v4','auth_audit_sql_drop_v4') ORDER BY oid",
  "SELECT r.oid::text,r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconfig FROM pg_roles r WHERE r.oid IN(SELECT proowner FROM pg_proc WHERE pronamespace='auth_audit_v4'::regnamespace) OR r.oid IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='auth_audit_v4') ORDER BY r.oid",
  "SELECT m.roleid::text,m.member::text,m.grantor::text,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m WHERE m.roleid IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='auth_audit_v4') OR m.member IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='auth_audit_v4') ORDER BY m.roleid,m.member",
  'SELECT oid::text,datname,datdba::text,datacl::text,datallowconn,datconnlimit,encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()'];
  const data=[];for(const q of sql)data.push((await c.query(q)).rows);return createHash('sha256').update(JSON.stringify(data)).digest('hex');
 }catch(e){failed=true;throw e;}finally{try{await c.query("SELECT set_config('search_path',$1,false)",[prior]);}catch(e){if(!failed)throw e;}}
}
