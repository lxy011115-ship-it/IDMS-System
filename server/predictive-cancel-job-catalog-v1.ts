import {createHash} from 'node:crypto';
import type {Client} from 'pg';
/** Exact external witness; a mismatch never becomes a new baseline at runtime. */
export async function inspectPredictiveCancelJobCatalogV1(c:Pick<Client,'query'>){
 const previous=(await c.query("SELECT current_setting('search_path') AS path")).rows[0].path;await c.query("SELECT set_config('search_path','pg_catalog,pg_temp',false)");
 try{
  const scope="'reconciliation_jobs_v1'::regnamespace",queries=[
   "SELECT oid::text,nspowner::text,nspacl::text FROM pg_namespace WHERE nspname='reconciliation_jobs_v1'",
   `SELECT oid::text,relname,relkind,relowner::text,relacl::text,relrowsecurity,relforcerowsecurity,relpersistence,reloptions FROM pg_class WHERE relnamespace=${scope} ORDER BY oid`,
   `SELECT a.attrelid::text,a.attnum,a.attname,a.atttypid::text,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attacl::text,pg_get_expr(d.adbin,d.adrelid) AS default_expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace=${scope} AND a.attnum>0 ORDER BY a.attrelid,a.attnum`,
   `SELECT oid::text,proowner::text,proacl::text,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace=${scope} ORDER BY oid`,
   `SELECT t.oid::text,t.tgrelid::text,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=${scope} ORDER BY t.oid`,
   `SELECT oid::text,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=${scope} ORDER BY oid`,
   `SELECT i.indexrelid::text,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace=${scope} ORDER BY i.indexrelid`,
   `SELECT r.oid::text,pg_get_ruledef(r.oid) AS definition FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relnamespace=${scope} ORDER BY r.oid`,
   "SELECT oid::text,evtname,evtevent,evtenabled,evtfoid::text,evtowner::text,evttags FROM pg_event_trigger WHERE evtname IN('recon_queue_ddl_start_v1','recon_queue_ddl_end_v1','recon_queue_sql_drop_v1') ORDER BY oid",
   `SELECT r.oid::text,r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil::text,r.rolconfig FROM pg_roles r WHERE r.oid IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.oid=${scope}) ORDER BY r.oid`,
   `SELECT m.roleid::text,m.member::text,m.grantor::text,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m WHERE m.roleid IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.oid=${scope}) OR m.member IN(SELECT a.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.oid=${scope}) ORDER BY m.roleid,m.member`,
   "SELECT oid::text,datname,datdba::text,datacl::text,datallowconn,datconnlimit,encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()"
  ],rows=[];
  for(const sql of queries)rows.push((await c.query(sql)).rows);return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 }finally{await c.query("SELECT set_config('search_path',$1,false)",[previous]);}
}
