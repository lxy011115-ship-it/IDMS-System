import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../server/imports.ts';
import {connectionFor,validateRuntimeConfig,verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {readEntities} from '../server/entity-repository.ts';
import {writePrivate} from './keycloak-local.mjs';
import {migrationVersion} from '../server/postgres-schema.ts';
const args=process.argv.slice(2);assert.ok(args.length<=1&&args.every(a=>['--capture','--offline'].includes(a)));
const capture=args.includes('--capture'),offline=args.includes('--offline'),file=resolve('.local/normalized-upgrade-baseline.json'),config=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),baseline=capture?{}:JSON.parse(await readFile(file,'utf8')),runtime=capture?null:validateRuntimeConfig(JSON.parse(await readFile('.local/postgres-business.json','utf8'))),results={};
if(capture){await assert.rejects(access(file),e=>e.code==='ENOENT','Refusing to overwrite normalized migration evidence');}
const tables=['work_orders','managed_import_rows','managed_assets','managed_point_definitions','managed_measurements','managed_projection_state','managed_record_revisions'];
for(const [tenant,a]of Object.entries(config.tenants)){
 const client=new pg.Client(connectionFor(config,a));await client.connect();
 try{
  if(capture||offline)assert.equal((await client.query('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND pid<>pg_backend_pid()',[a.user])).rows[0].count,'0','Stop owned core database sessions before offline verification');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');if(runtime)await verifyDatabaseSecurity(client,runtime.tenants[tenant],tenant);
  const source=(await client.query('SELECT payload FROM runtime_state')).rows[0].payload,audit=(await client.query('SELECT event_id,tenant_id,hash,previous_hash,event FROM audit_ledger ORDER BY sequence_no')).rows,migrations=(await client.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
  const rowDigests={};for(const table of tables){const rows=(await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows.map(r=>canonical(r.row)).sort();rowDigests[table]={count:rows.length,digest:digest(canonical(rows))};}
  if(capture){assert.equal(migrations.length,2);assert.equal((await client.query("SELECT relkind FROM pg_class WHERE oid='runtime_state'::regclass")).rows[0].relkind,'r');baseline[tenant]={payloadDigest:digest(canonical(source)),importsDigest:digest(canonical(source.imports)),businessDigest:digest(canonical(source.business)),auditCount:audit.length,auditDigest:digest(canonical(audit)),migrationsDigest:digest(canonical(migrations)),rowDigests};}
  else{
   const expected=baseline[tenant];assert.ok(expected);await readEntities(client,tenant);assert.equal(digest(canonical(source.imports)),expected.importsDigest);assert.equal(digest(canonical(source.business)),expected.businessDigest);assert.equal(digest(canonical(audit.slice(0,expected.auditCount))),expected.auditDigest);assert.equal(digest(canonical(migrations.slice(0,2))),expected.migrationsDigest);assert.equal(migrations.length,migrationVersion);assert.deepEqual(rowDigests,expected.rowDigests);
   const archive=(await client.query('SELECT payload FROM migration_snapshot_v2')).rows[0].payload;assert.equal(digest(canonical(archive)),expected.payloadDigest);if(offline)assert.equal(digest(canonical(source)),expected.payloadDigest);
   assert.equal((await client.query("SELECT relkind FROM pg_class WHERE oid='runtime_state'::regclass")).rows[0].relkind,'v');assert.equal((await client.query("SELECT is_updatable FROM information_schema.views WHERE table_name='runtime_state'")).rows[0].is_updatable,'NO');
   results[tenant]={originalBusinessAndImportsUnchanged:true,originalFactsAndAuditPrefixUnchanged:true,historicalMigrationChecksumsUnchanged:true,archivedFullPayloadUnchanged:true,normalizedEntitiesVerified:true,minimumRolePolicyVerified:true,batches:source.imports.batches.length,workOrders:source.business.workOrders.length};
  }
  await client.query('COMMIT');
 }finally{await client.end();}
}
if(capture){await writePrivate(file,JSON.stringify(baseline));console.log('Captured read-only v2 migration evidence with owned core stopped; no payload or credentials logged');}
else{const evidence={verifiedAt:new Date().toISOString(),actualOriginalDatabases:true,migrationVersion,entityLayoutVersion:3,phase:offline?'AFTER_MIGRATION_BEFORE_CORE_START':'LIVE',tenants:results,productionAcceptance:false};await writeFile('outputs/normalized-upgrade-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));}

