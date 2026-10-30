import assert from 'node:assert/strict';
import {readFile,unlink} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {createTenantBackup,restoreTenantBackup,privateNewFile} from './backup-support.mjs';
import {observeIsolatedTargetBackendsToZero} from './core-upgrade-archives-observed-r4.mjs';
import {withRestoreClientR5} from './restore-client-lifecycle-r5.mjs';
export async function captureCoreUpgradeArchives({phase,directory,keyFile,config,gate}){
 assert.ok(['before','after','qa'].includes(phase));directory=resolve(directory);const records=[];
 await gate.assertHeld();const source=gate.summary();
 for(const tenantId of Object.keys(config.tenants).sort()){
  await gate.assertHeld();const target='idms_restore_'+tenantId.replaceAll('-','_')+'_'+randomUUID().replaceAll('-','').slice(0,12),credential=join(directory,target+'.private.json'),ownership={},account=config.tenants[tenantId],admin=new pg.Client({host:config.host,port:config.port,user:'idms_bootstrap',password:config.bootstrapPassword,database:'postgres',application_name:'idms-restore-capture-r5-'+process.pid});let backup,restored,pin,closingBackend,cleanupObservation;
  assert.ok(!Object.values(config.tenants).some(a=>[a.database,a.user].includes(target)));assert.ok(!isAbsolute(relative(directory,credential))&&!relative(directory,credential).startsWith('..'));
  let attemptedRestore=false;
  await withRestoreClientR5(admin,async()=>{await admin.connect();
   assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$1',[target])).rowCount,0);
   backup=await createTenantBackup({config,tenantId,keyFile,outputDirectory:join(directory,'private-archives')});await gate.assertHeld();
   await assert.rejects(readFile(credential),{code:'ENOENT'});attemptedRestore=true;
   restored=await restoreTenantBackup({config,tenantId,keyFile,backupFile:backup.file,targetDatabase:target,credentialFile:credential,ownership});assert.ok(restored.verified);assert.equal(restored.tables,backup.tables);assert.deepEqual(restored.checks,backup.checks);
   pin=(await admin.query('SELECT d.oid::text AS database_oid,r.oid::text AS role_oid,d.datdba::text AS owner FROM pg_database d JOIN pg_roles r ON r.rolname=d.datname WHERE d.datname=$1',[target])).rows[0];assert.ok(pin&&pin.owner===pin.role_oid);
   const credentials=JSON.parse(await readFile(credential,'utf8')),c=new pg.Client({host:config.host,port:config.port,...credentials,application_name:'idms-restore-check-r5-'+process.pid});await withRestoreClientR5(c,async()=>{await c.connect();closingBackend=(await c.query('SELECT pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS started')).rows[0];const seq=(await c.query('SELECT last_value::text AS value,is_called FROM audit_ledger_sequence_no_seq')).rows[0],expected=source.find(s=>s.tenantId===tenantId).sequence[0];assert.equal(seq.value,expected.lastValue);assert.equal(seq.is_called,expected.isCalled);});
   await gate.assertHeld();
  },{cleanup:async()=>{
   if(ownership.roleCreated){const r=(await admin.query('SELECT oid::text,rolsuper,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=$1',[target])).rows[0];assert.ok(r&&!r.rolsuper&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolinherit);if(pin)assert.equal(r.oid,pin.role_oid);
    if(ownership.databaseCreated){const d=(await admin.query('SELECT oid::text,datdba::text FROM pg_database WHERE datname=$1',[target])).rows[0];assert.ok(d&&d.datdba===r.oid);if(pin)assert.equal(d.oid,pin.database_oid);cleanupObservation=await observeIsolatedTargetBackendsToZero(admin,d.oid,r.oid,target);await admin.query('DROP DATABASE "'+target+'"');}
    await admin.query('DROP ROLE "'+target+'"');assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$1',[target])).rowCount,0);
   }
   if(attemptedRestore)assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1 UNION ALL SELECT 1 FROM pg_roles WHERE rolname=$1',[target])).rowCount,0,'Uncertain restore target remains; keep credentials');
  },afterClose:async()=>{if(attemptedRestore)await unlink(credential).catch(e=>{if(e.code!=='ENOENT')throw e;});}});
  records.push({tenantId,sourceDatabase:account.database,sourceDatabaseOid:source.find(s=>s.tenantId===tenantId).databaseOid,backupId:backup.backupId,archiveSha256:createHash('sha256').update(await readFile(backup.file)).digest('hex'),encryptedBytes:backup.encryptedBytes,tables:backup.tables,checks:backup.checks,authenticatedActualIsolatedRestore:true,completeFactsAndBusinessChecksEqual:true,nonMvccAuditSequenceEqual:true,sourceMaintenanceStayedHeld:true,onlyOwnedRestoreDatabaseRoleAndCredentialsRemoved:true,cleanupObservation});
 }
 await gate.assertHeld();assert.deepEqual(gate.summary(),source);const proof={format:'idms-controlled-core-business-archives-v1',verifiedAt:new Date().toISOString(),phase,tenants:records,gateSummary:source,sourceDatabaseRestoredInPlace:false,crossServiceDisasterRecovery:false,productionAcceptance:false};await privateNewFile(join(directory,phase+'-archives-verification.json'),JSON.stringify(proof,null,2));return proof;
}
