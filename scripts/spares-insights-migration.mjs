import {canonical} from '../server/imports.ts';
import {sparesHistorySchema} from '../server/spares-db.ts';
import {sparesInsightsSchema,assertSparesInsightsSchema} from '../server/spares-insights-schema.ts';
import {captureSparesBackupAnchor,validateSparesBackupAnchor} from './spares-backup-anchor.mjs';

const quote=value=>{if(typeof value!=='string'||! /^[a-z_][a-z0-9_]{0,62}$/.test(value))throw Error('Invalid migration role');return '"'+value+'"';};
/** Dedicated offline migration. Caller authenticates the complete backup before
 * opening this connection. The fixed lock order matches current commands. */
export async function migrateSparesInsights({client,tenantId,ownerRole,appRole,backupRole,backup,verifyCurrent}){
 if(!/^[a-z][a-z0-9_-]{0,63}$/.test(tenantId)||typeof verifyCurrent!=='function'||!backup?.checks)throw Error('Migration binding and backup checks required');
 const owner=quote(ownerRole),app=quote(appRole),reader=quote(backupRole);if(new Set([ownerRole,appRole,backupRole]).size!==3)throw Error('Separate owner, application and backup roles required');
 validateSparesBackupAnchor(backup.spares);if(!backup.spares.available)throw Error('Backup does not contain initialized spares');
 let commitAttempted=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await client.query("SET LOCAL search_path=pg_catalog,public;SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='120s';SET LOCAL idle_in_transaction_session_timeout='130s';SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO, YMD';SET LOCAL bytea_output='hex';SET LOCAL extra_float_digits=3");
  await client.query('SET LOCAL ROLE '+owner);
  const publicHead=(await client.query('SELECT revision::text FROM public.business_state WHERE tenant_id=$1 FOR SHARE',[tenantId])).rows;
  const spareHead=(await client.query('SELECT revision::text FROM idms_spares.state WHERE tenant_id=$1 FOR UPDATE',[tenantId])).rows;
  if(publicHead.length!==1||spareHead.length!==1)throw Error('Tenant state binding missing');
  const marker=(await client.query("SELECT name,version FROM idms_spares.migrations WHERE name IN ('capacity','insights') ORDER BY name")).rows;
  const capacity=marker.find(r=>r.name==='capacity')?.version,insights=marker.find(r=>r.name==='insights')?.version;
  if(!(capacity===1&&insights===undefined||capacity===2&&insights===1))throw Error('Unsupported or incomplete spares capability; no automatic downgrade');
  const checks=await verifyCurrent(client),before=await captureSparesBackupAnchor(client,tenantId);
  if(canonical(checks)!==canonical(backup.checks)||canonical(before)!==canonical(backup.spares))throw Error('Business or spares changed since authenticated backup; create a fresh backup');
  await client.query(sparesHistorySchema);await client.query(sparesInsightsSchema);await assertSparesInsightsSchema(client);
  await client.query('REVOKE ALL ON idms_spares.material_plan_records FROM PUBLIC');
  await client.query('GRANT SELECT ON idms_spares.material_plan_records TO '+app+','+reader);
  const rights=(await client.query(`SELECT has_schema_privilege($1,'idms_spares','CREATE') AS ddl,
   has_table_privilege($1,'idms_spares.events','UPDATE') OR has_table_privilege($1,'idms_spares.events','DELETE') OR has_table_privilege($1,'idms_spares.events','TRUNCATE') AS history_write,
   has_table_privilege($1,'idms_spares.material_plan_records','SELECT') AS plan_read,
   has_table_privilege($2,'idms_spares.material_plan_records','SELECT') AS backup_read`,[appRole,backupRole])).rows[0];
  if(!rights||rights.ddl||rights.history_write||!rights.plan_read||!rights.backup_read)throw Error('Application and backup grants do not meet the migration boundary');
  const after=await captureSparesBackupAnchor(client,tenantId);if(canonical(before)!==canonical(after))throw Error('Migration changed posted facts or continuity anchor');
  const final=(await client.query("SELECT name,version FROM idms_spares.migrations WHERE name IN ('capacity','insights') ORDER BY name")).rows;
  if(final.length!==2||final[0].name!=='capacity'||final[0].version!==2||final[1].name!=='insights'||final[1].version!==1)throw Error('Capability installation not confirmed');
  commitAttempted=true;const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw Error('Migration commit not confirmed');
  return {tenantId,capacity:2,insights:1,alreadyInstalled:capacity===2,publicRevision:publicHead[0].revision,spares:after,postedFactsUnchanged:true,applicationDdl:false,productionAcceptance:false};
 }catch(error){if(!commitAttempted){await client.query('ROLLBACK').catch(()=>{});throw error;}throw Error('Migration commit result unknown; inspect database capability and original facts before retrying');}
}
