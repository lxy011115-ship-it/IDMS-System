import {createHash} from 'node:crypto';
import type {Client} from 'pg';
// Exact metadata is pinned outside the database. No rebaseline on mismatch.
export async function inspectStateMapCatalog(client: Pick<Client,'query'>){
 const previous=(await client.query("SELECT pg_catalog.current_setting('search_path') AS path")).rows[0].path;
 await client.query("SELECT pg_catalog.set_config('search_path','pg_catalog,pg_temp',false)");
 try{
 const queries=[
  `SELECT c.oid::text,c.relname,c.relkind,c.relowner::text,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace='state_map_v1'::regnamespace ORDER BY c.oid`,
  `SELECT a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relnamespace='state_map_v1'::regnamespace AND a.attnum>0 ORDER BY a.attrelid,a.attnum`,
  `SELECT p.oid::text,p.proowner::text,p.proacl::text,pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.pronamespace='state_map_v1'::regnamespace ORDER BY p.oid`,
  `SELECT t.oid::text,t.tgrelid::text,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='state_map_v1'::regnamespace ORDER BY t.oid`,
  `SELECT e.oid::text,e.evtname,e.evtevent,e.evtenabled,e.evtfoid::text,e.evtowner::text,e.evttags FROM pg_event_trigger e WHERE evtname IN('state_map_ddl_start_v1','state_map_ddl_end_v1','state_map_sql_drop_v1') ORDER BY e.oid`,
  `SELECT n.oid::text,n.nspowner::text,n.nspacl::text FROM pg_namespace n WHERE n.nspname='state_map_v1'`,
  `SELECT c.oid::text,pg_get_constraintdef(c.oid) AS definition,c.convalidated FROM pg_constraint c WHERE c.connamespace='state_map_v1'::regnamespace ORDER BY c.oid`,
  `SELECT i.indexrelid::text,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='state_map_v1'::regnamespace ORDER BY i.indexrelid`,
  `SELECT r.oid::text,r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconfig FROM pg_roles r WHERE r.oid IN(SELECT proowner FROM pg_proc WHERE pronamespace='state_map_v1'::regnamespace) OR r.oid IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='state_map_v1') ORDER BY r.oid`,
  `SELECT oid::text,datname,datdba::text,datacl::text,datallowconn,datconnlimit,encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()`
 ];
 const rows=[];for(const sql of queries)rows.push((await client.query(sql)).rows);
 return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 }finally{await client.query("SELECT pg_catalog.set_config('search_path',$1,false)",[previous]);}
}
