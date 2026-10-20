import {registryHistorySchema,reportEventsSchema} from '../server/registry-history-schema.ts';
import {initializeEntities} from './normalized-migration.mjs';
import {workerClaimSchema,verifyWorkerSchema} from '../server/outbox-schema.ts';
import {verifyEquipmentCatalog} from '../server/equipment-profiles.ts';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {businessSchema,workflowSchema,aiSchema,telemetrySchema,migrationTableSchema,migrationVersion,latestMigrationChecksum,migrationChecksum,normalizedMigrationChecksum,revisionMigrationChecksum,legacyMigrationChecksum,migrationHistoryValid,moduleTables,runtimeTablePrivileges as tablePrivileges,quoteIdentifier as q} from '../server/postgres-schema.ts';
import {initializeDataProjection,verifyDataProjection} from '../server/data-projection.ts';
import {initializeRevisionProjection} from '../server/revision-projection.ts';
import {verifyDatabaseSecurity,connectionFor,validateRuntimeConfig} from '../server/postgres-security.ts';
import {canonical} from '../server/imports.ts';
import {verifyAuditChain} from '../server/audit.ts';
import {verifyBatchMapping} from '../server/catalog.ts';

const id=value=>{if(typeof value!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(value))throw Error('Invalid database migration identifier');return value;};
export function roleLayout(account){
  const prefix=id(account.user).replace(/_app$/,'');
  if(prefix.length>51)throw Error('Database role prefix is too long');
  return {owner:prefix+'_owner',migrator:{user:prefix+'_migrator',password:randomBytes(32).toString('base64url'),database:account.database},backup:{user:prefix+'_backup',password:randomBytes(32).toString('base64url'),database:account.database}};
}
export function businessRuntime(config){
  return validateRuntimeConfig({format:1,purpose:'BUSINESS_RUNTIME',host:config.host,port:config.port,tenants:Object.fromEntries(Object.entries(config.tenants).map(([tenant,a])=>{
    const r=config.businessRoles?.[tenant];if(!r)throw Error('Missing deployment role layout');
    return [tenant,{user:a.user,password:a.password,database:a.database,ownerRole:r.owner,backupRole:r.backup.user,telemetry:r.telemetry===true}];
  }))});
}
export function backupRuntime(config){return {format:1,purpose:'BUSINESS_BACKUP',host:config.host,port:config.port,tenants:Object.fromEntries(Object.entries(config.tenants).map(([tenant,a])=>{const r=config.businessRoles[tenant];return [tenant,{user:r.backup.user,password:r.backup.password,database:a.database}];}))};}
export function migrationRuntime(config){return {format:1,purpose:'BUSINESS_MIGRATION',host:config.host,port:config.port,tenants:Object.fromEntries(Object.keys(config.tenants).map(tenant=>{const r=config.businessRoles[tenant];return [tenant,{user:r.migrator.user,password:r.migrator.password,database:r.migrator.database,ownerRole:r.owner}];}))};}
export function tenantSeed(snapshot,tenantId){
  return JSON.parse(JSON.stringify({business:Object.fromEntries(Object.entries(snapshot.business).map(([key,items])=>[key,items.filter(item=>key==='tenants'?item.id===tenantId:item.tenantId===tenantId)])),imports:{batches:snapshot.imports.batches.filter(b=>b.tenantId===tenantId),records:snapshot.imports.records.filter(r=>r.tenantId===tenantId),requests:snapshot.imports.requests.filter(r=>r.key.startsWith(tenantId+':'))},audits:snapshot.audits.filter(e=>e.tenantId===tenantId),idempotency:snapshot.idempotency.filter(([key])=>key.startsWith(tenantId+':'))}));
}
export function verifyPayload(payload,tenantId){
  if(!payload?.business||!Array.isArray(payload.audits)||!Array.isArray(payload.idempotency)||!payload.imports||!verifyAuditChain(payload.audits,tenantId)||payload.audits.some(e=>e.tenantId!==tenantId))throw Error('Invalid audited tenant snapshot');
  for(const [key,items]of Object.entries(payload.business))if(!Array.isArray(items)||items.some(item=>key==='tenants'?item.id!==tenantId:item.tenantId!==tenantId))throw Error('Cross-tenant business snapshot');
  for(const key of ['batches','records'])if(!Array.isArray(payload.imports[key])||payload.imports[key].some(r=>r.tenantId!==tenantId))throw Error('Cross-tenant imports');
  if(!Array.isArray(payload.imports.requests)||payload.imports.requests.some(r=>!r.key.startsWith(tenantId+':'))||payload.idempotency.some(([key])=>!key.startsWith(tenantId+':')))throw Error('Cross-tenant request history');
  const store={...payload.business,audits:payload.audits,idempotency:new Map(payload.idempotency)};
  verifyEquipmentCatalog(store);for(const batch of payload.imports.batches)verifyBatchMapping(store,batch);
}
async function role(admin,name,password,login){
  id(name);if(password!==undefined&&!/^[\w-]{32,}$/.test(password))throw Error('Invalid migration credential');
  const exists=(await admin.query('SELECT * FROM pg_roles WHERE rolname=$1',[name])).rows[0];
  if(!exists)await admin.query(`CREATE ROLE ${q(name)} ${login?'LOGIN PASSWORD '+"'"+password+"'":'NOLOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION`);
  else if(exists.rolcanlogin!==login||exists.rolsuper||exists.rolcreatedb||exists.rolcreaterole||exists.rolbypassrls||exists.rolreplication||exists.rolinherit)throw Error('Unexpected preexisting database role capabilities');
}
export async function grantPolicy(client,runtime){
  const app=q(runtime.user),backup=q(runtime.backupRole),owner=q(runtime.ownerRole);
  await client.query(`REVOKE ALL ON DATABASE ${q(runtime.database)} FROM PUBLIC,${app},${backup}; GRANT CONNECT ON DATABASE ${q(runtime.database)} TO ${app},${backup}; REVOKE ALL ON SCHEMA public FROM PUBLIC,${app},${backup}; GRANT USAGE ON SCHEMA public TO ${app},${backup}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  for(const table of moduleTables(runtime.telemetry))await client.query(`REVOKE ALL ON TABLE public.${q(table)} FROM PUBLIC,${app},${backup}; GRANT ${tablePrivileges[table].join(',')} ON TABLE public.${q(table)} TO ${app}; GRANT SELECT ON TABLE public.${q(table)} TO ${backup}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,${app},${backup}; GRANT USAGE ON SEQUENCE audit_ledger_sequence_no_seq TO ${app}; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${backup}; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,${app},${backup}`);
}
export async function migrateTenant(config,tenantId,seed){
  const a=config.tenants[tenantId],layout=config.businessRoles[tenantId],runtime=businessRuntime(config).tenants[tenantId];
  for(const name of [a.user,a.database,layout.owner,layout.migrator.user,layout.backup.user])id(name);
  if(layout.migrator.database!==a.database||layout.backup.database!==a.database)throw Error('Migration role database mismatch');
  const admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:a.database,connectionTimeoutMillis:5000});
  let migrator,check;
  await admin.connect();
  try{
    await admin.query("SELECT pg_advisory_lock(hashtext('idms-role-deployment-v1'))");
    if((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND pid<>pg_backend_pid()',[a.user])).rowCount)throw Error('Stop application database sessions before migrating');
    await admin.query('BEGIN');
    try{
      await role(admin,layout.owner,undefined,false);await role(admin,layout.migrator.user,layout.migrator.password,true);await role(admin,layout.backup.user,layout.backup.password,true);await role(admin,a.user,a.password,true);
      const memberships=(await admin.query(`SELECT pg_get_userbyid(member) AS member,pg_get_userbyid(roleid) AS role,admin_option,inherit_option,set_option FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))`,[[a.user,layout.owner,layout.migrator.user,layout.backup.user]])).rows;
      if(memberships.some(m=>m.member!==layout.migrator.user||m.role!==layout.owner||m.admin_option||m.inherit_option||!m.set_option))throw Error('Unexpected role membership; manual investigation required');
      if(!memberships.length)await admin.query(`GRANT ${q(layout.owner)} TO ${q(layout.migrator.user)} WITH INHERIT FALSE, SET TRUE`);
      const tables=(await admin.query("SELECT c.relname,pg_get_userbyid(c.relowner) AS owner,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m','f')")).rows;
      const allowed=new Set([...moduleTables(runtime.telemetry),'audit_ledger_sequence_no_seq']);
      if(tables.some(t=>!allowed.has(t.relname)||![a.user,layout.owner].includes(t.owner)||!['r','S','v'].includes(t.relkind)||(t.relkind==='v'&&t.relname!=='runtime_state')))throw Error('Unknown objects or owners; refusing automatic ownership takeover');
      const functions=(await admin.query("SELECT p.oid::regprocedure::text AS signature,p.proname,pg_get_userbyid(p.proowner) AS owner,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")).rows;
      if(functions.some(f=>!['reject_audit_mutation','reject_managed_data_mutation'].includes(f.proname)||![a.user,layout.owner].includes(f.owner)||f.prosecdef))throw Error('Unknown functions; refusing automatic ownership takeover');
      const databaseOwner=(await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0].owner;
      const schemaOwner=(await admin.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'")).rows[0].owner;
      if(![a.user,layout.owner].includes(databaseOwner)||![a.user,layout.owner,'pg_database_owner'].includes(schemaOwner))throw Error('Unexpected database/schema owner');
      for(const t of tables.filter(t=>['r','v'].includes(t.relkind)))await admin.query(`ALTER ${t.relkind==='v'?'VIEW':'TABLE'} public.${q(t.relname)} OWNER TO ${q(layout.owner)}`);
      for(const t of tables.filter(t=>t.relkind==='S'))await admin.query(`ALTER SEQUENCE public.${q(t.relname)} OWNER TO ${q(layout.owner)}`);
      for(const f of functions)await admin.query(`ALTER FUNCTION ${f.signature} OWNER TO ${q(layout.owner)}`);
      await admin.query(`ALTER DATABASE ${q(a.database)} OWNER TO ${q(layout.owner)}; ALTER SCHEMA public OWNER TO ${q(layout.owner)}; REVOKE ALL ON DATABASE ${q(a.database)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${q(a.database)} TO ${q(layout.migrator.user)}`);
      await admin.query('COMMIT');
    }catch(e){await admin.query('ROLLBACK');throw e;}
    migrator=new pg.Client(connectionFor(config,layout.migrator));await migrator.connect();
    await migrator.query('BEGIN');
    try{
      await migrator.query("SELECT pg_advisory_xact_lock(hashtext('idms-business-schema-v1'))");
      await migrator.query(`SET LOCAL ROLE ${q(layout.owner)}; SET LOCAL search_path TO public,pg_catalog`);
      const exists=(await migrator.query("SELECT to_regclass('public.idms_schema_migrations') AS table_name")).rows[0].table_name;
      if(exists){
        const rows=(await migrator.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
        if(migrationHistoryValid(rows,runtime,tenantId,true)){
          const payload=(await migrator.query('SELECT payload FROM runtime_state WHERE singleton=true FOR UPDATE')).rows[0].payload;
          verifyPayload(payload,tenantId);await initializeRevisionProjection(migrator,payload.imports,tenantId);
          await migrator.query('INSERT INTO idms_schema_migrations(version,tenant_id,checksum,modules,owner_role,app_role,backup_role) VALUES($1,$2,$3,$4,$5,$6,$7)',[2,tenantId,revisionMigrationChecksum(runtime.telemetry),JSON.stringify(runtime.telemetry?['core','telemetry']:['core']),layout.owner,a.user,layout.backup.user]);

        }else if(!migrationHistoryValid(rows,runtime,tenantId,2)&&!migrationHistoryValid(rows,runtime,tenantId,3)&&!migrationHistoryValid(rows,runtime,tenantId,4)&&!migrationHistoryValid(rows,runtime,tenantId))throw Error('Migration checksum/version/module/role mismatch; refusing repair');
      }else{
        await migrator.query(businessSchema);await migrator.query(workflowSchema);await migrator.query(aiSchema);if(runtime.telemetry)await migrator.query(telemetrySchema);
        await migrator.query('INSERT INTO runtime_state(singleton,revision,schema_version,payload) VALUES(true,1,2,$1) ON CONFLICT DO NOTHING',[tenantSeed(seed,tenantId)]);
        const row=(await migrator.query('SELECT schema_version,payload FROM runtime_state WHERE singleton=true FOR UPDATE')).rows[0];
        if(row?.schema_version!==2)throw Error('Unexpected snapshot schema');verifyPayload(row.payload,tenantId);
        for(const e of row.payload.audits)await migrator.query('INSERT INTO audit_ledger(event_id,tenant_id,hash,previous_hash,event) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO NOTHING',[e.eventId,e.tenantId,e.hash,e.previousHash,e]);
        const ledger=(await migrator.query('SELECT event_id,tenant_id,hash,previous_hash,event FROM audit_ledger ORDER BY sequence_no')).rows;
        if(ledger.some(r=>r.event_id!==r.event.eventId||r.tenant_id!==r.event.tenantId||r.hash!==r.event.hash||r.previous_hash!==r.event.previousHash)||canonical(ledger.map(r=>r.event))!==canonical(row.payload.audits))throw Error('Audit ledger differs from snapshot');
        await initializeDataProjection(migrator,row.payload.imports,tenantId);
        await migrator.query(migrationTableSchema);
        await migrator.query('INSERT INTO idms_schema_migrations(version,tenant_id,checksum,modules,owner_role,app_role,backup_role) VALUES($1,$2,$3,$4,$5,$6,$7)',[1,tenantId,legacyMigrationChecksum(runtime.telemetry),JSON.stringify(runtime.telemetry?['core','telemetry']:['core']),layout.owner,a.user,layout.backup.user]);
        await migrator.query('INSERT INTO idms_schema_migrations(version,tenant_id,checksum,modules,owner_role,app_role,backup_role) VALUES($1,$2,$3,$4,$5,$6,$7)',[2,tenantId,revisionMigrationChecksum(runtime.telemetry),JSON.stringify(runtime.telemetry?['core','telemetry']:['core']),layout.owner,a.user,layout.backup.user]);

      }
      const history=(await migrator.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
      if(migrationHistoryValid(history,runtime,tenantId,2)){
        await initializeEntities(migrator,tenantId);
        await migrator.query('INSERT INTO idms_schema_migrations(version,tenant_id,checksum,modules,owner_role,app_role,backup_role) VALUES($1,$2,$3,$4,$5,$6,$7)',[3,tenantId,normalizedMigrationChecksum(runtime.telemetry),JSON.stringify(runtime.telemetry?['core','telemetry']:['core']),layout.owner,a.user,layout.backup.user]);
      }else if(!migrationHistoryValid(history,runtime,tenantId,3)&&!migrationHistoryValid(history,runtime,tenantId,4)&&!migrationHistoryValid(history,runtime,tenantId))throw Error('Normalized migration history mismatch');
      const workerHistory=(await migrator.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
      if(migrationHistoryValid(workerHistory,runtime,tenantId,3)){
        await migrator.query(workerClaimSchema);await migrator.query('INSERT INTO idms_schema_migrations(version,tenant_id,checksum,modules,owner_role,app_role,backup_role) VALUES($1,$2,$3,$4,$5,$6,$7)',[4,tenantId,migrationChecksum(runtime.telemetry),JSON.stringify(runtime.telemetry?['core','telemetry']:['core']),layout.owner,a.user,layout.backup.user]);
      }else if(!migrationHistoryValid(workerHistory,runtime,tenantId,4)&&!migrationHistoryValid(workerHistory,runtime,tenantId))throw Error('Worker migration history mismatch');
      const registryHistory=(await migrator.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
      if(migrationHistoryValid(registryHistory,runtime,tenantId,4)){
        await migrator.query(registryHistorySchema);await migrator.query(reportEventsSchema);
        await migrator.query('INSERT INTO idms_schema_migrations(version,tenant_id,checksum,modules,owner_role,app_role,backup_role) VALUES($1,$2,$3,$4,$5,$6,$7)',[5,tenantId,latestMigrationChecksum(runtime.telemetry),JSON.stringify(runtime.telemetry?['core','telemetry','analysis']:['core','analysis']),layout.owner,a.user,layout.backup.user]);
      }else if(!migrationHistoryValid(registryHistory,runtime,tenantId))throw Error('Registry observation migration history mismatch');
      await verifyWorkerSchema(migrator);
      await grantPolicy(migrator,runtime);
      const payload=(await migrator.query('SELECT payload FROM runtime_state WHERE singleton=true')).rows[0].payload;verifyPayload(payload,tenantId);await verifyDataProjection(migrator,payload.imports,tenantId);
      await migrator.query('COMMIT');
    }catch(e){await migrator.query('ROLLBACK');throw e;}
    await migrator.end();migrator=undefined;
    check=new pg.Pool(connectionFor(config,a));const client=await check.connect();try{await verifyDatabaseSecurity(client,runtime,tenantId);}finally{client.release();}
    return {tenantId,version:migrationVersion,telemetry:runtime.telemetry,permissionsVerified:true};
  }finally{if(migrator)await migrator.end().catch(()=>{});if(check)await check.end();await admin.end();}
}

