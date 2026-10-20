import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {legacyMigrationChecksum,revisionMigrationChecksum,normalizedMigrationChecksum,migrationChecksum,latestMigrationChecksum,migrationVersion,migrationHistoryValid,moduleTables,runtimeTablePrivileges} from './postgres-schema.ts';
import {registryHistorySchema} from './registry-history-schema.ts';
const old=JSON.parse(readFileSync(new URL('../scripts/fixtures/migrations-1-4-checksums.json',import.meta.url),'utf8'));
test('migration 5 preserves exact fixed historical four checksums for telemetry and nontelemetry tenants',()=>{
 for(const telemetry of [false,true]){assert.deepEqual([legacyMigrationChecksum(telemetry),revisionMigrationChecksum(telemetry),normalizedMigrationChecksum(telemetry),migrationChecksum(telemetry)],old[String(telemetry)]);assert.match(latestMigrationChecksum(telemetry),/^[a-f0-9]{64}$/);assert.notEqual(latestMigrationChecksum(telemetry),migrationChecksum(telemetry));}assert.equal(migrationVersion,5);
});
test('current migration requires all five ordered checksums and purpose modules with original roles',()=>{
 for(const telemetry of [false,true]){const a={telemetry,ownerRole:'owner',user:'app',backupRole:'backup'},rows=[...old[String(telemetry)],latestMigrationChecksum(telemetry)].map((checksum,i)=>({version:i+1,tenant_id:'acme',checksum,modules:[...(telemetry?['core','telemetry']:['core']),...(i===4?['analysis']:[])],owner_role:'owner',app_role:'app',backup_role:'backup'}));assert.equal(migrationHistoryValid(rows,a,'acme'),true);assert.equal(migrationHistoryValid(rows.slice(0,4),a,'acme',4),true);assert.equal(migrationHistoryValid(rows.slice(0,4),a,'acme'),false);
  for(const mutate of [(r:any[])=>r[4].checksum=r[3].checksum,(r:any[])=>r[4].modules=['core'],(r:any[])=>r[4].owner_role='intruder',(r:any[])=>r[3].modules.push('analysis'),(r:any[])=>r[0].tenant_id='sandbox',(r:any[])=>r.reverse()]){const r=structuredClone(rows);mutate(r);assert.equal(migrationHistoryValid(r,a,'acme'),false);}
 }
});
test('registry relation adds only append permission and reuses protected mutation trigger',()=>{
 assert.deepEqual(runtimeTablePrivileges.registry_history,['SELECT','INSERT']);for(const t of [false,true])assert.equal(moduleTables(t).filter(n=>n==='registry_history').length,1);assert.ok(registryHistorySchema.includes('PRIMARY KEY(tenant_id,revision)'));assert.ok(registryHistorySchema.includes('BEFORE UPDATE OR DELETE OR TRUNCATE'));assert.ok(!/DROP|ALTER|SECURITY DEFINER|serial/i.test(registryHistorySchema));
});
