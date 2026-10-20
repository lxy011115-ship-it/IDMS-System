import test from 'node:test';
import assert from 'node:assert/strict';
import {ownsClaim,type OutboxClaim} from './outbox-worker.ts';
import {normalizedMigrationChecksum,legacyMigrationChecksum,revisionMigrationChecksum,migrationChecksum,migrationHistoryValid} from './postgres-schema.ts';
test('a claim requires the same task, owner, token, full bigint fence and live database lease',()=>{
 const claim:OutboxClaim={kind:'ai',tenantId:'acme',id:'one',owner:'owner',token:'token',fence:'9007199254740993',row:{}},current={request_id:'one',status:'PENDING',worker_id:'owner',claim_token:'token',claim_fence:'9007199254740993',lease_live:true};assert.equal(ownsClaim(current,claim),true);
 for(const patch of [{request_id:'two'},{status:'DONE'},{worker_id:'new'},{claim_token:'new'},{claim_fence:'9007199254740992'},{claim_fence:9007199254740992},{lease_live:false},{lease_live:undefined}])assert.equal(ownsClaim({...current,...patch},claim),false);assert.equal(ownsClaim(undefined,claim),false);
});
test('v4 leaves historical v3 checksums intact and validates every migration in order',()=>{
 assert.equal(normalizedMigrationChecksum(false),'2ea0d200ca6a506e90f79865337432c1169e2b03fe5e8bc3881514d85a3e967c');assert.equal(normalizedMigrationChecksum(true),'9aa7106bad221bccebe7e668bcded9dbfa4f3536d62b7becfae1caccb79d96ba');
 const account={telemetry:false,ownerRole:'owner',user:'app',backupRole:'backup'},rows=[legacyMigrationChecksum(false),revisionMigrationChecksum(false),normalizedMigrationChecksum(false),migrationChecksum(false)].map((checksum,i)=>({version:i+1,tenant_id:'acme',checksum,modules:['core'],owner_role:'owner',app_role:'app',backup_role:'backup'}));assert.equal(migrationHistoryValid(rows,account,'acme',4),true);assert.equal(migrationHistoryValid(rows.slice(0,3),account,'acme',3),true);assert.equal(migrationHistoryValid(rows.slice(0,3),account,'acme'),false);rows[2].checksum=rows[3].checksum;assert.equal(migrationHistoryValid(rows,account,'acme',4),false);
});

