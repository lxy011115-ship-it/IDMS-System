import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import pg from 'pg';
import {generateKey,createTenantBackup,restoreTenantBackup} from '../backup-support.mjs';
import {reportColumns} from '../../server/report-store-sql.ts';
import {appendReportState,verifyReportPayload} from '../../server/report-events.ts';
import {RegistryChain} from '../../server/registry-history.ts';
import {canonical} from '../../server/imports.ts';

export async function reportRestoreChecks({config,root,client,admin,afterRestore}){
 assert.match(config.tenants.acme.database,/^idms_registryqa_acme_[a-f0-9]{10}$/);
 const suffix=randomUUID().replaceAll('-','').slice(0,12),target='idms_restore_acme_'+suffix,directory=resolve('.local','reportrestoreqa-'+suffix),keyFile=join(directory,'key.json'),credentialFile=join(directory,'restore.json'),ownership={};let recovered,restored,reportCount=0;
 const sourceRows=(await client.query('SELECT to_jsonb(t) AS row FROM analysis_report_events t ORDER BY report_id,revision')).rows;
 await mkdir(directory,{recursive:true});await generateKey(keyFile);
 try{
  const backup=await createTenantBackup({config,tenantId:'acme',keyFile,outputDirectory:directory});
  recovered=await restoreTenantBackup({config:{...config,bootstrapPassword:root.bootstrapPassword},tenantId:'acme',keyFile,backupFile:backup.file,targetDatabase:target,credentialFile,ownership});assert.equal(recovered.verified,true);
  const account=JSON.parse(await (await import('node:fs/promises')).readFile(credentialFile));restored=new pg.Client({host:root.host,port:root.port,...account});await restored.connect();
  assert.equal(canonical((await restored.query('SELECT to_jsonb(t) AS row FROM analysis_report_events t ORDER BY report_id,revision')).rows),canonical(sourceRows));
  const events=(await restored.query('SELECT '+reportColumns+' FROM analysis_report_events ORDER BY report_id,revision')).rows;
  for(const id of new Set(events.map(e=>e.report_id))){let state=null;for(const event of events.filter(e=>e.report_id===id))state=appendReportState(state,event);const payload=(await restored.query('SELECT payload FROM analysis_report_events WHERE report_id=$1 AND revision=1',[id])).rows[0].payload;assert.equal(verifyReportPayload(state,payload).inputDigest,state.summary.inputDigest);reportCount++;}
  assert.ok(reportCount>=2);
  if(afterRestore)await afterRestore(restored);
  const observations=(await restored.query(`SELECT tenant_id,revision::text,to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,writer_id,configuration_hash,previous_hash,hash,body FROM registry_history ORDER BY revision`)).rows,chain=new RegistryChain('acme',Date.now());for(const row of observations)chain.accept(row);chain.finish({tenant_id:'acme',count:String(observations.length),revision:observations.at(-1)?.revision||'0',hash:observations.at(-1)?.hash||'GENESIS'});
 }finally{
  await restored?.end();assert.match(target,new RegExp('^idms_restore_acme_'+suffix+'$'));assert.ok(!Object.values(config.tenants).some(a=>a.database===target||a.user===target));if(ownership.databaseCreated)await admin.query('DROP DATABASE "'+target+'" WITH (FORCE)');if(ownership.roleCreated)await admin.query('DROP ROLE "'+target+'"');
  for(const file of ['key.json','restore.json'])await unlink(join(directory,file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 }
 const proof={verifiedAt:new Date().toISOString(),qaOnly:true,sourceReadOnlyEncryptedBackup:true,actualIsolatedRestoreVerified:true,restoredPublicTables:recovered.tables,reportCount,allReportRowsIncludingApprovalEventsExactlyPreserved:true,everyRestoredFrozenPayloadIndependentlyRecomputed:true,restoredPublicRegistryFullChainVerified:true,temporaryRecoveryDatabaseRoleAndCredentialsRemoved:true,actualBackupAndKeyNotExported:true,scope:'TENANT_BUSINESS_DATABASE',rpoRtoAcceptance:false,productionAcceptance:false};await writeFile('outputs/analysis-report-restore-verification.json',JSON.stringify(proof,null,2));return proof;
}
