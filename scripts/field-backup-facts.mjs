import {memoryTask} from '../server/capacity.ts';
import {verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {verifyFieldModule} from '../server/field-schema-check.ts';
import {scanFieldSnapshotFacts} from './field-snapshot-facts.mjs';

// The source API always verifies the compiled runtime policy and FIELD module.
// No caller flag or callback can bypass either verifier.
export async function fieldBackupFacts(client,account,tenantId,{sequenceClient}={}){
 return memoryTask(async()=>{
  if(client.getTransactionStatus?.()!=='T')throw Object.assign(Error('FIELD_BACKUP_SNAPSHOT_REQUIRED'),{code:'FIELD_BACKUP_SNAPSHOT_REQUIRED'});
  await verifyDatabaseSecurity(client,account,tenantId);await verifyFieldModule(client,account,tenantId);
  return scanFieldSnapshotFacts(client,account,tenantId,{sequenceClient});
 },true);
}
