import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {privateDirectory} from '../scripts/backup-support.mjs';
import {createOwnedPlatformPgQaV1} from '../scripts/fixtures/owned-platform-pg-v1-qa.mjs';
import {workflowReaderHbaPrefixV1} from '../scripts/workflow-review-source-hba-v1.mjs';
import {launchPostgresLifecycleV1} from '../scripts/postgres-lifecycle-v1.mjs';
import {launchPostgresLifecycleV2,bindPostgresLifecycleV2,inspectPostgresLifecycleV2,stopPostgresLifecycleV2} from '../scripts/postgres-lifecycle-v2.mjs';

let cluster,evidence,readerRole,readerPassword,work;const handles=[],targets=[];let next=0;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
before(async()=>{
  assert(process.env.IDMS_COLD_FIELD_PG_BIN&&process.env.IDMS_COLD_FIELD_PG_WORK);work=resolve(process.env.IDMS_COLD_FIELD_PG_WORK);cluster=await createOwnedPlatformPgQaV1(process.env.IDMS_COLD_FIELD_PG_BIN);readerRole='review_owner_'+cluster.nonce;readerPassword=randomBytes(32).toString('base64url');
  const root=await cluster.client();try{await root.query('CREATE ROLE "'+readerRole+'" LOGIN PASSWORD '+pg.escapeLiteral(readerPassword));}finally{await root.end();}
  const file=join(cluster.source,'pg_hba.conf'),original=await readFile(file),readers=[{role:readerRole,database:'postgres'}],prefix=Buffer.from(workflowReaderHbaPrefixV1(readers)),bytes=Buffer.concat([prefix,original]);await writeFile(file,bytes);
  evidence={purpose:'PERSISTENT_R4_COLD_REVIEW_CONTROL_V2',coldControlId:randomUUID(),sourceHash:randomBytes(32).toString('hex'),maintenanceOperationId:randomUUID(),readerHba:{format:'COLD_REVIEW_IMAGE_HBA_V2',sha256:sha(bytes),prefixSha256:sha(prefix),readers}};await cluster.stop();
});
async function normalStop(handle){for(let index=0;index<40;index++){const state=await inspectPostgresLifecycleV2(handle);if(state.otherClients===0)break;await new Promise(ok=>setTimeout(ok,25));}return stopPostgresLifecycleV2(handle,{requestId:randomUUID()});}
after(async()=>{
  for(const item of handles.toReversed())if(item.handle.process.exitCode===null&&item.handle.process.signalCode===null){await writeFile(join(item.target,'pg_hba.conf'),item.originalHba);if(!item.handle.bound)await bindPostgresLifecycleV2(item.handle);await normalStop(item.handle);}
  await cluster?.stop();readerPassword='';
  const value={format:'POSTGRES_REVIEW_LIFECYCLE_ACTUAL_V2',postgresVersion:cluster?.tooling.binding.version??null,clusterDirectory:cluster?.work??null,targetsCreated:targets.length,actualPostmastersCreated:handles.length,sourceOriginalSmartStopped:!!cluster&&cluster.processes.every(value=>value.stopped),allOriginalTargetHandlesNormallyExited:handles.length>0&&handles.every(value=>value.handle.stopProof?.terminal.code===0&&value.handle.stopProof?.terminal.signal===null&&value.handle.stopProof?.terminal.proofSaved&&value.handle.stopProof?.mode==='smart'&&value.handle.helperAttempts===1),originalProcessHandleUsed:true,exactReaderHbaProfileVerified:true,workflowReaderContractOrSourceCapabilityProven:false,archiveAuthenticationOrActivationGranted:false,genericKillUsed:false};
  await writeFile(join(work,'actual-postgres-terminal-v2.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});assert(value.allOriginalTargetHandlesNormallyExited&&value.sourceOriginalSmartStopped);
});
async function options(){const target=join(work,'review-target-'+(++next));await cp(cluster.source,target,{recursive:true,errorOnExist:true,force:false});targets.push(target);const records=join(work,'records-'+next);await mkdir(records);await privateDirectory(records);return {binDirectory:cluster.bin,dataDirectory:target,workDirectory:records,expectedSystemIdentifier:cluster.systemIdentifier,port:cluster.account.port,account:{user:cluster.account.user,password:cluster.account.password,database:'postgres'},reviewEvidence:structuredClone(evidence)};}
async function launch(options){const originalHba=await readFile(join(options.dataDirectory,'pg_hba.conf')),handle=await launchPostgresLifecycleV2(options);handles.push({handle,target:options.dataDirectory,originalHba});await bindPostgresLifecycleV2(handle);return handle;}
async function connect(user,password,database){const client=new pg.Client({...cluster.account,user,password,database,connectionTimeoutMillis:3000});try{await client.connect();return await client.query('SELECT current_user AS role,current_database() AS database');}finally{await client.end();}}

test('strict managed reader HBA starts a new original postmaster, permits its exact database and refuses other databases',async()=>{
  const input=await options(),legacy={...input};delete legacy.reviewEvidence;await assert.rejects(launchPostgresLifecycleV1(legacy),/COLD_IMAGE_CONFIG/);
  const handle=await launch(input),binding=await bindPostgresLifecycleV2(handle);assert.equal(binding.pid,handle.process.pid);assert.equal(binding.systemIdentifier,cluster.systemIdentifier);assert.equal((await connect(readerRole,readerPassword,'postgres')).rows[0].role,readerRole);await assert.rejects(connect(readerRole,readerPassword,'template1'),error=>error.code==='28000');
  const proof=await normalStop(handle);assert.equal(proof.terminal.code,0);assert.equal(proof.mode,'smart');assert.equal(handle.helperAttempts,1);
});
test('wrong authenticated HBA bytes reject before a new postmaster or process record is created',async()=>{
  const input=await options();input.reviewEvidence.readerHba.sha256='0'.repeat(64);await assert.rejects(launchPostgresLifecycleV2(input),/COLD_REVIEW_IMAGE_HBA_CHANGED/);assert.equal(handles.length,1);
});
test('rehashing an added permissive trust rule cannot bypass the original loopback SCRAM profile',async()=>{
  const input=await options(),file=join(input.dataDirectory,'pg_hba.conf'),bytes=Buffer.concat([await readFile(file),Buffer.from('\nhost all all 0.0.0.0/0 trust\n')]);await writeFile(file,bytes);input.reviewEvidence.readerHba.sha256=sha(bytes);await assert.rejects(launchPostgresLifecycleV2(input),/COLD_IMAGE_CONFIG/);assert.equal(handles.length,1);
});
test('runtime HBA drift and copied handles send no stop, then one original smart stop retires the actual handle',async()=>{
  const input=await options(),handle=await launch(input),file=join(input.dataDirectory,'pg_hba.conf'),bytes=await readFile(file);await assert.rejects(inspectPostgresLifecycleV2({...handle}),/PG_LIFECYCLE_HANDLE/);
  await writeFile(file,Buffer.concat([bytes,Buffer.from('\n# controlled owned QA drift\n')]));await assert.rejects(stopPostgresLifecycleV2(handle,{requestId:randomUUID()}),/COLD_REVIEW_IMAGE_HBA_CHANGED/);assert.equal(handle.helperAttempts,0);assert.equal(handle.process.exitCode,null);assert.equal(handle.process.signalCode,null);await writeFile(file,bytes);
  const requestId=randomUUID(),proof=await stopPostgresLifecycleV2(handle,{requestId});assert.equal(await stopPostgresLifecycleV2(handle,{requestId}),proof);assert.equal(handle.helperAttempts,1);assert.equal(proof.terminal.pid,handle.process.pid);assert(proof.terminal.proofSaved&&!proof.genericKillUsed);
});
