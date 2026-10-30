import {readFile} from 'node:fs/promises';
export const fenceIdentV1=v=>{if(typeof v!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(v))throw Error('RUNTIME_FENCE_IDENTIFIER');return '"'+v+'"';};
const lit=v=>"'"+v.replaceAll("'","''")+"'";
export async function runtimeWriteFenceSchemaSqlV1({owner,control,deployment}){
 if(!/^[a-f0-9-]{36}$/.test(deployment)||owner===control)throw Error('RUNTIME_FENCE_CONFIG');
 let sql=await readFile(new URL('./runtime-write-fence-v1.sql',import.meta.url),'utf8');
 for(const [k,v] of Object.entries({OWNER:fenceIdentV1(owner),OWNER_LITERAL:lit(owner),CONTROL_LITERAL:lit(control),DEPLOYMENT:lit(deployment)}))sql=sql.replaceAll('__'+k+'__',v);
 if(/__[A-Z_]+__/.test(sql))throw Error('RUNTIME_FENCE_TEMPLATE');return sql;
}
/** Fresh provisioning only. Never append these triggers to an accepted live catalog. */
export function runtimeWriteFenceAttachSqlV1(schema){fenceIdentV1(schema);if(schema==='runtime_write_fence_v1'||schema.startsWith('pg_'))throw Error('RUNTIME_FENCE_SCHEMA');return `DO $fence$ DECLARE s runtime_write_fence_v1._state;r record;BEGIN
 SELECT * INTO STRICT s FROM runtime_write_fence_v1._state;
 IF session_user::regrole::oid<>s.control_oid OR s.finalized THEN RAISE EXCEPTION 'RUNTIME_FENCE_PROVISION_ONLY';END IF;
 FOR r IN SELECT c.oid,c.relname,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${lit(schema)} AND c.relkind='r' ORDER BY c.oid LOOP
 INSERT INTO runtime_write_fence_v1._relations VALUES(r.oid,${lit(schema)},r.relname,r.relowner);
 EXECUTE format('CREATE TRIGGER runtime_fence_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION runtime_write_fence_v1._write_guard()',${lit(schema)},r.relname);
 EXECUTE format('ALTER TABLE %I.%I ENABLE ALWAYS TRIGGER runtime_fence_write',${lit(schema)},r.relname);
 END LOOP;END $fence$;`;}
export function wrapFreshRuntimeWriteFenceSqlV1(sql,{schema,beforeEventTrigger}){
 fenceIdentV1(beforeEventTrigger);const marker='CREATE EVENT TRIGGER '+beforeEventTrigger;
 if(sql.split(marker).length!==2)throw Error('RUNTIME_FENCE_FRESH_BOUNDARY');
 return sql.replace(marker,'RESET ROLE;\n'+runtimeWriteFenceAttachSqlV1(schema)+'\n'+marker);
}
/** Large-object and sequence writes have no ordinary-table trigger. Restrict first. */
export async function restrictRuntimeWriteFenceActorsV1(c,actors){
 if(!Array.isArray(actors)||!actors.length||new Set(actors).size!==actors.length)throw Error('RUNTIME_FENCE_ACTORS');actors.forEach(fenceIdentV1);
 const s=(await c.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0];
 if(!s||s.finalized||(await c.query('SELECT session_user::regrole::oid AS id')).rows[0].id!==s.control_oid)throw Error('RUNTIME_FENCE_PROVISION_ONLY');
 const functions=(await c.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace='pg_catalog'::regnamespace AND (proname LIKE 'lo\\_%' ESCAPE '\\' OR proname IN('lowrite','loread','loopen','loclose','lo_creat','lo_create','lo_unlink')) ORDER BY oid")).rows;
 for(const f of functions)await c.query('REVOKE EXECUTE ON FUNCTION '+f.signature+' FROM PUBLIC,'+actors.map(fenceIdentV1).join(','));
 for(const actor of actors)await c.query('INSERT INTO runtime_write_fence_v1._actors VALUES($1::regrole::oid)',[actor]);
}
