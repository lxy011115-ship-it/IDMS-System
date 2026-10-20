import {canonical} from '../server/imports.ts';
import {quoteIdentifier as q} from '../server/postgres-schema.ts';
import {verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {verifyFieldModule} from '../server/field-schema-check.ts';
import {fieldTablePrivileges} from '../server/field-schema.ts';
import {sourceRuntimePrivileges} from './field-source-freeze-policy.mjs';
import {sourceSecurityFrame} from './field-source-freeze-security.mjs';
import {scanFieldSnapshotFacts} from './field-snapshot-facts.mjs';
import {memoryTask} from '../server/capacity.ts';
const fail=code=>{throw Object.assign(Error(code),{code});},same=(a,b)=>canonical(a)===canonical(b);

// Exact, deployment-only mapping. No business/audit/point/receipt is rewritten.
export async function rebindRestoredMigrationRoles(client,source,target,tenant){
 if(client.getTransactionStatus?.()!=='T')fail('FIELD_RESTORE_METADATA_TRANSACTION_REQUIRED');
 const context=(await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];
 if(context.database!==target.database||context.role!==target.ownerRole)fail('FIELD_RESTORE_METADATA_TARGET_MISMATCH');
 const base=(await client.query('SELECT * FROM public.idms_schema_migrations ORDER BY version')).rows,field=(await client.query('SELECT * FROM idms_field.migrations ORDER BY version')).rows;
 if(base.length!==5||field.length!==1||[...base,...field].some(r=>r.tenant_id!==tenant||r.owner_role!==source.ownerRole||r.app_role!==source.user||r.backup_role!==source.backupRole))fail('FIELD_RESTORE_SOURCE_MIGRATION_ROLES_CHANGED');
 const strip=r=>{const {owner_role,app_role,backup_role,...rest}=r;return Object.fromEntries(Object.entries(rest).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]));};
 const triggers=(await client.query("SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgrelid='idms_field.migrations'::regclass AND tgname='immutable_field_data' AND NOT tgisinternal")).rows;
 if(triggers.length!==1||!['O','A'].includes(triggers[0].enabled))fail('FIELD_RESTORE_MIGRATION_TRIGGER_CHANGED');
 await client.query(`ALTER TABLE idms_field.migrations DISABLE TRIGGER immutable_field_data`);
 try{
  for(const [table,expected]of [['public.idms_schema_migrations',base],['idms_field.migrations',field]]){
   const rows=(await client.query(`UPDATE ${table} SET owner_role=$1,app_role=$2,backup_role=$3 WHERE tenant_id=$4 AND owner_role=$5 AND app_role=$6 AND backup_role=$7 RETURNING *`,[target.ownerRole,target.user,target.backupRole,tenant,source.ownerRole,source.user,source.backupRole])).rows.sort((a,b)=>a.version-b.version);
   if(rows.length!==expected.length||!same(rows.map(strip),expected.map(strip))||rows.some(r=>r.owner_role!==target.ownerRole||r.app_role!==target.user||r.backup_role!==target.backupRole))fail('FIELD_RESTORE_MIGRATION_REBIND_UNCONFIRMED');
  }
 }finally{await client.query('ALTER TABLE idms_field.migrations ENABLE '+(triggers[0].enabled==='A'?'ALWAYS ':'')+'TRIGGER immutable_field_data');}
}

export async function grantRestoredFieldPolicy(client,a){
 if(client.getTransactionStatus?.()!=='T')fail('FIELD_RESTORE_METADATA_TRANSACTION_REQUIRED');
 const context=(await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];if(context.database!==a.database||context.role!==a.ownerRole)fail('FIELD_RESTORE_METADATA_TARGET_MISMATCH');
 const owner=q(a.ownerRole),app=q(a.user),backup=q(a.backupRole);
 await client.query(`REVOKE ALL ON SCHEMA idms_field FROM PUBLIC,${app},${backup};GRANT USAGE ON SCHEMA idms_field TO ${app},${backup};ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA idms_field REVOKE ALL ON TABLES FROM PUBLIC;ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA idms_field REVOKE ALL ON SEQUENCES FROM PUBLIC;ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA idms_field REVOKE ALL ON FUNCTIONS FROM PUBLIC`);
 for(const [table,privileges]of Object.entries(fieldTablePrivileges))await client.query(`REVOKE ALL ON TABLE idms_field.${q(table)} FROM PUBLIC,${app},${backup};GRANT ${privileges.join(',')} ON TABLE idms_field.${q(table)} TO ${app};GRANT SELECT ON TABLE idms_field.${q(table)} TO ${backup}`);
}

export async function validateUnreboundRestoredSchema(client,target,migrator,source,tenant){
 return memoryTask(async()=>{
  if(client.getTransactionStatus?.()!=='T')fail('FIELD_RESTORE_SNAPSHOT_REQUIRED');
  await sourceSecurityFrame(client,target,migrator,'FROZEN');
  await client.query('SAVEPOINT idms_restore_metadata_projection');
  try{
   await client.query(`SET LOCAL ROLE ${q(target.ownerRole)}`);await rebindRestoredMigrationRoles(client,source,target,tenant);
   for(const r of sourceRuntimePrivileges(target))await client.query(`GRANT ${r.privileges.join(',')} ON TABLE ${q(r.schema)}.${q(r.table)} TO ${q(target.user)}`);
   await client.query(`GRANT USAGE ON SEQUENCE public.audit_ledger_sequence_no_seq TO ${q(target.user)};SET LOCAL ROLE ${q(target.user)}`);
   await verifyDatabaseSecurity(client,target,tenant);await verifyFieldModule(client,target,tenant);
  }finally{await client.query('ROLLBACK TO SAVEPOINT idms_restore_metadata_projection');await client.query('RELEASE SAVEPOINT idms_restore_metadata_projection');}
  await sourceSecurityFrame(client,target,migrator,'FROZEN');
 },false);
}

export async function readUnreboundRestoredFacts(client,target,migrator,source,tenant,{sequenceClient}){
 return memoryTask(async()=>{await validateUnreboundRestoredSchema(client,target,migrator,source,tenant);return scanFieldSnapshotFacts(client,target,tenant,{sequenceClient});},true);
}

export function assertRawRestoredFacts(actual,expected,target){
 const {factsSha256:_a,sourceDatabase:database,sourceRoles:roles,...body}=actual,{factsSha256:_e,sourceDatabase:_database,sourceRoles:_roles,...source}=expected;
 if(database!==target.database||!same(roles,{owner:target.ownerRole,app:target.user,backup:target.backupRole})||!same(body,source))fail('FIELD_RESTORE_RAW_FACTS_MISMATCH');
 return true;
}
