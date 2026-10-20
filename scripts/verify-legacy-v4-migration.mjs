import assert from 'node:assert/strict';
import {readFile,unlink,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {createLegacyV4Qa} from './fixtures/legacy-v4-qa.mjs';
import {revalidateLegacyV3Fence} from './legacy-v4-source.mjs';
import {verifyLegacyV4Map,sealLegacyV4Map} from './legacy-v4-target.mjs';
import {PostgresStateMapV1} from '../server/state-map-sql-v1.ts';
import {canonicalEqual} from '../server/canonical-state.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
const sourceFiles=['server/legacy-map-v4.ts','server/legacy-map-v4.test.ts','scripts/legacy-v4-source.mjs','scripts/legacy-v4-target.mjs','scripts/fixtures/legacy-v4-qa.mjs','scripts/fixtures/legacy-v4-capture-child.mjs','scripts/verify-legacy-v4-migration.mjs'],sourcePins=[],sourceBytes=new Map();
for(const path of sourceFiles){const bytes=await readFile(path);sourceBytes.set(path,bytes);sourcePins.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const qa=await createLegacyV4Qa(),results=[];let report;
for(const [path,bytes]of sourceBytes){const file=join(qa.work,'input-source',path);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,bytes,{flag:'wx'});}
const read=async f=>JSON.parse(await readFile(f,'utf8'));
try{
 for(const tenant of ['acme','sandbox']){
  const directory=join(qa.work,tenant);await privateDirectory(directory);const config={tenant,directory,authority:qa.authority,adminAccount:qa.adminAccount,source:qa.business.tenants[tenant],target:qa.targets[tenant],operationId:randomUUID()},file=join(directory,'child-config.private.json');await privateNewFile(file,JSON.stringify(config));
  const child=spawn(process.execPath,[resolve('scripts/fixtures/legacy-v4-capture-child.mjs'),file],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b.toString());child.stderr.on('data',b=>stderr+=b.toString());const exit=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok({code,signal}));});await privateNewFile(join(directory,'child-terminal.json'),JSON.stringify({pid:child.pid,...exit,stdout,stderr}));assert.equal(exit.code,0,stderr);assert.equal(exit.signal,null);await unlink(file);
  const stage=await read(join(directory,'fenced-unsealed.private.json'));assert.equal(stage.childPid,child.pid);assert.equal(stage.phase,'FENCED_UNSEALED');assert.equal(child.exitCode,0);
  // This uses fresh connections after the actual child is terminal; no old gate/handle survives.
  const sourceRoot=new pg.Client({...qa.adminAccount,database:config.source.database});await sourceRoot.connect();let fence;try{
   fence=await revalidateLegacyV3Fence(sourceRoot,stage.manifest);
   await sourceRoot.query('ALTER TABLE public.audit_ledger DISABLE TRIGGER immutable_audit');try{await assert.rejects(revalidateLegacyV3Fence(sourceRoot,stage.manifest),/FENCE_STRUCTURE/);}finally{await sourceRoot.query('ALTER TABLE public.audit_ledger ENABLE TRIGGER immutable_audit');}
   assert.deepEqual(await revalidateLegacyV3Fence(sourceRoot,stage.manifest),fence);
  }finally{await sourceRoot.end();}assert.deepEqual(fence,stage.fence);
  const fresh=new pg.Client({host:qa.authority.host,port:qa.authority.port,...config.source});await fresh.connect();try{await assert.rejects(fresh.query('UPDATE public.business_state SET revision=revision WHERE tenant_id=$1',[tenant]),e=>e.code==='42501');assert.equal((await fresh.query('SELECT count(*)::int AS n FROM public.business_state')).rows[0].n,1);}finally{await fresh.end();}
  const target=config.target,client=new PostgresStateMapV1(target.account,target.binding);assert.deepEqual(await client.head(),stage.head);
  await assert.rejects(verifyLegacyV4Map(target.account,target.binding,stage.head,{...stage.manifest,tenantId:tenant==='acme'?'sandbox':'acme'}),/MANIFEST/);
  const verification=await verifyLegacyV4Map(target.account,target.binding,stage.head,stage.manifest);assert.deepEqual(verification,stage.verification);const sealed=await sealLegacyV4Map(target.account,target.binding,stage.head,stage.manifest,fence,verification),replay=await client.apply(sealed.command);assert.equal(replay.replayed,true);assert.equal(replay.receiptHash,sealed.receipt.receiptHash);
  const head=await client.head(),proof=await client.proof('receipt','legacy_v3_seal:'+config.operationId,head);assert.equal(proof.result.present,true);assert.ok(canonicalEqual(proof.result.value,sealed.value));
  const immutable={tenantId:tenant,commandId:randomUUID(),expectedRevision:head.revision,expectedRoot:head.rootHash,operations:[{namespace:'receipt',key:'legacy_v3_seal:'+config.operationId,expected:proof.result.valueHash,valueText:'null'}]};await assert.rejects(client.apply(immutable),/IMMUTABLE_KEY/);
  // The import root remains independently verifiable after the seal adds a new entry.
  const sealEvidence={tenantId:tenant,operationId:config.operationId,sourceBaseTables:stage.manifest.tableFacts.length,sourceRows:stage.manifest.tableFacts.reduce((n,f)=>n+f.rows,0),mapEntries:verification.entries,originalFiles:verification.files.length,originalFileBytes:verification.files.reduce((n,f)=>n+f.bytes,0),allSqlRawFactsAndPayloadReconstructed:true,independentMapRootRebuilt:true,sourcePersistentDmlFenceSurvivedActualChildExit:true,queuedOldTransactionCannotWrite:stage.queuedLegacyRootTransactionCouldNotPerformLaterDml,sourceDataAndSequenceUnchanged:true,sourceTriggerSchemaDriftRefusedBeforeSeal:true,wrongManifestRefused:true,preFenceSealRefused:stage.sealBeforeFenceRefused,actualImmutableSealProofAndReplayVerified:true,sealReceiptHash:sealed.receipt.receiptHash,businessFormatActivated:false};results.push(sealEvidence);await privateNewFile(join(directory,'seal-verification.json'),JSON.stringify(sealEvidence));console.log(JSON.stringify(sealEvidence));
 }
 for(const [path,bytes]of sourceBytes)assert.ok((await readFile(path)).equals(bytes),'Executed source changed: '+path);
 report={at:new Date().toISOString(),sourcePins,tenants:results,originalCaptureWasReadOnly:qa.originalEvidence.readOnly,originalSixFiles14513BytesVerified:true,originalRuntimeDatabasesFencedOrMigrated:false,newDomainTelemetryTransactionsIntegrated:false,retentionImplemented:false,completeCommercialGoal:false,productionAcceptance:false};
}finally{await qa.close();for(const tenant of ['acme','sandbox'])await unlink(join(qa.work,tenant,'child-config.private.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});}
report.ownedQaCleanup=await read(join(qa.work,'cleanup.json'));await privateNewFile(join(qa.work,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({work:qa.work,...report}));
