import assert from 'node:assert/strict';
import {readFile,appendFile,lstat,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {canonical} from '../server/imports.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {createOwnedVerificationJobV2,probeOwnedVerificationJobV2} from './owned-verification-job-v2.mjs';
import {startOwnedVerificationJobPortableV1} from './start-owned-verification-job-portable-v1.mjs';
import {readColdCoreFieldOwnedNativeCaseQaV4} from './fixtures/cold-core-field-owned-native-case-v4-qa.mjs';
import {readCurrentDeploymentOriginalPeerEvidenceIndependentQaV1} from './fixtures/current-deployment-control-independent-v3-qa.mjs';
import {readRuntimeColdReviewWithFieldSourceV2} from './runtime-cold-readonly-control-v7.mjs';
const read=async file=>JSON.parse(await readFile(file,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const identity=s=>Object.fromEntries(['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])]));
let phase,publicDirectory,lastJob;
async function savePublic(name,value){assert(['native-summary-v1.json','independent-summary-v1.json','ci-summary-v1.json','failure-summary-v1.json'].includes(name));await privateNewFile(join(publicDirectory,name),JSON.stringify(value,null,2));}
async function runOwned(entryFile,args,label){
 const job=await createOwnedVerificationJobV2({workingDirectory:resolve('.'),entryFile:resolve(entryFile),args,workDirectory:resolve('work')});lastJob=job;
 const launchFile=join(phase,label+'-launch.private.json');await privateNewFile(launchFile,JSON.stringify(job,null,2));
 let probing=false;const timer=setInterval(async()=>{if(probing)return;probing=true;try{const p=await probeOwnedVerificationJobV2(job.file);console.log(JSON.stringify({format:'COLD_CURRENT_DEPLOYMENT_CI_PROGRESS_V2',stage:label,phase:p.phase,checks:p.checkCount}));}catch{console.log(JSON.stringify({format:'COLD_CURRENT_DEPLOYMENT_CI_PROGRESS_V2',stage:label,observationTemporarilyUnavailable:true}));}finally{probing=false;}},15000);
 let result;try{result=await startOwnedVerificationJobPortableV1(job.file);}finally{clearInterval(timer);}
 assert(result.normal&&result.host.normalHostClose&&result.host.terminalAuthenticated&&result.originalRoot.normal,'CURRENT_DEPLOYMENT_CI_OWNED_ROOT_NOT_NORMAL');
 return{job,launchFile,result};
}
async function runUnits(file,count,tag,env={}){
 const child=spawn(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',file],{cwd:resolve('.'),windowsHide:true,env:{...process.env,...env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',spawnFailed=false,overflow=false;child.once('error',()=>{spawnFailed=true;});
 child.stdout.on('data',b=>{if(Buffer.byteLength(stdout)+b.length<=4*1024**2)stdout+=b.toString('utf8');else overflow=true;});child.stderr.on('data',b=>{if(Buffer.byteLength(stderr)+b.length<=4*1024**2)stderr+=b.toString('utf8');else overflow=true;});
 const terminal=await new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed,spawnFailed,overflow})));
 await privateNewFile(join(phase,tag+'.private.json'),JSON.stringify({originalChildPid:child.pid??null,terminal,stdout,stderr},null,2));
 assert.deepEqual(terminal,{code:0,signal:null,stdoutClosed:true,stderrClosed:true,spawnFailed:false,overflow:false});
 const counter=(name,expected)=>{const found=[...stdout.matchAll(new RegExp('^# '+name+' ([0-9]+)$','gm'))];assert.equal(found.length,1);assert.equal(Number(found[0][1]),expected);};
 counter('tests',count);counter('pass',count);for(const name of ['fail','cancelled','skipped','todo'])counter(name,0);return{tag,tests:count,actualNormalExitAndBothStreamsClosed:true};
}
async function main(){
 assert.equal(process.platform,'linux','CURRENT_DEPLOYMENT_CI_REQUIRES_ACTUAL_LINUX');assert.equal(process.argv.length,10);assert.match(process.env.GITHUB_SHA??'',/^[a-f0-9]{40}$/);
 const args=process.argv.slice(2);assert(args.every(v=>typeof v==='string'&&v.length>0));assert.match(args[5],/^[a-f0-9]{64}$/);
 phase=resolve('work/current-deployment-ci-v2',randomUUID());await privateDirectory(phase);publicDirectory=join(phase,'public');await privateDirectory(publicDirectory);
 assert(process.env.GITHUB_OUTPUT);await appendFile(process.env.GITHUB_OUTPUT,'public_result_directory='+publicDirectory+'\n');
 const native=await runOwned('scripts/verify-cold-core-field-composition-native-v23.mjs',args,'native');
 const original=await readColdCoreFieldOwnedNativeCaseQaV4(native.launchFile);assert(original.actualLinuxExecution&&original.portableOriginalSupervisorChain);
 await savePublic('native-summary-v1.json',{format:'COLD_CURRENT_DEPLOYMENT_CI_NATIVE_SUMMARY_V2',commit:process.env.GITHUB_SHA,nodeVersion:process.version,actualLinuxExecuted:true,originalOwnedRootNormalExitAndBothStreamsClosed:true,originalSupervisorNormalExitAndBothStreamsClosed:true,actualOriginalRootChecks:66,sourcePins:1534,producerOnly:true,completeIndependentAcceptedAtThisStage:false,sourceReportSha256:original.reportSha256,completeCases:2,physicalFieldAttested:false,newHeldOrProgramApprovalProven:false,fullGoalComplete:false});
 const independentDirectory=join(phase,'independent');await runOwned('scripts/verify-cold-core-field-composition-portable-independent-v4.mjs',[native.launchFile,independentDirectory],'independent');
 const independent=await read(join(independentDirectory,'public-summary-v1.json'));assert(independent.actualLinuxExecuted&&independent.portableOriginalSupervisorChain&&independent.originalNativeChecks===66&&independent.originalSourcePinsVerified===1534&&independent.original64ChecksExactlyRetained&&independent.original62ChecksExactlyRetained&&independent.original60ChecksExactlyRetained&&independent.independentReaderInstallationCases===2&&independent.additionalReaderInstallationRawIdentityRecords===24&&independent.completePreflightEvidenceFilesIndependentlyRebuilt===8&&independent.actualPreflightWorkerRecordsIndependentlyBound===8&&independent.completeCases===2&&independent.original58ChecksExactlyRetained);assert.equal(independent.originalSourceReportSha256,original.reportSha256);
 // This source file constructs the bounded whitelist summary; never copy private results or logs.
 await savePublic('independent-summary-v1.json',independent);
 const selected=original.r.fieldCurrentMaterialsNative.cases.find(v=>v.mode==='ENABLED');assert(selected);const state=await readRuntimeColdReviewWithFieldSourceV2(selected.trust),peers=await readCurrentDeploymentOriginalPeerEvidenceIndependentQaV1(selected,state);
 const storeBefore=await readFile(selected.trust.storeFile),storeIdentity=identity(await lstat(selected.trust.storeFile,{bigint:true})),unitWork=join(phase,'unit-work');await privateDirectory(unitWork);
 const fixtureFile=join(phase,'contract-context-fixture.private.json');await privateNewFile(fixtureFile,JSON.stringify({context:{trust:selected.trust,source:state.source,originalReview:state.details.review,targetDirectory:selected.targetDirectory,host:'127.0.0.1',port:peers.serverPort,deploymentSha256:sha(await readFile(selected.coreConfigurationFile)),programInventorySha256:sha(canonical(selected.currentDeploymentControl.programInputInventory))},workDirectory:unitWork,oldHeldEvidence:selected.sessionHeld,fixtureIsHistoricalSourceDataOnly:true,noFreshSqlOidcOrHeldCreated:true},null,2));
 const recordedFixture=join(phase,'recorded-case-fixture.private.json');await privateNewFile(recordedFixture,JSON.stringify({format:'COLD_SYMBOLIC_CONSUMER_RECORDED_INPUT_V1',caseDirectory:original.work,reportSha256:original.reportSha256,offlineOnly:true,currentLinuxRuntimeProof:false}));
 const results=[];
 results.push(await runUnits('tests/cold-current-deployment-review-contract-v1.test.mjs',14,'contract-units',{IDMS_CURRENT_DEPLOYMENT_CONTRACT_FIXTURE:fixtureFile}));
 results.push(await runUnits('tests/cold-current-deployment-context-files-v5.component.mjs',22,'context-file-units',{IDMS_CURRENT_DEPLOYMENT_CONTEXT_FILE_FIXTURE:fixtureFile}));
 results.push(await runUnits('tests/cold-current-deployment-control-request-v1.test.mjs',4,'control-request-units'));
 results.push(await runUnits('tests/current-deployment-control-independent-v3.component.mjs',4,'metadata-independent-units',{IDMS_CURRENT_DEPLOYMENT_INDEPENDENT_FIXTURE:recordedFixture}));
 results.push(await runUnits('tests/cold-symbolic-program-consumer-v1.component.mjs',12,'symbolic-permission-units',{IDMS_SYMBOLIC_CONSUMER_FIXTURE:recordedFixture}));
 results.push(await runUnits('tests/controlled-cold-stage-diagnostic-v6.test.mjs',3,'current-stage-units'));
 const preflight=state.details.currentDeploymentReaderInstallationPreflight.body;assert(preflight.format==='CURRENT_DEPLOYMENT_INSTALL_PREFLIGHT_V2'&&preflight.fullFactsCheck.maps.length===2);const fixedPrograms=['scripts/field-map-full-evidence-worker-entry-v2.mjs','scripts/field-map-full-evidence-worker-owner-v3.mjs','scripts/field-map-full-evidence-fast-v1.mjs','scripts/field-map-equivalent-hash-v2.mjs'],programPins=fixedPrograms.map(path=>{const matches=original.r.sourcePins.filter(p=>p.path===path);assert.equal(matches.length,1,'CI_FIXED_WORKER_PROGRAM_MUST_HAVE_ORIGINAL_SOURCE_PIN');return matches[0];}),fastWork=join(phase,'complete-fast-evidence-units'),fastInput=join(phase,'complete-fast-evidence-input.private.json'),nativeEnvelope=await read(native.job.file);assert.equal(nativeEnvelope.nodeSha256,sha(await readFile(process.execPath)));await privateNewFile(fastInput,JSON.stringify({format:'FIELD_MAP_FAST_EVIDENCE_COMPONENT_INPUT_V1',workDirectory:fastWork,maps:preflight.fullFactsCheck.maps,sourcePins:programPins,nodeSha256:nativeEnvelope.nodeSha256},null,2));
 results.push(await runUnits('tests/field-map-fast-evidence-v1.component.mjs',25,'complete-fast-evidence-units',{IDMS_FAST_EVIDENCE_COMPONENT_INPUT:fastInput}));const fastResult=await read(join(fastWork,'component-result-v1.json'));assert(fastResult.actualNewOriginalWorkers===2&&fastResult.corruptionResults.length===14&&fastResult.allNewOriginalWorkersNormallyClosed&&fastResult.oldFullSourceEvidenceBytesAndIdentitiesUnchanged&&fastResult.allPrivateVerifierCachesRetired&&!fastResult.actualSqlOidcOrTransportReplayed);
 assert.equal(results.reduce((n,v)=>n+v.tests,0),84);assert.deepEqual(await readdir(unitWork),[]);assert.equal(sha(await readFile(selected.trust.storeFile)),sha(storeBefore));assert.deepEqual(identity(await lstat(selected.trust.storeFile,{bigint:true})),storeIdentity);
 assert.equal(sha(await readFile(join(original.work,'verification.json'))),original.reportSha256);for(const pin of original.r.sourcePins)assert.equal(sha(await readFile(pin.path)),pin.sha256);
 const summary={format:'COLD_CURRENT_DEPLOYMENT_CI_COMPLETE_SUMMARY_V2',commit:process.env.GITHUB_SHA,nodeVersion:process.version,actualLinuxExecuted:true,nativeChecks:66,originalSourcePins:1534,independentCompleteCases:2,original64ChecksExactlyRetained:true,independentReaderInstallationCases:2,additionalReaderInstallationRawIdentityRecords:24,completePreflightEvidenceFilesIndependentlyRebuilt:8,actualPreflightWorkerRecordsIndependentlyBound:8,independentProgramAndOwnerDecisionsPerCase:138417,additionalTestsPassed:84,unitGroups:results,allOriginalChildrenAndSupervisorsNormallyClosed:true,allOriginalSourceBytesAndReportUnchanged:true,originalSourceStoreBytesAndIdentityUnchanged:true,original58ChecksExactlyRetained:true,sourceReportSha256:original.reportSha256,newHeldOrProgramApprovalProven:false,mqttApplicationAclProven:false,physicalFieldAttested:false,formalFieldActivationGranted:false,fullGoalComplete:false};await savePublic('ci-summary-v1.json',summary);console.log(JSON.stringify(summary));
}
main().catch(async error=>{
 const reason=/^[A-Z][A-Z0-9_]{3,120}$/.test(error.message)?error.message:'CURRENT_DEPLOYMENT_CI_CHECK_FAILED';
 if(publicDirectory)try{let observation=null;try{if(lastJob)observation=await probeOwnedVerificationJobV2(lastJob.file);}catch{}
  await savePublic('failure-summary-v1.json',{format:'COLD_CURRENT_DEPLOYMENT_CI_FAILURE_SUMMARY_V2',commit:/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??'')?process.env.GITHUB_SHA:null,reason,originalJobPhase:observation?.phase??null,originalJobRootExitCode:observation?.exit?.code??null,originalJobRootSignal:observation?.exit?.signal??null,originalJobNormal:observation?.normal??false,originalJobCheckCount:observation?.checkCount??null,rawLogsOrPrivateInputsPublished:false,fullGoalComplete:false});
 }catch{}console.error(reason);process.exitCode=1;
});
