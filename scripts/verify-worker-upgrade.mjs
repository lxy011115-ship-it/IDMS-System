import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../server/imports.ts';
import {connectionFor,validateRuntimeConfig,verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {migrationHistoryValid} from '../server/postgres-schema.ts';
import {readEntities} from '../server/entity-repository.ts';
import {verifyDataProjection} from '../server/data-projection.ts';
import {writePrivate} from './keycloak-local.mjs';

const args=process.argv.slice(2);assert.ok(args.length<=2&&new Set(args).size===args.length&&args.every(a=>['--capture','--offline','--workspaces','--state-streaming','--capacity','--bootstrap','--bodies','--audit-pages','--write-postimage','--csv-stream','--cold-proof','--batch-pages','--cold-imports','--cold-inputs','--telemetry-quality','--calendar-coverage','--weekly-calendar','--calendar-history'].includes(a))&&!(args.includes('--capture')&&args.includes('--offline')));
const calendarHistory=args.includes('--calendar-history'),weeklyCalendar=calendarHistory||args.includes('--weekly-calendar'),calendarCoverage=weeklyCalendar||args.includes('--calendar-coverage'),telemetryQuality=calendarCoverage||args.includes('--telemetry-quality'),coldInputs=telemetryQuality||args.includes('--cold-inputs'),coldImports=coldInputs||args.includes('--cold-imports'),batchPages=args.includes('--batch-pages'),coldProof=args.includes('--cold-proof'),csvStream=args.includes('--csv-stream'),postImage=args.includes('--write-postimage'),auditPages=args.includes('--audit-pages'),capture=args.includes('--capture'),offline=args.includes('--offline'),workspaces=args.includes('--workspaces'),streaming=args.includes('--state-streaming'),capacity=args.includes('--capacity'),bootstrap=args.includes('--bootstrap'),bodies=args.includes('--bodies'),historyVersion=coldImports||batchPages||coldProof||csvStream||postImage||auditPages||workspaces||streaming||capacity||bootstrap||bodies?4:3,file=resolve(calendarHistory?'.local/calendar-history-upgrade-baseline.json':weeklyCalendar?'.local/weekly-calendar-upgrade-baseline.json':calendarCoverage?'.local/calendar-coverage-upgrade-baseline.json':telemetryQuality?'.local/telemetry-quality-upgrade-baseline.json':coldInputs?'.local/cold-inputs-upgrade-baseline.json':coldImports?'.local/cold-imports-upgrade-baseline.json':batchPages?'.local/batch-pages-upgrade-baseline.json':coldProof?'.local/cold-proof-upgrade-baseline.json':csvStream?'.local/csv-stream-upgrade-baseline.json':postImage?'.local/write-postimage-upgrade-baseline.json':auditPages?'.local/audit-pages-upgrade-baseline.json':bodies?'.local/read-bodies-upgrade-baseline.json':bootstrap?'.local/runtime-bootstrap-upgrade-baseline.json':capacity?'.local/capacity-upgrade-baseline.json':streaming?'.local/state-streaming-upgrade-baseline.json':workspaces?'.local/workspace-upgrade-baseline.json':'.local/worker-upgrade-baseline.json');
if(capture)await assert.rejects(access(file),e=>e.code==='ENOENT','Refusing to replace original upgrade evidence');
const config=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),runtime=validateRuntimeConfig(JSON.parse(await readFile('.local/postgres-business.json','utf8'))),baseline=capture?{}:JSON.parse(await readFile(file,'utf8')),results={};
const workerFields=['worker_id','claim_token','claim_fence','lease_until','claimed_at'],rowHash=rows=>digest(canonical(rows.map(canonical).sort()));
for(const [tenant,a]of Object.entries(config.tenants)){
 const client=new pg.Client(connectionFor(config,a));await client.connect();
 try{
  if(capture||offline)assert.equal((await client.query('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND pid<>pg_backend_pid()',[runtime.tenants[tenant].user])).rows[0].count,'0','Stop owned core sessions before offline evidence');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const migrations=(await client.query('SELECT * FROM idms_schema_migrations ORDER BY version')).rows;
  assert.equal(migrations.length,capture?historyVersion:4);assert.equal(migrationHistoryValid(migrations,runtime.tenants[tenant],tenant,capture?historyVersion:4),true);
  if(!capture)await verifyDatabaseSecurity(client,runtime.tenants[tenant],tenant);
  const {payload}=await readEntities(client,tenant);await verifyDataProjection(client,payload.imports,tenant);
  const audit=(await client.query('SELECT * FROM audit_ledger ORDER BY sequence_no')).rows;
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'idms_schema_migrations' ORDER BY tablename")).rows.map(r=>r.tablename),rows={};
  for(const table of tables){
   assert.match(table,/^[a-z_][a-z0-9_]*$/);let records=(await client.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t`)).rows.map(r=>r.row);
   if(!capture&&['workflow_outbox','ai_review_outbox'].includes(table)){
    assert.ok(records.every(r=>r.worker_id===null&&r.claim_token===null&&r.lease_until===null&&r.claimed_at===null&&r.claim_fence===0),'Original outboxes must retain their initial claim state');
    records=records.map(r=>Object.fromEntries(Object.entries(r).filter(([key])=>!workerFields.includes(key))));
   }
   if(!capture&&!offline&&['telemetry_points','telemetry_receipts'].includes(table)){
    const expected=baseline[tenant].rows[table];assert.ok(records.length>=expected.count,'Telemetry may only append');
    const order=table==='telemetry_points'?'received_at,id':'received_at,edge_id,event_id,digest';
    records=(await client.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY ${order} LIMIT $1`,[expected.count])).rows.map(r=>r.row);
   }
   rows[table]={count:records.length,digest:rowHash(records)};
  }
  const snapshot={tables,rows,payloadDigest:digest(canonical(payload)),importsDigest:digest(canonical(payload.imports)),businessDigest:digest(canonical(payload.business)),auditCount:audit.length,auditDigest:digest(canonical(audit)),migrationsDigest:digest(canonical(migrations.slice(0,historyVersion)))};
  if(capture)baseline[tenant]=snapshot;
  else{
   const expected=baseline[tenant];assert.deepEqual(tables,expected.tables);assert.equal(snapshot.importsDigest,expected.importsDigest);assert.equal(snapshot.businessDigest,expected.businessDigest);assert.equal(snapshot.migrationsDigest,expected.migrationsDigest);assert.equal(digest(canonical(audit.slice(0,expected.auditCount))),expected.auditDigest);
   if(offline){assert.equal(snapshot.payloadDigest,expected.payloadDigest);assert.deepEqual(rows,expected.rows);}
   else{
    for(const table of tables)if(!['audit_ledger','business_state'].includes(table))assert.deepEqual(rows[table],expected.rows[table],'Historical rows changed: '+tenant+'.'+table);
    assert.ok(payload.audits.slice(expected.auditCount).every(a=>['AUTH_LOGIN','AUTH_LOGOUT'].includes(a.action)||(tenant==='sandbox'&&a.action==='TELEMETRY_STORED'&&a.actorType==='INTERFACE'&&a.actorId==='sandbox-edge'&&a.metadata?.origin==='SIMULATOR')),'Only authentication and the existing sandbox simulator audits may append during the read-only upgrade');
   }
   results[tenant]={fullPayloadAndEveryTablePreservedBeforeRestart:offline||undefined,originalRowsAndAuditPrefixUnchanged:true,historicalV1V2V3ChecksumsUnchanged:true,newMigrationVersion:4,entityLayoutVersion:3,claimDefaultsPreserved:true,minimumRolePolicyVerified:true,batches:payload.imports.batches.length,workOrders:payload.business.workOrders.length};
  }
  await client.query('COMMIT');
 }finally{await client.end();}
}
if(capture){await writePrivate(file,JSON.stringify(baseline));console.log('Captured original database digest evidence with core stopped; no payload or secrets logged');}
else{
 const proof={verifiedAt:new Date().toISOString(),actualOriginalDatabases:true,phase:offline?'AFTER_MIGRATION_BEFORE_CORE_START':'LIVE',migrationVersion:4,entityLayoutVersion:3,authenticationSchemaVersion:1,tenants:results,productionAcceptance:false};
 await writeFile('outputs/'+(calendarHistory?'calendar-history-upgrade-':weeklyCalendar?'weekly-calendar-upgrade-':calendarCoverage?'calendar-coverage-upgrade-':telemetryQuality?'telemetry-quality-upgrade-':coldInputs?'cold-inputs-upgrade-':coldImports?'cold-imports-upgrade-':batchPages?'batch-pages-upgrade-':coldProof?'cold-proof-upgrade-':csvStream?'csv-stream-upgrade-':postImage?'write-postimage-upgrade-':auditPages?'audit-pages-upgrade-':bodies?'read-bodies-upgrade-':bootstrap?'runtime-bootstrap-upgrade-':capacity?'capacity-upgrade-':streaming?'state-streaming-upgrade-':workspaces?'workspace-upgrade-':'worker-upgrade-')+(offline?'offline':'live')+'-verification.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
}
