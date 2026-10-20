import assert from 'node:assert/strict';
import pg from 'pg';
import {fieldBackupFacts} from '../field-backup-facts.mjs';
import {connectionFor} from '../../server/postgres-security.ts';
import {canonical} from '../../server/imports.ts';
export async function exerciseFieldBackupFacts({runtime,backup,admin,directory}){
 const a=runtime.tenants.acme,client=new pg.Client(connectionFor(runtime,a)),sequenceClient=new pg.Client(connectionFor(backup,backup.tenants.acme));assert.equal(backup.host,runtime.host);assert.equal(backup.port,runtime.port);await client.connect();await sequenceClient.connect();
 let snapshotId;
 const begin=async()=>{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;snapshotId=snapshot;assert.match(snapshot,/^[A-Fa-f0-9-]{1,64}$/);await sequenceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await sequenceClient.query("SET TRANSACTION SNAPSHOT '"+snapshot+"'");};
 const facts=()=>fieldBackupFacts(client,a,'acme',{sequenceClient});
 try{
  await assert.rejects(fieldBackupFacts(client,a,'acme'),{code:'FIELD_BACKUP_SNAPSHOT_REQUIRED'});
  await client.query("SET default_transaction_isolation='repeatable read'");await assert.rejects(fieldBackupFacts(client,a,'acme'),{code:'FIELD_BACKUP_SNAPSHOT_REQUIRED'});await begin();
  await assert.rejects(fieldBackupFacts(client,a,'acme'),{code:'FIELD_BACKUP_READONLY_SEQUENCE_READER_REQUIRED'});await assert.rejects(fieldBackupFacts(client,a,'acme',{sequenceClient:client}),{code:'FIELD_BACKUP_READONLY_SEQUENCE_READER_REQUIRED'});
  const before=(await admin.query('SELECT * FROM business_state')).rows,first=await facts(),again=await facts();assert.equal(canonical(first),canonical(again));
  const point=first.relations.find(t=>t.schema==='idms_field'&&t.table==='points'),receipt=first.relations.find(t=>t.schema==='idms_field'&&t.table==='receipts');assert.ok(point.rows>0&&receipt.rows>0);assert.ok(first.relations.find(t=>t.schema==='idms_field'&&t.table==='migrations').rows===1);assert.equal(first.relations.filter(t=>t.schema==='public'&&t.kind==='r').length,31);assert.equal(first.relations.length,35);assert.equal(first.relations.filter(t=>t.kind==='v').length,1);assert.ok(first.relations.find(t=>t.table==='runtime_state').definition.includes('business_state'));assert.ok(first.sequences.length>0);assert.equal(first.sequenceValuesAreNotMvcc,true);assert.deepEqual((await admin.query('SELECT * FROM business_state')).rows,before);
  const {exerciseFieldBackupArchive}=await import('./field-backup-archive-checks.mjs');const archiveCodec=await exerciseFieldBackupArchive({runtime,backup,snapshotId,facts:first,directory});
  await admin.query("SELECT nextval('public.audit_ledger_sequence_no_seq'::regclass)");
  const afterSequence=await facts();assert.equal(canonical(afterSequence.relations),canonical(first.relations));assert.notEqual(canonical(afterSequence.sequences),canonical(first.sequences));assert.notEqual(afterSequence.factsSha256,first.factsSha256);assert.deepEqual((await admin.query('SELECT * FROM business_state')).rows,before);
  // New table schemas must not be silently omitted by an archive's fact set.
  await admin.query('CREATE SCHEMA field_backup_unknown');
  assert.equal(canonical(await facts()),canonical(afterSequence),'Same RR keeps the original schema catalogue');
  await sequenceClient.query('COMMIT');await client.query('COMMIT');await begin();await assert.rejects(facts(),{code:'FIELD_BACKUP_SCHEMA_UNSUPPORTED'});await sequenceClient.query('ROLLBACK');await client.query('ROLLBACK');await admin.query('DROP SCHEMA field_backup_unknown');
  return {archiveCodec,actualMinimumRoleFullPublicAndFieldFacts:true,publicTables:31,publicDerivedViews:1,fieldTables:3,actualNonemptyPointRows:point.rows,actualNonemptyReceiptRows:receipt.rows,repeatedSameSnapshotFactsIdentical:true,newSchemaInvisibleInOldRrAndRejectedByNewSnapshot:true,rootUnchangedByFactReads:true,separateReadonlyBackupRoleImportsSameExportedSnapshot:true,noImplicitSnapshotOrWrongSequenceRoleAccepted:true,sequencesCapturedButNotClaimedMvcc:true,actualSequenceAdvanceVisibleAcrossSameSnapshotWhileRowsRemainUnchanged:true,encryptedArchiveAndDatabaseRestoreNotPartOfThisTest:true};
 }finally{await sequenceClient.query('ROLLBACK').catch(()=>{});await client.query('ROLLBACK').catch(()=>{});await sequenceClient.end();await client.end();await admin.query('DROP SCHEMA IF EXISTS field_backup_unknown');}
}
