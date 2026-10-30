import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {readApplicationFileV1} from '../runtime-application-config-v1.mjs';
import {probeOwnedVerificationJobV1} from '../owned-verification-job-v1.mjs';
import {probeOwnedVerificationJobV2} from '../owned-verification-job-v2.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),read=async f=>JSON.parse(await readFile(f,'utf8'));
const exact=(v,keys)=>assert.deepEqual(Object.keys(v).sort(),[...keys].sort());
const account=()=>String(process.env.USERDOMAIN??'')+'\\'+String(process.env.USERNAME??process.env.USER??'');
const inside=(root,path)=>{assert(isAbsolute(path));const part=relative(root,path);assert(part&&!part.startsWith('..')&&!isAbsolute(part));};

/** Authenticating a recorded original job grants no process, SQL or business capability. */
export async function readColdCoreFieldOwnedNativeCaseQaV2(launchFile){
 const root=resolve('.');assert(typeof launchFile==='string'&&resolve(launchFile)===launchFile);inside(resolve('work'),launchFile);
 const launch=JSON.parse((await readApplicationFileV1(launchFile)).bytes.toString('utf8'));
 exact(launch,['jobId','directory','file','supervisorFile','inputSha256']);assert.match(launch.jobId,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);assert.match(launch.inputSha256,/^[a-f0-9]{64}$/);
 assert.equal(launch.directory,resolve('work','verification-job-'+launch.jobId));assert.equal(launch.file,join(launch.directory,'job.private.json'));
 const jobFile=await readApplicationFileV1(launch.file),e=JSON.parse(jobFile.bytes.toString('utf8'));assert.equal(jobFile.sha256,launch.inputSha256);
 exact(e,['format','purpose','jobId','accountName','workingDirectory','entryFile','entrySha256','nodeSha256','supervisorSha256','arguments','probeKey']);
 assert.equal(e.format,1);assert.equal(e.purpose,'IDMS_OWNED_VERIFICATION_JOB_V1');assert.equal(e.jobId,launch.jobId);assert.equal(e.accountName,account());assert.equal(e.workingDirectory,root);assert.equal(e.entryFile,resolve('scripts/verify-cold-core-field-composition-native-v17.mjs'));
 assert.equal(e.entrySha256,(await readApplicationFileV1(e.entryFile)).sha256);assert.equal(e.nodeSha256,sha(await readFile(process.execPath)));assert(Array.isArray(e.arguments)&&e.arguments.length===8&&e.arguments.every(v=>typeof v==='string'&&v.length>0));assert.match(e.arguments[5],/^[a-f0-9]{64}$/);
 const portable=launch.supervisorFile===resolve('scripts/owned-verification-job-v2.mjs');assert(portable||(process.platform==='win32'&&launch.supervisorFile===resolve('scripts/owned-verification-job-v1.mjs')));assert.equal(e.supervisorSha256,(await readApplicationFileV1(launch.supervisorFile)).sha256);
 const originalTerminal=await (portable?probeOwnedVerificationJobV2:probeOwnedVerificationJobV1)(launch.file),originalHost=await read(join(launch.directory,'supervisor-original-handle-exit.private.json'));
 assert.equal(originalTerminal.jobId,launch.jobId);assert.equal(originalTerminal.inputSha256,launch.inputSha256);assert.equal(originalTerminal.phase,'CLOSED');assert(originalTerminal.normal&&originalTerminal.originalChildHandleHeld&&originalTerminal.stdoutClosed&&originalTerminal.stderrClosed&&originalTerminal.entryUnchanged&&originalTerminal.supervisorUnchanged);assert.deepEqual(originalTerminal.exit,{code:0,signal:null});assert.equal(originalTerminal.checkCount,64);assert.match(originalTerminal.nonce,/^[a-f0-9]{12}$/);
 assert(originalHost.actualOriginalHandleExitObserved&&originalHost.exitCode===0);
 if(portable){
  const start=await read(join(launch.directory,'portable-host-start.private.json'));
  assert.equal(originalHost.format,'IDMS_PORTABLE_VERIFICATION_SUPERVISOR_ACTUAL_EXIT_V1');assert.equal(originalHost.observedProcessKind,'ORIGINAL_SUPERVISOR_CHILD');
  assert.equal(originalHost.pid,originalTerminal.supervisorPid);assert.equal(originalHost.jobId,launch.jobId);assert.equal(originalHost.inputSha256,launch.inputSha256);assert.equal(originalHost.signal,null);assert(originalHost.normalHostClose&&originalHost.terminalAuthenticated&&originalHost.originalRootNormal&&originalHost.stdoutClosed&&originalHost.stderrClosed&&!originalHost.spawnFailed&&!originalHost.overflow&&!originalHost.genericKillUsed);assert.deepEqual(originalHost.originalRootExit,originalTerminal.exit);
  assert.equal(start.format,'IDMS_PORTABLE_SUPERVISOR_START_V1');assert.equal(start.jobId,launch.jobId);assert.equal(start.inputSha256,launch.inputSha256);assert.equal(start.parentPid,originalHost.parentPid);assert.equal(start.newChildOnly,true);assert.equal(start.parentSourceSha256,originalHost.parentSourceSha256);assert.equal(originalHost.parentSourceSha256,(await readApplicationFileV1(resolve('scripts/start-owned-verification-job-portable-v1.mjs'))).sha256);assert.equal(originalHost.nodeSha256,e.nodeSha256);assert.equal(originalHost.supervisorSha256,e.supervisorSha256);
 }
 const nonce=originalTerminal.nonce,work=resolve('work/ccf-native-v17-20261027',nonce),reportFile=join(work,'verification.json'),reportBytes=await readFile(reportFile),r=JSON.parse(reportBytes),pins=await read(join(work,'native-input-pins.json'));
 assert.equal(r.format,'IDMS_COLD_CORE_FIELD_COMPOSITION_NATIVE_QA_V5');assert.equal(r.implementationVersion,17);assert.equal(r.nonce,nonce);assert.equal(r.rootPid,originalTerminal.nativePid);assert.equal(pins.nonce,nonce);assert.deepEqual(r.sourcePins,pins.sourcePins);assert.equal(r.sourcePins.length,1472);assert(r.passed&&r.checks.length===64&&r.cleanup.allNodeChildrenTerminal);assert.deepEqual(r.cleanup.errors,[]);
 assert.equal(resolve(r.sourceBundle.file),resolve(e.arguments[4]));assert.equal(r.sourceBundle.sha256,e.arguments[5]);assert.equal(sha(await readFile(r.sourceBundle.file)),e.arguments[5]);
 for(const pin of pins.sourcePins){const file=resolve(pin.path);inside(root,file);assert.equal(sha(await readFile(file)),pin.sha256);}
 return{launch,originalTerminal,originalHost,work,r,pins,reportSha256:sha(reportBytes),portableOriginalSupervisorChain:portable,actualLinuxExecution:process.platform==='linux'};
}
