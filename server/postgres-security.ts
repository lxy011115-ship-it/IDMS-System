import {verifyWorkerSchema} from './outbox-schema.ts';
import {verifyAnalysisSchema} from './analysis-schema-check.ts';
import {immutableEntityTables} from './entity-schema.ts';
import type pg from 'pg';
import {canonical} from './imports.ts';
import {migrationChecksum,migrationVersion,migrationHistoryValid,moduleTables,runtimeTablePrivileges as tablePrivileges,quoteIdentifier} from './postgres-schema.ts';

export interface DatabaseAccount {user:string;password:string;database:string}
export interface RuntimeAccount extends DatabaseAccount {ownerRole:string;backupRole:string;telemetry:boolean}
export interface RuntimeDatabaseConfig {format:1;purpose:'BUSINESS_RUNTIME';host:string;port:number;tenants:Record<string,RuntimeAccount>}
const keys=(value:object,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
export function validateRuntimeConfig(value:any):RuntimeDatabaseConfig{
  if(!value||value.format!==1||value.purpose!=='BUSINESS_RUNTIME'||!keys(value,['format','purpose','host','port','tenants'])||typeof value.host!=='string'||!Number.isInteger(value.port)||value.port<1||value.port>65535||!value.tenants||!Object.keys(value.tenants).length)throw Error('A dedicated BUSINESS_RUNTIME database configuration is required; deployment credentials are prohibited');
  const identities=new Set<string>(),databases=new Set<string>();
  for(const [id,a] of Object.entries(value.tenants) as [string,any][]){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!a||!keys(a,['user','password','database','ownerRole','backupRole','telemetry'])||[a.user,a.database,a.ownerRole,a.backupRole].some(x=>typeof x!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(x))||typeof a.password!=='string'||!a.password||typeof a.telemetry!=='boolean'||new Set([a.user,a.ownerRole,a.backupRole]).size!==3||databases.has(a.database))throw Error('Invalid independent runtime database binding');
    for(const role of [a.user,a.ownerRole,a.backupRole]){if(identities.has(role))throw Error('Database roles must not be shared between tenants');identities.add(role);}
    databases.add(a.database);
  }
  return value;
}
export function connectionFor(config:{host:string;port:number},a:DatabaseAccount){return {host:config.host,port:config.port,user:a.user,password:a.password,database:a.database,connectionTimeoutMillis:5000,statement_timeout:15000};}

export async function verifyDatabaseSecurity(client:pg.PoolClient,a:RuntimeAccount,tenantId:string){
  const role=(await client.query(`SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if(role?.name!==a.user||role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolbypassrls||role.rolreplication||role.rolinherit)throw Error('Unsafe application database role');
  if((await client.query(`SELECT 1 FROM pg_roles WHERE rolname<>current_user AND pg_has_role(current_user,oid,'MEMBER') LIMIT 1`)).rowCount)throw Error('Application role membership is prohibited');
  const db=(await client.query(`SELECT pg_get_userbyid(datdba) AS owner,has_database_privilege(current_user,oid,'CREATE') AS create_db,has_database_privilege(current_user,oid,'TEMP') AS temp FROM pg_database WHERE datname=current_database()`)).rows[0];
  const schema=(await client.query(`SELECT pg_get_userbyid(nspowner) AS owner,has_schema_privilege(current_user,oid,'CREATE') AS create_schema FROM pg_namespace WHERE nspname='public'`)).rows[0];
  if(db?.owner!==a.ownerRole||db.create_db||db.temp||schema?.owner!==a.ownerRole||schema.create_schema)throw Error('Application must not own or create database/schema objects');
  const namespaces=(await client.query(`SELECT 1 FROM pg_namespace WHERE nspname!~'^pg_' AND nspname<>'information_schema' AND has_schema_privilege(current_user,oid,'CREATE') LIMIT 1`)).rowCount;
  if(namespaces)throw Error('Application has an unexpected writable schema');
  const publicGrant=(await client.query(`SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x WHERE d.datname=current_database() AND x.grantee=0 UNION ALL SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) x WHERE n.nspname='public' AND x.grantee=0 AND x.privilege_type='CREATE'`)).rowCount;
  if(publicGrant)throw Error('Unexpected PUBLIC database/schema privileges');
  const owners=(await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,rolinherit FROM pg_roles WHERE rolname=ANY($1::text[])`,[[a.ownerRole,a.backupRole]])).rows;
  if(owners.length!==2||owners.find(r=>r.rolname===a.ownerRole)?.rolcanlogin||!owners.find(r=>r.rolname===a.backupRole)?.rolcanlogin||owners.some(r=>r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolbypassrls||r.rolreplication||r.rolinherit))throw Error('Invalid database owner or backup role');
  if((await client.query(`SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))`,[[a.ownerRole,a.backupRole]])).rowCount)throw Error('Owner and backup role membership is prohibited');
  if((await client.query(`SELECT 1 FROM pg_database WHERE datname=current_database() AND (has_database_privilege($1,oid,'CREATE') OR has_database_privilege($1,oid,'TEMP')) UNION ALL SELECT 1 FROM pg_namespace WHERE nspname!~'^pg_' AND nspname<>'information_schema' AND has_schema_privilege($1,oid,'CREATE')`,[a.backupRole])).rowCount)throw Error('Backup role must not create database objects');
  const defaults=(await client.query(`SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$1) AND d.defaclnamespace IN (0,'public'::regnamespace) AND x.grantee<>d.defaclrole UNION ALL SELECT 1 FROM aclexplode(COALESCE((SELECT defaclacl FROM pg_default_acl WHERE defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$1) AND defaclnamespace=0 AND defaclobjtype='f'),acldefault('f',(SELECT oid FROM pg_roles WHERE rolname=$1)))) x WHERE x.grantee=0`,[a.ownerRole])).rowCount;
  if(defaults)throw Error('Unexpected owner default privileges');
  const tables=(await client.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v') ORDER BY c.relname`)).rows;
  if(canonical(tables.map(r=>r.relname))!==canonical(moduleTables(a.telemetry))||tables.some(t=>t.owner!==a.ownerRole))throw Error('Unexpected tables or table ownership; explicit migration required');
  for(const table of tables){
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']){
      const permission=(await client.query('SELECT has_table_privilege(current_user,$1::oid,$2) AS allowed,has_table_privilege(current_user,$1::oid,$3) AS grantable',[table.oid,privilege,privilege+' WITH GRANT OPTION'])).rows[0];
      if(permission.allowed!==tablePrivileges[table.relname].includes(privilege)||permission.grantable)throw Error('Application table privileges differ from minimum policy: '+table.relname);
      const backup=(await client.query('SELECT has_table_privilege($1,$2::oid,$3) AS allowed,has_table_privilege($1,$2::oid,$4) AS grantable',[a.backupRole,table.oid,privilege,privilege+' WITH GRANT OPTION'])).rows[0];
      if(backup.allowed!==(privilege==='SELECT')||backup.grantable)throw Error('Backup table privileges differ from read-only policy');
      if(['INSERT','UPDATE','REFERENCES'].includes(privilege)&&(await client.query('SELECT has_any_column_privilege($1,$2::oid,$3) AS allowed',[a.backupRole,table.oid,privilege])).rows[0].allowed)throw Error('Unexpected backup column privilege');
      if(!permission.allowed&&(await client.query('SELECT has_any_column_privilege(current_user,$1::oid,$2) AS allowed',[table.oid,privilege==='SELECT'||privilege==='INSERT'||privilege==='UPDATE'||privilege==='REFERENCES'?privilege:'SELECT'])).rows[0].allowed&&['SELECT','INSERT','UPDATE','REFERENCES'].includes(privilege))throw Error('Unexpected application column privilege');
    }
  }
  const seq=(await client.query(`SELECT c.oid,c.relname,pg_get_userbyid(c.relowner) AS owner,has_sequence_privilege(current_user,c.oid,'USAGE') AS usage,has_sequence_privilege(current_user,c.oid,'SELECT') AS read,has_sequence_privilege(current_user,c.oid,'UPDATE') AS change FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'`)).rows;
  if(seq.length!==1||seq[0].relname!=='audit_ledger_sequence_no_seq'||seq[0].owner!==a.ownerRole||!seq[0].usage||seq[0].read||seq[0].change)throw Error('Unsafe application sequence privileges');
  const backupSequence=(await client.query("SELECT has_sequence_privilege($1,$2::oid,'SELECT') AS read,has_sequence_privilege($1,$2::oid,'USAGE') AS usage,has_sequence_privilege($1,$2::oid,'UPDATE') AS change",[a.backupRole,seq[0].oid])).rows[0];
  if(!backupSequence.read||backupSequence.usage||backupSequence.change)throw Error('Unsafe backup sequence privileges');
  const funcs=(await client.query(`SELECT p.oid,p.proname,p.pronargs,p.prosrc,p.prorettype='trigger'::regtype AS trigger_return,l.lanname,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,has_function_privilege(current_user,p.oid,'EXECUTE') AS callable,has_function_privilege($1,p.oid,'EXECUTE') AS backup_callable FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public'`,[a.backupRole])).rows;
  const bodies:Record<string,string>={reject_audit_mutation:"BEGIN RAISE EXCEPTION 'audit ledger is append-only'; END",reject_managed_data_mutation:"BEGIN RAISE EXCEPTION 'approved managed data is append-only'; END"};
  if(funcs.length!==2||funcs.some(f=>f.owner!==a.ownerRole||f.prosecdef||f.callable||f.backup_callable||f.pronargs!==0||!f.trigger_return||f.lanname!=='plpgsql'||bodies[f.proname]!==f.prosrc.trim()))throw Error('Unsafe public function ownership, body or execution privileges');
  const triggers=(await client.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgfoid,t.tgqual FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal`)).rows;
  for(const name of ['audit_ledger','managed_import_rows','managed_assets','managed_point_definitions','managed_measurements','managed_record_revisions','registry_history','analysis_report_events',...immutableEntityTables])if(!triggers.some(t=>t.relname===name&&t.tgname===(name==='audit_ledger'?'immutable_audit':'immutable_managed_data')&&['O','A'].includes(t.tgenabled)&&t.tgtype===58&&t.tgqual===null&&t.tgfoid===funcs.find(f=>f.proname===(name==='audit_ledger'?'reject_audit_mutation':'reject_managed_data_mutation'))?.oid))throw Error('Append-only protection is missing, changed or disabled');
  const versions=(await client.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
  if(!migrationHistoryValid(versions,a,tenantId))throw Error('Database migration version, checksum or role binding does not match');
  await verifyWorkerSchema(client);
  await verifyAnalysisSchema(client);
}

export async function verifyModule(client:pg.Pool|pg.PoolClient,table:string){
  if(!Object.hasOwn(tablePrivileges,table))throw Error('Unknown database module');
  await client.query(`SELECT 1 FROM public.${quoteIdentifier(table)} LIMIT 0`);
}

