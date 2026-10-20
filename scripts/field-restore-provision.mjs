import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {quoteIdentifier as q} from '../server/postgres-schema.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {fieldRestoreIntent} from './field-restore-record.mjs';
import {fieldDatabaseCreateOptions,readFieldDatabaseContext} from './field-capture-context.mjs';
import {emptyFieldRestorePhase,fieldRestorePhaseSql,readFieldRestorePhase} from './field-restore-phase.mjs';
import {closeSourceConnection} from './field-source-freeze.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});},same=(a,b)=>canonical(a)===canonical(b),literal=s=>"E'"+s.replaceAll('\\','\\\\').replaceAll("'","''")+"'";

export async function provisionFieldRestoreTarget({authority,rawIntent,targetRuntime,targetMigration,targetBackup,captureContext,guard,files}){
 const intent=fieldRestoreIntent(rawIntent),tenant=guard.tenantId,a=targetRuntime.tenants[tenant],m=targetMigration.tenants[tenant],b=targetBackup.tenants[tenant],names={owner:a.ownerRole,app:a.user,backup:a.backupRole,migrator:m.user};
 let lost=false;const check=async()=>{if(lost)fail('FIELD_RESTORE_CONNECTION_LOST');await guard.assertHeld();await files.assertRestoring();const state=await files.readRestoreState();if(!state.intent||!same(state.intent,intent))fail('FIELD_RESTORE_INTENT_CHANGED');};
 await check();
 if(intent.targetConfigSha256!==sourceFreezeSha({runtime:targetRuntime,migration:targetMigration,backup:targetBackup})||intent.captureContextSha256!==sourceFreezeSha(captureContext)||intent.migratorRole!==m.user||!same(intent.targetBinding,{host:targetRuntime.host,port:targetRuntime.port,database:a.database,user:a.user,ownerRole:a.ownerRole,backupRole:a.backupRole}))fail('FIELD_RESTORE_CONFIG_CHANGED');
 const client=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:'postgres',application_name:'idms-restore-provision-'+intent.operationId,connectionTimeoutMillis:5000});
 client.on('error',()=>{lost=true;});
 let connected=false,target;
 const tag=kind=>'IDMS_FIELD_RESTORE_ROLE_V1\n'+canonical({operationId:intent.operationId,restoreIntentSha256:sourceFreezeSha(intent),provisionNonce:intent.provisionNonce,database:a.database,kind});
 async function roleFrame(){
  const rows=(await client.query("SELECT oid::text AS oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig,shobj_description(oid,'pg_authid') AS comment FROM pg_roles WHERE rolname=ANY($1::text[])",[Object.values(names)])).rows;
  if(!rows.length)return null;
  if(rows.length!==4)fail('FIELD_RESTORE_ROLE_SET_PARTIAL');
  const out={};for(const [kind,name]of Object.entries(names)){const r=rows.find(x=>x.rolname===name);if(!r||r.comment!==tag(kind)||r.rolcanlogin||r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolinherit||r.rolreplication||r.rolbypassrls||r.rolconnlimit!==-1||r.rolvaliduntil!==null||r.rolconfig!==null)fail('FIELD_RESTORE_ROLE_CAPABILITY_CHANGED');out[kind]={name,oid:r.oid};}
  if((await client.query('SELECT 1 FROM pg_auth_members WHERE member=ANY($1::oid[]) OR roleid=ANY($1::oid[])',[Object.values(out).map(r=>r.oid)])).rowCount)fail('FIELD_RESTORE_ROLE_MEMBERSHIP_CHANGED');return out;
 }
 async function databaseFrame(ownerOid){const rows=(await client.query("SELECT oid::text AS oid,datname,datdba::text AS owner,datallowconn,datistemplate,datconnlimit,shobj_description(oid,'pg_database') AS comment FROM pg_database WHERE datname=$1",[a.database])).rows;if(!rows.length)return null;const r=rows[0];if(r.owner!==ownerOid||r.datistemplate||r.datconnlimit!==-1)fail('FIELD_RESTORE_DATABASE_CAPABILITY_CHANGED');return r;}
 try{
  await client.connect();connected=true;
  const system=(await client.query('SELECT system_identifier::text AS system FROM pg_control_system()')).rows[0].system;if(sourceFreezeSha('postgres:'+system)!==guard.authorityId)fail('FIELD_RESTORE_AUTHORITY_CHANGED');
  const state=await files.readRestoreState();let roles=await roleFrame();
  if(!roles){
   if(state.roles||state.provision||(await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[a.database])).rowCount)fail('FIELD_RESTORE_UNOWNED_TARGET');
   await client.query('BEGIN');try{
    for(const [kind,name]of Object.entries(names)){
     const password=kind==='owner'?null:kind==='app'?a.password:kind==='backup'?b.password:m.password;
     if(password!==null&&(typeof password!=='string'||Buffer.byteLength(password)<32||Buffer.byteLength(password)>1024||password.includes('\0')))fail('FIELD_RESTORE_CREDENTIAL_INVALID');
     await client.query(`CREATE ROLE ${q(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION${password?' PASSWORD '+literal(password):''}`);
     await client.query(`COMMENT ON ROLE ${q(name)} IS ${literal(tag(kind))}`);
    }
    await check();await client.query('/* IDMS_FIELD_RESTORE_ROLES_COMMIT */ COMMIT');
   }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
   roles=await roleFrame();
  }
  if(!roles)fail('FIELD_RESTORE_ROLE_SET_MISSING');if(state.roles&&!same(state.roles.roles,roles))fail('FIELD_RESTORE_ROLE_OID_CHANGED');
  await files.recordRestoreRoles({format:'idms-field-target-restore-roles-v1',operationId:intent.operationId,restoreIntentSha256:sourceFreezeSha(intent),roles});
  let database=await databaseFrame(roles.owner.oid);
  if(!database){if(state.provision)fail('FIELD_RESTORE_DATABASE_MISSING');await check();await client.query(`/* IDMS_FIELD_RESTORE_CREATE_DATABASE */ CREATE DATABASE ${q(a.database)} OWNER ${q(a.ownerRole)} TEMPLATE template0 ${fieldDatabaseCreateOptions(captureContext.database)} ALLOW_CONNECTIONS false`);database=await databaseFrame(roles.owner.oid);}
  if(!database)fail('FIELD_RESTORE_DATABASE_MISSING');if(state.provision&&(state.provision.database.oid!==database.oid||state.provision.database.name!==database.datname))fail('FIELD_RESTORE_DATABASE_OID_CHANGED');
  const phase=emptyFieldRestorePhase({operationId:intent.operationId,backupId:intent.backupId,restoreIntentSha256:sourceFreezeSha(intent),databaseName:a.database,databaseOid:database.oid});
  if(database.comment===null){
   if(database.datallowconn||state.provision||(await client.query('SELECT 1 FROM pg_stat_activity WHERE datid=$1::oid',[database.oid])).rowCount)fail('FIELD_RESTORE_DATABASE_UNOWNED');
   if((await client.query("SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x WHERE d.oid=$1::oid AND x.grantee<>0 AND x.grantee<>d.datdba",[database.oid])).rowCount)fail('FIELD_RESTORE_DATABASE_ACL_CHANGED');
   await client.query('BEGIN');try{await client.query(`REVOKE ALL ON DATABASE ${q(a.database)} FROM PUBLIC,${q(a.user)},${q(a.backupRole)},${q(m.user)};GRANT ALL ON DATABASE ${q(a.database)} TO ${q(a.ownerRole)}`);await client.query(fieldRestorePhaseSql(phase,a.ownerRole));await client.query('RESET ROLE');await client.query(`ALTER DATABASE ${q(a.database)} ALLOW_CONNECTIONS true`);await check();await client.query('/* IDMS_FIELD_RESTORE_DATABASE_OPEN_COMMIT */ COMMIT');}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
  }else if(!database.datallowconn)fail('FIELD_RESTORE_DATABASE_CAPABILITY_CHANGED');
  // No ordinary login is enabled at provisioning completion. Grant policy and
  // the narrowly scoped deployment writer are established by the restore stage.
  target=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:a.database,application_name:'idms-restore-empty-'+intent.operationId,connectionTimeoutMillis:5000});target.on('error',()=>{lost=true;});await target.connect();
  if(!same(await readFieldRestorePhase(target,a.database),phase))fail('FIELD_RESTORE_TARGET_ALREADY_STARTED');
  if(!same(await readFieldDatabaseContext(target,a.database),captureContext.database))fail('FIELD_RESTORE_DATABASE_CONTEXT_CHANGED');
  const schemas=(await target.query("SELECT nspname FROM pg_namespace WHERE nspname!~'^pg_' AND nspname<>'information_schema' ORDER BY nspname COLLATE \"C\"")).rows.map(r=>r.nspname);
  if(!same(schemas,['public'])||(await target.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_extension WHERE extname<>'plpgsql' UNION ALL SELECT 1 FROM pg_event_trigger UNION ALL SELECT 1 FROM pg_foreign_data_wrapper UNION ALL SELECT 1 FROM pg_largeobject_metadata UNION ALL SELECT 1 FROM pg_publication UNION ALL SELECT 1 FROM pg_subscription LIMIT 1")).rowCount)fail('FIELD_RESTORE_EMPTY_TARGET_CHANGED');
  if((await client.query('SELECT 1 FROM pg_stat_activity WHERE datid=$1::oid AND pid<>$2',[database.oid,target.processID])).rowCount)fail('FIELD_RESTORE_TARGET_OTHER_SESSION');
  const acl=(await client.query("SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x WHERE d.oid=$1::oid AND x.grantee<>d.datdba",[database.oid])).rowCount;if(acl)fail('FIELD_RESTORE_DATABASE_ACL_CHANGED');
  if(!same(await roleFrame(),roles))fail('FIELD_RESTORE_ROLE_OID_CHANGED');const finalDatabase=await databaseFrame(roles.owner.oid);if(!finalDatabase||finalDatabase.oid!==database.oid||!finalDatabase.datallowconn)fail('FIELD_RESTORE_DATABASE_OID_CHANGED');await check();await files.recordRestoreProvision({format:'idms-field-target-restore-provision-v1',operationId:intent.operationId,restoreIntentSha256:sourceFreezeSha(intent),rolesSha256:sourceFreezeSha((await files.readRestoreState()).roles),database:{name:a.database,oid:database.oid}});
  return {database:{name:a.database,oid:database.oid},roles,phase,alreadyRecorded:!!state.provision,targetAllOrdinaryRolesNoLogin:true,targetEmptyVerified:true};
 }finally{if(connected)await client.query('ROLLBACK').catch(()=>{});await closeSourceConnection(target);await closeSourceConnection(client);}
}
