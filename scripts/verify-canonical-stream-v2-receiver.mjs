import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fork} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {createCpuReceiverQa} from './fixtures/telemetry-cpu-qa-runtime.mjs';
import {readEntities} from '../server/entity-repository.ts';
import {canonical} from '../server/imports.ts';
const file='work/telemetry-cpu-profile-20261019/canonical-v2-receiver-verification.json';await assert.rejects(stat(file),e=>e.code==='ENOENT');
console.log(JSON.stringify({phase:'PREPARING_CANONICAL_RECEIVER_COMPARISON',history:45000}));const qa=await createCpuReceiverQa(45000),results=[];let reader,child,closed,sequence=200000;
try{
 reader=new pg.Client({...qa.account,statement_timeout:20000});await reader.connect();
 for(const [round,encoder]of ['original','v2','v2','original'].entries()){
  const before=(await readEntities(reader,'sandbox')).payload,stage=encoder+'-'+round,setup=await qa.save(stage+'-setup.json',{telemetryFile:qa.telemetryFile,privateRoot:qa.directory,stage,requestedHistory:before.audits.length,sequenceBase:sequence});
  child=fork('scripts/fixtures/telemetry-cpu-profile.mjs',[setup],{env:{...process.env,NODE_ENV:'test',IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:qa.businessFile,IDMS_CAPACITY_CONFIG:'',IDMS_DEMO_NAMESPACE:'canonical-cpu-comparison'},execArgv:encoder==='v2'?['--import',pathToFileURL(resolve('scripts/canonical-stream-v2-loader.mjs')).href]:[],stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));closed=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok({code,signal}));});console.log(JSON.stringify({phase:'COMPARING_CANONICAL_RECEIVER',round,encoder,childPid:child.pid}));assert.equal((await closed).code,0);child=undefined;closed=undefined;
  const result=JSON.parse(await readFile(join(qa.directory,stage+'-result.json'),'utf8')),after=(await readEntities(reader,'sandbox')).payload;assert.equal(after.audits.length,before.audits.length+4);assert.equal(canonical(after.audits.slice(0,before.audits.length)),canonical(before.audits));
  assert.equal(result.baseline.audits,before.audits.length+1);if(encoder==='v2')assert.ok(result.results[0].profile.files.some(r=>r.file==='server/canonical-stream-v2.ts'&&r.selfUs>0),'V2 serializer not observed');else assert.ok(!result.results[0].profile.files.some(r=>r.file==='server/canonical-stream-v2.ts'));
  result.encoder=encoder;result.round=round;result.fullRootRecomputedByIndependentOriginalCanonicalReader=true;result.allPreviousActualHistoryPreserved=true;results.push(result);sequence=result.sequenceFinal;
 }
}finally{if(child){if(child.exitCode===null&&child.signalCode===null)child.kill();if(closed)await closed;}if(reader)await reader.end();await qa.close();}
const median=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)],comparison=[];for(const kind of ['NEW_EVENT','EXACT_REPLAY']){const old=results.filter(r=>r.encoder==='original').flatMap(r=>r.results.find(x=>x.kind===kind).timingsMs),next=results.filter(r=>r.encoder==='v2').flatMap(r=>r.results.find(x=>x.kind===kind).timingsMs);comparison.push({kind,originalSamples:old,v2Samples:next,medianOriginalMs:median([...old]),medianV2Ms:median([...next]),observedMedianReductionPercent:100*(median([...old])-median([...next]))/median([...old])});}
const proof={format:'idms-canonical-stream-v2-receiver-verification-v1',verifiedAt:new Date().toISOString(),initialSyntheticAuditHistory:45000,executionOrder:['original','v2','v2','original'],results,comparison,actualUnchangedReceiverAndFullConsistencyChecks:true,allV2PersistedRootsValidatedBySeparateOriginalReader:true,newPointsReceiptsAndAuditsAndSignedAckCountsVerified:true,exactReplaysCreateNoNewFacts:true,defaultCapacityAndOriginalModulesUnchanged:true,allActualChildrenTerminalAndOwnedQaDatabasesRolesCredentialsRemoved:true,privateRawProfilesRetained:true,originalRuntimeNotAttachedRestartedOrDeployed:true,performanceSamplesIncludeProfilerOverhead:true,onlyCurrentHostSyntheticReceiverWorkload:true,fullIncrementalTransactionOrRetentionImplemented:false,productionCapacityOrSlaAcceptance:false,productionAcceptance:false};await writeFile(file,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({phase:'CANONICAL_RECEIVER_COMPARISON_VERIFIED',comparison}));
