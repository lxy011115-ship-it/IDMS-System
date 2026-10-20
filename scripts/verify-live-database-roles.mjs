import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {connectionFor,validateRuntimeConfig,verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {writePrivate} from './keycloak-local.mjs';

const args=process.argv.slice(2);assert.ok(args.every(a=>['--capture','--offline'].includes(a))&&args.length<=1);
const capture=args.includes('--capture'),offline=args.includes('--offline'),baselineFile=resolve('.local/database-roles-upgrade-baseline.json'),output='outputs/live-database-roles-verification.json';
const deployment=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),original=JSON.parse(await readFile('.local/ai-upgrade-baseline.json','utf8'));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),snapshot={};
const runtime=capture?null:validateRuntimeConfig(JSON.parse(await readFile('.local/postgres-business.json','utf8')));
for(const [tenant,a]of Object.entries(deployment.tenants)){
  const client=new pg.Client(connectionFor(deployment,a));await client.connect();
  try{
    if(capture)assert.equal((await client.query('SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND pid<>pg_backend_pid()',[a.user])).rows[0].count,'0','Stop the owned platform before capturing the baseline');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if(runtime)await verifyDatabaseSecurity(client,runtime.tenants[tenant],tenant);
    const payload=(await client.query('SELECT payload FROM runtime_state WHERE singleton=true')).rows[0].payload;
    const business={importsDigest:hash(payload.imports),businessDigest:hash(payload.business),batches:payload.imports.batches.length,workOrders:payload.business.workOrders.length};assert.deepEqual(business,original[tenant]);
    const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'idms_schema_migrations' ORDER BY tablename")).rows;
    const rows={};for(const {tablename:t}of tables){assert.match(t,/^[a-z_][a-z0-9_]*$/);const raw=(await client.query(`SELECT to_jsonb(t) AS row FROM public."${t}" t`)).rows.map(r=>r.row);if(t==='audit_ledger'){rows[t]={count:raw.length,appendOnly:true};}else if(t==='runtime_state'){const normalized=raw.map(r=>{const copy=structuredClone(r);if(copy.payload&&typeof copy.payload==='object')copy.payload.audits=[];return canonical(copy)}).sort();rows[t]={count:raw.length,digest:hash(normalized)};}else{const records=raw.map(r=>canonical(r)).sort();rows[t]={count:records.length,digest:hash(records)};}}
    snapshot[tenant]={business,tables:rows};await client.query('COMMIT');
  }finally{await client.end();}
}
if(capture){try{await access(baselineFile);throw Error('Refusing to overwrite the upgrade baseline');}catch(e){if(e.code!=='ENOENT')throw e;}await writePrivate(baselineFile,JSON.stringify(snapshot));console.log(JSON.stringify({captured:true,allOriginalBusinessDigestsMatch:true,platformStopped:true,credentialsLogged:false}));}
else{
  const baseline=JSON.parse(await readFile(baselineFile,'utf8'));
  for(const tenant of Object.keys(baseline)){assert.deepEqual(snapshot[tenant].business,baseline[tenant].business);for(const [table,expected] of Object.entries(baseline[tenant].tables)){const actual=snapshot[tenant].tables[table];if(table==='audit_ledger'||table==='telemetry_points'||table==='telemetry_receipts')assert.ok(actual.count>=expected.count,`${table} may only append`);else if(table!=='runtime_state')assert.deepEqual(actual,expected,`Historical table changed: ${tenant}.${table}`);}}
  if(!offline){assert.equal((await fetch('http://127.0.0.1:4010/api/v1/health')).status,200);}
  let prior={};try{prior=JSON.parse(await readFile(output,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const evidence={...prior,verifiedAt:new Date().toISOString(),...(offline?{allOriginalRowsUnchangedBeforeRestart:true}:{livePlatformAvailable:true,acmeAllOriginalRowsUnchanged:true,sandboxBusinessAndImportsUnchanged:true}),bothTenantRolePoliciesVerified:true,runtimeConfigurationContainsDeploymentSecrets:false,acmeBatches:snapshot.acme.business.batches,acmeWorkOrders:snapshot.acme.business.workOrders,scope:'TENANT_BUSINESS_DATABASE',productionAcceptance:false};
  await writeFile(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}
