import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRuntimeConfig,connectionFor} from './postgres-security.ts';
import {migrationChecksum,legacyMigrationChecksum,moduleTables,tablePrivileges} from './postgres-schema.ts';

function config(){return {format:1,purpose:'BUSINESS_RUNTIME',host:'127.0.0.1',port:55432,tenants:{acme:{user:'qa_app',password:'test-only',database:'qa_db',ownerRole:'qa_owner',backupRole:'qa_backup',telemetry:false}}};}
test('business configuration rejects deployment secrets, role sharing and connection overrides',()=>{
  assert.equal(validateRuntimeConfig(config()).purpose,'BUSINESS_RUNTIME');
  for(const extra of [{bootstrapPassword:'secret'},{control:{}},{workflowTenants:{}}])assert.throws(()=>validateRuntimeConfig({...config(),...extra}));
  assert.throws(()=>validateRuntimeConfig({...config(),purpose:'BUSINESS_MIGRATION'}));
  assert.throws(()=>validateRuntimeConfig({...config(),tenants:{acme:{...config().tenants.acme,options:'-c role=owner'}}}));
  assert.throws(()=>validateRuntimeConfig({...config(),tenants:{...config().tenants,sandbox:{...config().tenants.acme,database:'other'}}}));
  assert.deepEqual(Object.keys(connectionFor(config(),config().tenants.acme)).sort(),['connectionTimeoutMillis','database','host','password','port','statement_timeout','user']);
});
test('migration identity binds schema and module scope while app permissions preserve append-only facts',()=>{
  assert.match(migrationChecksum(false),/^[a-f0-9]{64}$/);assert.notEqual(migrationChecksum(false),migrationChecksum(true));
  assert.ok(!moduleTables(false).includes('telemetry_points'));assert.ok(moduleTables(true).includes('telemetry_points'));
  for(const table of ['audit_ledger','managed_assets','managed_measurements','telemetry_points','telemetry_receipts'])assert.deepEqual(tablePrivileges[table],['SELECT','INSERT']);
  assert.deepEqual(tablePrivileges.idms_schema_migrations,['SELECT']);
});

test('the immutable version-one migration checksums remain byte-compatible with the previous release',()=>{
 assert.equal(legacyMigrationChecksum(false),'58d1fe4493ec758a80d47006a2eee575f4b2155f0e1f8dcabb4baba1c569968a');
 assert.equal(legacyMigrationChecksum(true),'6a5f58b6a259d3b1524557ab7d15eb2c354728d21c6b774240ab621ce9feff8f');
 assert.deepEqual(tablePrivileges.managed_record_revisions,['SELECT','INSERT']);
});
