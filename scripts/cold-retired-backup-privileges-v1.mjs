import pg from 'pg';
import {resolve,isAbsolute} from 'node:path';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const normal=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);

/** Caller retains the actual HELD root connection and read-only transaction. No backup login or business DML is attempted. */
export async function verifyColdRetiredBackupPrivilegesV1(client,raw){
  need(client instanceof pg.Client&&client.getTransactionStatus()==='T'&&exact(raw,['source','sourceHash','targetDirectory','databaseOid','roleOid'])&&typeof raw.targetDirectory==='string'&&isAbsolute(raw.targetDirectory),'COLD_RETIRED_BACKUP_SQL_CONTEXT');
  const {source,databaseOid,roleOid}=raw;
  need(hash(source)===raw.sourceHash&&source.retired.some(value=>value.source.databaseOid===databaseOid)&&source.inventory.roles.some(value=>value.oid===roleOid),'COLD_RETIRED_BACKUP_SOURCE');
  const settings=(await client.query("SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation")).rows[0];need(settings.readonly==='on'&&['repeatable read','serializable'].includes(settings.isolation),'COLD_RETIRED_BACKUP_SQL_READONLY');
  const identity=(await client.query("SELECT (pg_control_system()).system_identifier::text AS system_id,current_setting('data_directory') AS directory,session_user::regrole::oid::text AS control_oid,current_user::regrole::oid::text AS current_oid,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid")).rows[0];
  need(identity.system_id===source.inventory.identity.system_id&&identity.control_oid===source.inventory.identity.control_oid&&identity.current_oid===identity.control_oid&&identity.database_oid===databaseOid&&normal(identity.directory)===normal(raw.targetDirectory),'COLD_RETIRED_BACKUP_SQL_TARGET');
  const role=(await client.query('SELECT oid::text,rolcanlogin,rolconnlimit,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE oid=$1::oid',[roleOid])).rows[0];
  need(role&&!role.rolcanlogin&&role.rolconnlimit===0&&['rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls'].every(key=>role[key]===false),'COLD_RETIRED_BACKUP_ROLE_CLOSED');
  const global=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=$1::oid OR member=$1::oid) AS membership,has_database_privilege($1::oid,current_database(),'CREATE,TEMP') AS database_write,EXISTS(SELECT 1 FROM pg_namespace WHERE nspname!~'^pg_temp_' AND nspname!~'^pg_toast_temp_' AND has_schema_privilege($1::oid,oid,'CREATE')) AS schema_write,EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='pg_catalog'::regnamespace AND (proname LIKE 'lo\\_%' ESCAPE '\\' OR proname IN('lowrite','loread','loopen','loclose')) AND has_function_privilege($1::oid,oid,'EXECUTE')) AS large_object_access",[roleOid])).rows[0];
  need(Object.values(global).every(value=>value===false),'COLD_RETIRED_BACKUP_UNSAFE_CAPABILITY');
  const databases=(await client.query("SELECT oid::text,has_database_privilege($1::oid,oid,'CONNECT') AS connect FROM pg_database WHERE oid=ANY($2::oid[]) ORDER BY oid",[roleOid,source.inventory.databases.map(value=>value.oid)])).rows;
  need(databases.length===source.inventory.databases.length&&databases.every(value=>value.connect===(value.oid===databaseOid)),'COLD_RETIRED_BACKUP_DATABASE_ISOLATION');
  const relations=(await client.query("SELECT c.oid::text,c.relkind,c.relowner::text,has_table_privilege($1::oid,c.oid,'SELECT') AS readable,has_table_privilege($1::oid,c.oid,'SELECT WITH GRANT OPTION') AS grantable,has_table_privilege($1::oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable,has_any_column_privilege($1::oid,c.oid,'INSERT,UPDATE,REFERENCES') AS column_write FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f') ORDER BY c.oid",[roleOid])).rows;
  need(relations.length>0&&relations.every(value=>value.readable&&!value.grantable&&!value.writable&&!value.column_write&&value.relowner!==roleOid),'COLD_RETIRED_BACKUP_RELATION_PRIVILEGES');
  const unsafeSequence=(await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND c.relkind='S' AND (c.relowner=$1::oid OR has_sequence_privilege($1::oid,c.oid,'USAGE,UPDATE'))) AS value",[roleOid])).rows[0].value;
  need(unsafeSequence===false,'COLD_RETIRED_BACKUP_SEQUENCE_WRITE');
  return Object.freeze({format:'COLD_RETIRED_BACKUP_CURRENT_PRIVILEGES_V1',sourceHash:raw.sourceHash,databaseOid,roleOid,verifiedAt:new Date().toISOString(),relationsChecked:relations.length,registeredDatabasePrivilegesChecked:databases.length,currentRoleClosed:true,onlyOriginalDatabaseConnectAllowed:true,actualTableAndColumnWriteDenied:true,actualSequenceWriteDenied:true,largeObjectFunctionsDenied:true,currentBackupReadPrivilegesVerified:true,formalFieldActivationGranted:false,fullGoalComplete:false});
}
