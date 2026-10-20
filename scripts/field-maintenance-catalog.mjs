import pg from 'pg';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
const fail=code=>{throw Object.assign(Error(code),{code});};
const schemas="SELECT oid FROM pg_namespace WHERE nspname IN ('public','idms_field')",classes='SELECT oid FROM pg_class WHERE relnamespace IN ('+schemas+')';
// Fixed catalog statements only. Volatile estimates, transaction horizons and
// physical relation storage are excluded; semantic flags and all DDL stay in.
const queries=Object.freeze({
 namespaces:"SELECT to_jsonb(n)::text AS record FROM pg_namespace n WHERE n.oid IN ("+schemas+")",
 relations:"SELECT jsonb_build_object('oid',c.oid,'name',c.relname,'namespace',c.relnamespace,'type',c.reltype,'owner',c.relowner,'am',c.relam,'kind',c.relkind,'persistence',c.relpersistence,'options',c.reloptions,'acl',c.relacl,'rowSecurity',c.relrowsecurity,'forceRowSecurity',c.relforcerowsecurity,'replicaIdentity',c.relreplident,'partition',c.relispartition,'partitionBound',c.relpartbound,'toast',c.reltoastrelid)::text AS record FROM pg_class c WHERE c.oid IN ("+classes+")",
 attributes:'SELECT to_jsonb(a)::text AS record FROM pg_attribute a WHERE a.attrelid IN ('+classes+')',
 defaults:'SELECT to_jsonb(d)::text AS record FROM pg_attrdef d WHERE d.adrelid IN ('+classes+')',
 constraints:'SELECT to_jsonb(c)::text AS record FROM pg_constraint c WHERE c.connamespace IN ('+schemas+') OR c.conrelid IN ('+classes+')',
 indexes:'SELECT to_jsonb(i)::text AS record FROM pg_index i WHERE i.indrelid IN ('+classes+')',
 triggers:'SELECT to_jsonb(t)::text AS record FROM pg_trigger t WHERE t.tgrelid IN ('+classes+')',
 rules:'SELECT to_jsonb(r)::text AS record FROM pg_rewrite r WHERE r.ev_class IN ('+classes+')',
 functions:'SELECT to_jsonb(p)::text AS record FROM pg_proc p',
 types:'SELECT to_jsonb(t)::text AS record FROM pg_type t WHERE t.typnamespace IN ('+schemas+')',
 enums:'SELECT to_jsonb(e)::text AS record FROM pg_enum e WHERE e.enumtypid IN (SELECT oid FROM pg_type WHERE typnamespace IN ('+schemas+'))',
 ranges:'SELECT to_jsonb(r)::text AS record FROM pg_range r WHERE r.rngtypid IN (SELECT oid FROM pg_type WHERE typnamespace IN ('+schemas+'))',
 defaultAcls:'SELECT to_jsonb(a)::text AS record FROM pg_default_acl a',
 dependencies:'SELECT to_jsonb(d)::text AS record FROM pg_depend d',
 sharedDependencies:"SELECT to_jsonb(d)::text AS record FROM pg_shdepend d WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) OR d.dbid=0 AND d.classid='pg_database'::regclass AND d.objid=(SELECT oid FROM pg_database WHERE datname=current_database()) OR d.refclassid='pg_authid'::regclass AND d.refobjid=ANY($1::oid[])",
 settings:'SELECT to_jsonb(s)::text AS record FROM pg_db_role_setting s WHERE s.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) OR s.setdatabase=0 AND s.setrole=ANY($1::oid[])',
 roles:'SELECT to_jsonb(r)::text AS record FROM pg_roles r WHERE r.oid=ANY($1::oid[])',
 securityLabels:'SELECT to_jsonb(s)::text AS record FROM pg_seclabel s',
 database:"SELECT jsonb_build_object('oid',d.oid,'name',d.datname,'owner',d.datdba,'allow',d.datallowconn,'template',d.datistemplate,'limit',d.datconnlimit,'acl',d.datacl)::text AS record FROM pg_database d WHERE d.datname=current_database()"
});
async function hashRows(client,sql,values){
 const hash=createHash('sha256');let rows=0,bytes=0,problem;
 await new Promise((ok,no)=>{const query=client.query(new pg.Query({text:'SELECT record FROM ('+sql+') records ORDER BY record COLLATE "C"',values}));
  query.on('row',r=>{if(problem)return;if(typeof r.record!=='string'||Buffer.byteLength(r.record)>1048576||rows>=200000){problem=Object.assign(Error('FIELD_MAINTENANCE_CATALOG_LIMIT'),{code:'FIELD_MAINTENANCE_CATALOG_LIMIT'});return;}const text=r.record+'\n';hash.update(text);rows++;bytes+=Buffer.byteLength(text);if(bytes>64*1024**2)problem=Object.assign(Error('FIELD_MAINTENANCE_CATALOG_LIMIT'),{code:'FIELD_MAINTENANCE_CATALOG_LIMIT'});});query.once('error',no);query.once('end',()=>problem?no(problem):ok());
 });return {rows,bytes,sha256:hash.digest('hex')};
}
export async function readFieldMaintenanceCatalog(client,account,roleOids){
 if(client.getTransactionStatus?.()!=='T')fail('FIELD_MAINTENANCE_READONLY_REQUIRED');
 const settings=(await client.query("SELECT current_user AS role,current_database() AS database,current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0];
 if(settings.role!==account.backupRole||settings.database!==account.database||settings.readonly!=='on'||settings.isolation!=='repeatable read'||!Array.isArray(roleOids)||roleOids.length!==4||roleOids.some(x=>typeof x!=='string'||!/^[1-9][0-9]{0,9}$/.test(x)))fail('FIELD_MAINTENANCE_READONLY_REQUIRED');
 const unsupported=(await client.query("SELECT 1 FROM pg_extension WHERE extname<>'plpgsql' UNION ALL SELECT 1 FROM pg_event_trigger UNION ALL SELECT 1 FROM pg_foreign_server UNION ALL SELECT 1 FROM pg_foreign_data_wrapper UNION ALL SELECT 1 FROM pg_largeobject_metadata UNION ALL SELECT 1 FROM pg_publication UNION ALL SELECT 1 FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database()) UNION ALL SELECT 1 FROM pg_replication_slots WHERE database=current_database() UNION ALL SELECT 1 FROM pg_prepared_xacts WHERE database=current_database() LIMIT 1")).rowCount;
 if(unsupported)fail('FIELD_MAINTENANCE_GLOBALS_UNSUPPORTED');
 const catalogs={};for(const [name,sql]of Object.entries(queries))catalogs[name]=await hashRows(client,sql,sql.includes('$1')?[roleOids]:[]);
 const value={format:'idms-field-maintenance-catalog-v1',catalogs};return {...value,sha256:createHash('sha256').update(canonical(value)).digest('hex')};
}
