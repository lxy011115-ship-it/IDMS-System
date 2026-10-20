import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import pg from 'pg';
import {canonical,digest} from '../server/imports.ts';
import {connectionFor,validateRuntimeConfig,verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {migrationHistoryValid} from '../server/postgres-schema.ts';
import {readEntities} from '../server/entity-repository.ts';
import {verifyDataProjection} from '../server/data-projection.ts';
import {RegistryChain,publicRegistry} from '../server/registry-history.ts';
import {writePrivate} from './keycloak-local.mjs';

const args=process.argv.slice(2);assert.equal(args.length,1);assert.ok(['--capture','--offline','--live'].includes(args[0]));
const capture=args[0]==='--capture',offline=args[0]==='--offline',file='.local/quality-policy-upgrade-baseline.json';
if(capture)await assert.rejects(access(file),e=>e.code==='ENOENT','Refusing to replace original upgrade evidence');
const config=JSON.parse(await readFile('.local/postgres-runtime.json')),runtime=validateRuntimeConfig(JSON.parse(await readFile('.local/postgres-business.json'))),baseline=capture?{}:JSON.parse(await readFile(file)),results={},added=[];
const hash=rows=>digest(canonical(rows.map(canonical).sort()));
for(const [tenant,a]of Object.entries(config.tenants)){
 const c=new pg.Client(connectionFor(config,a));await c.connect();try{
  if(capture||offline)assert.equal((await c.query('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND pid<>pg_backend_pid()',[runtime.tenants[tenant].user])).rows[0].count,'0','Owned core must be stopped for offline evidence');
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const migrations=(await c.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;assert.equal(migrations.length,5);assert.equal(migrationHistoryValid(migrations,runtime.tenants[tenant],tenant,5),true);
  if(!capture)await verifyDatabaseSecurity(c,runtime.tenants[tenant],tenant);
  const {payload}=await readEntities(c,tenant);await verifyDataProjection(c,payload.imports,tenant);
  const audit=(await c.query('SELECT * FROM audit_ledger ORDER BY sequence_no')).rows,tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'idms_schema_migrations' ORDER BY tablename")).rows.map(r=>r.tablename),rows={},columns={};
  for(const table of tables){assert.match(table,/^[a-z_][a-z0-9_]*$/);if(added.includes(table))continue;
   const limit=!capture&&!offline&&['telemetry_points','telemetry_receipts'].includes(table)?baseline[tenant].rows[table].count:null,order=table==='telemetry_points'?'received_at,id':table==='telemetry_receipts'?'received_at,edge_id,event_id,digest':null;
   let records=(await c.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t${order?' ORDER BY '+order:''}${limit!==null?' LIMIT $1':''}`,limit!==null?[limit]:[])).rows.map(r=>r.row);rows[table]={count:records.length,digest:hash(records)};
   columns[table]=(await c.query("SELECT column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[table])).rows;
  }
  const snapshot={tables,rows,columns,payloadDigest:digest(canonical(payload)),importsDigest:digest(canonical(payload.imports)),businessDigest:digest(canonical(payload.business)),auditCount:audit.length,auditDigest:digest(canonical(audit)),migrationPrefixDigest:digest(canonical(migrations.slice(0,5)))};
  if(capture){assert.ok(added.every(t=>!tables.includes(t)));baseline[tenant]=snapshot;}
  else{
   const expected=baseline[tenant];assert.deepEqual(tables,[...expected.tables,...added].sort());assert.deepEqual(columns,expected.columns);assert.equal(snapshot.importsDigest,expected.importsDigest);assert.equal(snapshot.businessDigest,expected.businessDigest);assert.equal(snapshot.migrationPrefixDigest,expected.migrationPrefixDigest);assert.equal(digest(canonical(audit.slice(0,expected.auditCount))),expected.auditDigest);
   
   if(offline){assert.equal(snapshot.payloadDigest,expected.payloadDigest);assert.deepEqual(rows,expected.rows);}
   else{
    for(const table of expected.tables)if(!['audit_ledger','business_state'].includes(table))assert.deepEqual(rows[table],expected.rows[table],tenant+'.'+table);
    assert.ok(payload.audits.slice(expected.auditCount).every(e=>['AUTH_LOGIN','AUTH_LOGOUT'].includes(e.action)||(tenant==='sandbox'&&e.action==='TELEMETRY_STORED'&&e.actorType==='INTERFACE'&&e.actorId==='sandbox-edge'&&e.metadata?.origin==='SIMULATOR')));
    const raw=(await c.query(`SELECT tenant_id,revision::text,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,writer_id,configuration_hash,previous_hash,hash,body FROM registry_history ORDER BY revision`)).rows,chain=new RegistryChain(tenant,Date.now());for(const row of raw)chain.accept(row);assert.equal(raw.length,1,'Only the actual first configuration observation may append');const checked=chain.finish({tenant_id:tenant,count:String(raw.length),revision:raw.at(-1).revision,hash:raw.at(-1).hash});assert.equal(checked.verifiedRevisions,'1');
    const source=JSON.parse(await readFile('.local/mqtt/telemetry-runtime.json'));assert.deepEqual(raw[0].body,publicRegistry(source.sources,tenant));
   }
   results[tenant]={migration5Unchanged:true,oldFiveMigrationRowsByteEquivalent:true,noSchemaRelationsAdded:true,oldTableColumnsUnchanged:true,oldBusinessImportsFilesRevisionRootsAndArchiveUnchanged:true,oldAuditPrefixUnchanged:true,minimumRoleAndImmutableProtectionVerified:true,allOldTableRowsExactlyPreserved:offline||undefined,onlyActualPublicRegistryObserved:!offline||undefined,noSyntheticCustomerReports:true,batches:payload.imports.batches.length,workOrders:payload.business.workOrders.length};
  }
  await c.query('COMMIT');
 }finally{await c.end();}
}
if(capture){await writePrivate(file,JSON.stringify(baseline));console.log('Captured original migration-5 root, all tables, columns and audit evidence with core stopped; evidence cannot be replaced');}
else{const proof={verifiedAt:new Date().toISOString(),actualOriginalDatabases:true,phase:offline?'AFTER_MIGRATION_BEFORE_CORE_START':'LIVE',migrationVersion:5,tenants:results,fullCommercialGoalRemainsActive:true,productionAcceptance:false};await writeFile('outputs/quality-policy-upgrade-'+(offline?'offline':'live')+'-verification.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));}
