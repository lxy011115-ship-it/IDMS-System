import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink,rmdir,access} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {generateKey,createTenantBackup,restoreTenantBackup} from './backup-support.mjs';

// Read-only source backup. Restore exclusively to a generated isolated DB, then remove that copy.
const config=JSON.parse(await readFile('.local/postgres-runtime.json','utf8'));
const baseline=JSON.parse(await readFile('.local/ai-upgrade-baseline.json','utf8'));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function businessState(){
  const state={};
  for(const [id,account] of Object.entries(config.tenants)){
    const client=new pg.Client({host:config.host,port:config.port,...account});await client.connect();
    try{const payload=(await client.query('SELECT payload FROM runtime_state')).rows[0].payload;state[id]={importsDigest:hash(payload.imports),businessDigest:hash(payload.business),batches:payload.imports.batches.length,workOrders:payload.business.workOrders.length};}
    finally{await client.end();}
  }
  return state;
}
assert.deepEqual(await businessState(),baseline,'Live business state must still match the original baseline');
const keyFile=resolve('.local/backup-keys/tenant-business-v1.json');
try{await access(keyFile);}catch(e){if(e.code!=='ENOENT')throw e;await generateKey(keyFile);}
const backup=await createTenantBackup({config,tenantId:'acme',keyFile,outputDirectory:resolve('.local/backups')});
const suffix=randomUUID().replaceAll('-','').slice(0,12),target='idms_restore_acme_'+suffix;
const directory=resolve('.local','recovery-verification-'+suffix),credentialFile=join(directory,'restore.json');
const started=Date.now(),ownership={};let result;
try{
  result=await restoreTenantBackup({config,tenantId:'acme',keyFile,backupFile:backup.file,targetDatabase:target,credentialFile,ownership});
  assert.equal(result.verified,true);assert.equal(result.checks.batches,baseline.acme.batches);assert.equal(result.checks.workOrders,baseline.acme.workOrders);
  assert.deepEqual(await businessState(),baseline,'Backup/recovery verification must not change live business data');
}finally{
  // This exact generated target never appears in the live database config.
  assert.match(target,new RegExp('^idms_restore_acme_'+suffix+'$'));
  assert.ok(!Object.values(config.tenants).some(account=>account.database===target||account.user===target));
  const admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:'postgres'});await admin.connect();
  try{if(ownership.databaseCreated)await admin.query(`DROP DATABASE "${target}" WITH (FORCE)`);if(ownership.roleCreated)await admin.query(`DROP ROLE "${target}"`);}finally{await admin.end();}
  await unlink(credentialFile).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(directory).catch(e=>{if(e.code!=='ENOENT')throw e;});
}
const evidence={verifiedAt:new Date().toISOString(),actualLiveTenantReadOnlyBackup:true,encryptedBackupFile:relative(process.cwd(),backup.file).replaceAll('\\','/'),keyStoredSeparately:true,actualIsolatedRestoreVerified:true,restoredPublicTables:result.tables,restoreVerificationElapsedMs:Date.now()-started,originalBusinessAndImportDigestsUnchanged:true,acmeBatches:baseline.acme.batches,acmeWorkOrders:baseline.acme.workOrders,temporaryRecoveryDatabaseAndCredentialsRemoved:true,sourceConfigurationChanged:false,scope:'TENANT_BUSINESS_DATABASE',recoveryMode:'ISOLATED_BUSINESS_ONLY',rpoRtoAcceptance:false,productionAcceptance:false};
await mkdir('outputs',{recursive:true});await writeFile('outputs/live-backup-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
