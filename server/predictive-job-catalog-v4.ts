import {createHash} from 'node:crypto';
import type {Client} from 'pg';
export async function inspectPredictiveJobCatalogV4(c:Pick<Client,'query'>){
 const prior=(await c.query("SELECT current_setting('search_path') AS path")).rows[0].path;await c.query("SELECT set_config('search_path','pg_catalog,pg_temp',false)");
 try{const sql=[
  "SELECT oid::text,nspowner::text,nspacl::text FROM pg_namespace WHERE nspname='predictive_jobs_v4'",
  "SELECT c.oid::text,c.relname,c.relkind,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace='predictive_jobs_v4'::regnamespace ORDER BY c.oid",
  "SELECT a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='predictive_jobs_v4'::regnamespace AND a.attnum>0 ORDER BY a.attrelid,a.attnum",
  "SELECT oid::text,proowner::text,proacl::text,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='predictive_jobs_v4'::regnamespace ORDER BY oid",
  "SELECT t.oid::text,t.tgrelid::text,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='predictive_jobs_v4'::regnamespace ORDER BY t.oid",
  "SELECT oid::text,pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint WHERE connamespace='predictive_jobs_v4'::regnamespace ORDER BY oid",
  "SELECT i.indexrelid::text,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='predictive_jobs_v4'::regnamespace ORDER BY i.indexrelid",
  "SELECT oid::text,evtname,evtevent,evtenabled,evtfoid::text,evtowner::text,evttags FROM pg_event_trigger WHERE evtname IN('predictive_queue_ddl_start_v4','predictive_queue_ddl_end_v4','predictive_queue_sql_drop_v4') ORDER BY oid",
  "SELECT r.oid::text,r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconfig FROM pg_roles r WHERE r.oid IN(SELECT proowner FROM pg_proc WHERE pronamespace='predictive_jobs_v4'::regnamespace) OR r.oid IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='predictive_jobs_v4') ORDER BY r.oid",
  "SELECT m.roleid::text,m.member::text,m.grantor::text,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m WHERE m.roleid IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='predictive_jobs_v4') OR m.member IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='predictive_jobs_v4') ORDER BY m.roleid,m.member",
  'SELECT oid::text,datname,datdba::text,datacl::text,datallowconn,datconnlimit,encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()'];
  const data=[];for(const q of sql)data.push((await c.query(q)).rows);return createHash('sha256').update(JSON.stringify(data)).digest('hex');
 }finally{await c.query("SELECT set_config('search_path',$1,false)",[prior]);}
}
