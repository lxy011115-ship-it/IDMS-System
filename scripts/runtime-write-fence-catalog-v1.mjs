import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
const need=(v,m)=>{if(!v)throw Error(m);};
/** Control connection required. Pin excludes mutable gate state and table contents. */
export async function inspectRuntimeWriteFenceCatalogV1(c){
 const previous=(await c.query("SELECT current_setting('search_path') AS path")).rows[0].path;
 await c.query("SELECT set_config('search_path','pg_catalog,pg_temp',false)");
 try{
 const state=(await c.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0];need(state,'RUNTIME_FENCE_MISSING');
 const identity=(await c.query("SELECT (pg_control_system()).system_identifier::text AS system_id,(SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid,current_database() AS database,session_user::regrole::oid AS control_oid,current_setting('max_prepared_transactions')::int AS prepared_max,pg_is_in_recovery() AS recovery")).rows[0];
 need(identity.database_oid===state.database_oid&&identity.control_oid===state.control_oid&&!identity.recovery&&identity.prepared_max===0,'RUNTIME_FENCE_DATABASE');
 need((await c.query('SELECT count(*)::int AS n FROM pg_prepared_xacts')).rows[0].n===0,'RUNTIME_FENCE_PREPARED');
 const owner=(await c.query('SELECT * FROM pg_roles WHERE oid=$1',[state.owner_oid])).rows[0];need(owner&&!owner.rolcanlogin&&!owner.rolsuper&&!owner.rolcreaterole&&!owner.rolcreatedb&&!owner.rolreplication&&!owner.rolbypassrls,'RUNTIME_FENCE_OWNER');
 const actors=(await c.query('SELECT a.role_oid,r.* FROM runtime_write_fence_v1._actors a LEFT JOIN pg_roles r ON r.oid=a.role_oid ORDER BY a.role_oid')).rows;need(actors.length>0,'RUNTIME_FENCE_ACTORS');
 for(const a of actors){need(a.oid&&a.rolcanlogin&&!a.rolsuper&&!a.rolinherit&&!a.rolcreatedb&&!a.rolcreaterole&&!a.rolreplication&&!a.rolbypassrls&&a.oid!==state.control_oid&&a.oid!==state.owner_oid,'RUNTIME_FENCE_ROLE');
  need(!(await c.query("SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1) OR has_parameter_privilege($1::oid,'session_replication_role','SET') OR has_database_privilege($1::oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege($1::oid,oid,'CREATE') AND nspname!~'^pg_temp_' AND nspname!~'^pg_toast_temp_') OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=$1 AND relnamespace NOT IN(SELECT oid FROM pg_namespace WHERE nspname~'^pg_temp_' OR nspname~'^pg_toast_temp_')) OR EXISTS(SELECT 1 FROM pg_class WHERE relkind='S' AND (has_sequence_privilege($1::oid,oid,'USAGE') OR has_sequence_privilege($1::oid,oid,'UPDATE'))) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='pg_catalog'::regnamespace AND (proname LIKE 'lo\\_%' ESCAPE '\\' OR proname IN('lowrite','loread','loopen','loclose')) AND has_function_privilege($1::oid,oid,'EXECUTE')) AS unsafe",[a.oid])).rows[0].unsafe,'RUNTIME_FENCE_BYPASS_CAPABILITY');
 }
 const rows=[];
 const tables=(await c.query("SELECT c.oid,c.relname,c.relkind,c.relowner,c.relrowsecurity,c.relforcerowsecurity,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND n.nspname<>'runtime_write_fence_v1' AND c.relkind IN('r','p','f','m') ORDER BY c.oid")).rows;
 const registered=(await c.query('SELECT * FROM runtime_write_fence_v1._relations ORDER BY relation_oid')).rows;need(tables.length>0&&tables.length===registered.length,'RUNTIME_FENCE_COVERAGE');
 for(const t of tables){const r=registered.find(x=>x.relation_oid===t.oid);need(t.relkind==='r'&&r&&r.schema_name===t.nspname&&r.table_name===t.relname&&r.owner_oid===t.relowner&&!actors.some(a=>a.oid===t.relowner),'RUNTIME_FENCE_COVERAGE');
  const triggers=(await c.query("SELECT tgenabled,tgtype,tgfoid::text,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid=$1 AND tgname='runtime_fence_write'",[t.oid])).rows;
  need(triggers.length===1&&triggers[0].tgenabled==='A'&&triggers[0].tgtype===62&&triggers[0].definition.includes('runtime_write_fence_v1._write_guard()'),'RUNTIME_FENCE_TRIGGER');
 }
 const events=(await c.query("SELECT evtname,evtenabled,evtfoid::regprocedure::text AS fn FROM pg_event_trigger WHERE evtname IN('runtime_fence_ddl_start_v1','runtime_fence_ddl_end_v1') ORDER BY evtname")).rows;need(events.length===2&&events.every(x=>x.evtenabled==='A'&&x.fn.startsWith('runtime_write_fence_v1._ddl_')),'RUNTIME_FENCE_EVENT_TRIGGER');
 const queries=[
  "SELECT n.oid,n.nspname,n.nspowner,n.nspacl::text FROM pg_namespace n WHERE nspname!~'^pg_' AND nspname<>'information_schema' ORDER BY oid",
  "SELECT c.oid,c.relname,c.relnamespace,c.relkind,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' ORDER BY c.oid",
  "SELECT a.attrelid,a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND a.attnum>0 ORDER BY a.attrelid,a.attnum",
  "SELECT p.oid,p.proowner,p.proacl::text,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND p.prokind IN('f','p') ORDER BY p.oid",
  "SELECT t.oid,t.tgrelid,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' ORDER BY t.oid",
  "SELECT oid,evtname,evtevent,evtenabled,evtfoid,evtowner,evttags FROM pg_event_trigger ORDER BY oid",
  "SELECT c.oid,pg_get_constraintdef(c.oid) AS definition,c.convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' ORDER BY c.oid",
  "SELECT i.indexrelid,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' ORDER BY i.indexrelid",
  "SELECT oid,datname,datdba,datacl::text,datallowconn,datconnlimit,encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()",
  "SELECT p.oid,p.proacl::text FROM pg_proc p WHERE pronamespace='pg_catalog'::regnamespace AND (proname LIKE 'lo\\_%' ESCAPE '\\' OR proname IN('lowrite','loread','loopen','loclose')) ORDER BY oid"
 ];for(const sql of queries)rows.push((await c.query(sql)).rows);
 // pg_roles masks passwords; never collect pg_authid or data rows here.
 rows.push(actors,owner,registered,identity);
 return{state,identity,actorOids:actors.map(a=>String(a.oid)),tableCount:tables.length,catalogHash:createHash('sha256').update(canonical(rows)).digest('hex')};
 }finally{await c.query("SELECT set_config('search_path',$1,false)",[previous]);}
}
