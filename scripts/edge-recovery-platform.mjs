import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadExistingBinding,bindingFile,jsonFile,need,sha,runtimeSourceEvidence} from './existing-platform-binding.mjs';
import {processFacts,sameProcess,occupied,acquireCoordinator,launchGuardedService,observeStage} from './existing-platform-process.mjs';
import {serviceProbe,verifyExistingStores} from './existing-platform-probes.mjs';
import pg from 'pg';
import {privateDirectory} from './backup-support.mjs';
import {readEntities} from '../server/entity-repository.ts';
import {canonicalDigest} from '../server/canonical-state.ts';
import {memoryTask,holdValue} from '../server/capacity.ts';
import {streamRows} from '../server/pg-row-stream.ts';
import {authenticEvent} from '../integrations/telemetry.ts';
import {verifySourceReceipt,verifySourcePoint} from '../server/source-receipt-integrity.ts';
import {spoolSourceDigest} from '../services/edge/spool-v2.ts';
import {assertRegistryCurrent} from '../server/registry-history-sql.ts';
import {publicRegistry} from '../server/registry-history.ts';

export const recoveryRoot=resolve('.local/edge-recovery'),coordinatorFile=resolve('.local/platform-startup/coordinator.lock');
export async function recoveryPlatform(){
 const binding=await loadExistingBinding(),telemetry=await jsonFile(binding.files.telemetry.path),business=await jsonFile(binding.files.business.path),database=await jsonFile(binding.files.database.path),latest=await jsonFile('.local/platform-startup/latest.json',262144);
 need(telemetry.version===1&&telemetry.sources?.length===1&&telemetry.sources[0].origin==='SIMULATOR'&&typeof telemetry.edge?.spool==='string','RECOVERY_SINGLE_SIMULATOR_REQUIRED');
 const source=telemetry.sources[0];need(business.host==='127.0.0.1'&&business.host===database.host&&business.port===database.port&&business.tenants[source.tenantId],'RECOVERY_DATABASE_BINDING_INVALID');
 return {binding,telemetry,business,database,latest,source,spool:resolve(telemetry.edge.spool)};
}
/** No process is signalled here. Reused PID or occupied endpoint is a refusal. */
export async function assertRecoveryWritersStopped(p,{facts=processFacts,portOccupied=occupied}={}){
 const result=[];
 for(const name of ['main','edge','simulator']){
  const prior=p.latest?.services?.[name]?.process;need(prior?.pid&&prior.born&&prior.executable,'RECOVERY_WRITER_PROVENANCE_REQUIRED');
  const current=await facts(prior.pid);need(!current,current&&sameProcess(prior,current)?'RECOVERY_WRITER_STILL_LIVE':'RECOVERY_WRITER_PID_REUSED');result.push({service:name,process:prior,terminalObserved:true});
 }
 for(const port of [4010,4014,4015,4841])need(!await portOccupied(port),'RECOVERY_WRITER_ENDPOINT_OCCUPIED');
 return result;
}
export async function prepareRecoveryDatabase(){
 const p=await recoveryPlatform(),release=await acquireCoordinator(coordinatorFile);let report,directory;
 try{
  await assertRecoveryWritersStopped(p);
  if(await occupied(p.database.port)){need(await serviceProbe(p.binding,'database'),'RECOVERY_DATABASE_OCCUPIED_UNVERIFIED');return {status:'EXISTING_DATABASE_READY',reused:true,initialized:false};}
  const previous=p.latest?.services?.database?.process;if(previous){const current=await processFacts(previous.pid);need(!current,current&&sameProcess(previous,current)?'RECOVERY_DATABASE_LIVE_UNREADY':'RECOVERY_DATABASE_PID_REUSED');}
  try{const lines=(await readFile(join(p.binding.identity.data,'postmaster.pid'),'utf8')).split(/\r?\n/);need(resolve(lines[1])===p.binding.identity.data&&!await processFacts(Number(lines[0])),'RECOVERY_DATABASE_PID_UNCONFIRMED');}catch(e){if(e.code!=='ENOENT')throw e;}
  const runId=randomUUID();directory=resolve('.local/platform-startup/runs',runId);await privateDirectory(directory);report={format:1,purpose:'IDMS_RECOVERY_DATABASE_PREPARATION',runId,status:'STARTING',initialization:false,migration:false,forceTermination:false,bindingDigest:sha(JSON.stringify(p.binding))};await writeFile(join(directory,'recovery-database.json'),JSON.stringify(report),{flag:'wx',mode:0o600});
  const receipt=await launchGuardedService(bindingFile,directory,'database');report.process=receipt.process;
  const observation=await observeStage({probe:()=>serviceProbe(p.binding,'database'),alive:async()=>sameProcess(receipt.process,await processFacts(receipt.process.pid)),budgetMs:120000});report.status=observation.status;report.observation=observation;await writeFile(join(directory,'recovery-database.json'),JSON.stringify(report));need(['READY','LATE_READY'].includes(observation.status),'RECOVERY_DATABASE_START_UNCONFIRMED');
  return {status:'EXISTING_DATABASE_READY',reused:false,initialized:false,runId};
 }catch(error){if(report&&directory){report.status='UNCONFIRMED';report.code=error.code||'RECOVERY_DATABASE_START_UNCONFIRMED';await writeFile(join(directory,'recovery-database.json'),JSON.stringify(report)).catch(()=>{});}throw error;}
 finally{await release();}
}
/** Read-only, single MVCC snapshot. Frozen governed sources need their own
 * historical adapter; this recovery command never skips their proof. */
export async function legacyRecoveryAuthority(p,{probe=serviceProbe,verifyStores=verifyExistingStores}={}){
 need(await probe(p.binding,'database'),'RECOVERY_EXISTING_DATABASE_REQUIRED');await verifyStores(p.binding);
 const account=p.business.tenants[p.source.tenantId];
 const c=new pg.Client({host:p.business.host,port:p.business.port,...account,connectionTimeoutMillis:5000,statement_timeout:15000});
 try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');need((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only==='on','RECOVERY_READ_ONLY_REQUIRED');
 return await memoryTask(async()=>{
  const config=(await c.query('SELECT current_database() AS database,current_user AS role,host(inet_server_addr()) AS address,inet_server_port() AS port,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid')).rows[0];
  need(config.database===account.database&&config.role===account.user&&config.address==='127.0.0.1'&&config.port===p.business.port,'RECOVERY_DATABASE_IDENTITY_MISMATCH');
  await assertRegistryCurrent(c,p.source.tenantId,publicRegistry(p.telemetry.sources,p.source.tenantId));
  const census=(await c.query('SELECT count(*)::int AS n FROM telemetry_receipts WHERE edge_id=$1',[p.source.edgeId])).rows[0].n;need(census<=100000,'RECOVERY_RECEIPT_SCAN_LIMIT');
  const loaded=await readEntities(c,p.source.tenantId),index=new Map();
  for(const event of loaded.payload.audits)if(event.objectType==='TELEMETRY_EVENT'&&event.actorId===p.source.edgeId){need(event.metadata.sourceGovernance===undefined,'RECOVERY_GOVERNED_SOURCE_REQUIRES_REVIEW');const key=event.objectId+':'+event.metadata.inputDigest;need(!index.has(key),'RECOVERY_DUPLICATE_AUDIT_ANCHOR');index.set(key,event);}
  const release=holdValue(index);let count=0,stored=0,maximum=0,releaseRow=()=>{};
  try{
   await streamRows(c,"SELECT to_jsonb(r)||jsonb_build_object('sequence_no',r.sequence_no::text) AS receipt,CASE WHEN t.id IS NOT NULL THEN to_jsonb(t)||jsonb_build_object('sequence_no',t.sequence_no::text) ELSE NULL END AS point FROM telemetry_receipts r LEFT JOIN telemetry_points t ON t.id=r.point_id WHERE r.edge_id=$1 ORDER BY r.event_id,r.digest",row=>{
    releaseRow();releaseRow=holdValue(row);const r=row.receipt,e=r.envelope,anchor=index.get(r.event_id+':'+r.digest);need(anchor&&authenticEvent(e,p.source.signingKey),'RECOVERY_RECEIPT_ORIGINAL_INVALID');verifySourceReceipt(r,anchor,p.source.tenantId,p.source.edgeId,()=>null);
    if(r.status==='STORED'){verifySourcePoint(r,anchor,row.point,p.source.tenantId,p.source.edgeId);need(Number.isSafeInteger(e.sequenceNo)&&e.sequenceNo>0,'RECOVERY_SEQUENCE_INVALID');maximum=Math.max(maximum,e.sequenceNo);stored++;}
    count++;
   },()=>releaseRow(),[p.source.edgeId]);
   need(count===census&&count===index.size,'RECOVERY_RECEIPT_AUDIT_COVERAGE_MISMATCH');
  }finally{releaseRow();release();}
  const evidence={format:'IDMS_LEGACY_RECOVERY_AUTHORITY_V2',systemIdentifier:p.binding.identity.systemIdentifier,databaseOid:config.database_oid,database:config.database,role:config.role,sourceDigest:spoolSourceDigest(p.source),receipts:count,stored,durableSequence:maximum,revision:loaded.revision,payloadDigest:canonicalDigest(loaded.payload),auditCount:loaded.payload.audits.length,auditTip:loaded.payload.audits.at(-1)?.hash||'GENESIS'};
  return {evidence,digest:canonicalDigest(evidence)};
 },true);
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}
}
