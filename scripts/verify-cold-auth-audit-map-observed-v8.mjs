import {collectOwnedReaderJvmFailureQaV1} from './fixtures/owned-reader-jvm-failure-v4-qa.mjs';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {coldAuthAuditMapProgressQaV3} from './fixtures/cold-auth-audit-map-progress-v3-qa.mjs';
/** Linux CI observation only; only fixed Java failure diagnostics and complete owned-map import bindings are added; every check remains. */
assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.argv.length,9);
const innerNativeEntrySha256='c137eabdba3148571d56c6518300fb2b95b035851af5fcba3d978c6524901002',observerSourceSha256='a8c3c63f1817dc7ee0544c2b5e4582fec83c5d0dc207afe4c1f1e2ccd0593523',expectedEntrySha256='178f35e8185093dfd5fd64117ec1389ed99ed6d4d22063166e3f30156a91bf4c';
const entry=resolve('scripts/verify-cold-auth-audit-map-diagnostic-bootstrap-v2.mjs'),sha=b=>createHash('sha256').update(b).digest('hex'),entrySha256=sha(await readFile(entry));
assert.equal(entrySha256,expectedEntrySha256);
const child=spawn(process.execPath,[entry,...process.argv.slice(2)],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
const decoder=new StringDecoder('utf8');
let finished=false,reading=false,observationFailed=false,nonce=null,checks=0,lastOutputAt=null,started=false,final=null,buffer='',spawnError=false,stdoutOverflow=false,bootstrapObservation=null;
const consume=data=>{
 lastOutputAt=new Date().toISOString();buffer+=decoder.write(data);if(buffer.length>1024**2){stdoutOverflow=true;buffer='';}
 let end;while((end=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
  process.stdout.write(line+'\n');
  try{
   const v=JSON.parse(line);
   if(v.nativeStarted===true&&v.pid===child.pid&&v.sourcePins===1763&&v.expectedChecks===57&&/^[a-f0-9]{12}$/.test(v.nonce)){nonce=v.nonce;started=true;}
   if(v.nonce===nonce&&Number.isInteger(v.check)&&v.check===checks+1)checks=v.check;
   if(v.format==='COLD_AUTH_AUDIT_MAP_DIAGNOSTIC_BOOTSTRAP_V1'&&v.nativePid===child.pid&&v.innerNativeEntrySha256===innerNativeEntrySha256&&v.observerSourceSha256===observerSourceSha256&&v.rawArgumentsOrCredentialsPrinted===false&&v.innerNativeRestarted===false)bootstrapObservation=v;
   if(v.nonce===nonce&&typeof v.passed==='boolean'&&v.checks===57)final={passed:v.passed,checks:v.checks,cleanupErrorCount:v.cleanupErrorCount};
  }catch{}
 }
};
child.stdout.on('data',consume);child.stderr.on('data',b=>process.stderr.write(b));child.once('error',()=>{spawnError=true;});
const native=new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal})));
const observe=async()=>{
 if(reading||finished)return;reading=true;
 try{
  let files=null;if(nonce)files=await coldAuthAuditMapProgressQaV3(resolve('.'),nonce);
  console.log(JSON.stringify({format:'COLD_AUTH_AUDIT_MAP_ORIGINAL_JOB_PROGRESS_V1',phase:child.exitCode===null?'RUNNING':'DRAINING',nonce,checks,lastNativeOutputAt:lastOutputAt,originalNativeHandleHeld:true,files}));
 }catch{observationFailed=true;console.log(JSON.stringify({format:'COLD_AUTH_AUDIT_MAP_PROGRESS_OBSERVATION_UNAVAILABLE_V1',nativeRestarted:false}));}
 finally{reading=false;}
};
const timer=setInterval(observe,30000);timer.unref();
try{
 const exit=await native;finished=true;clearInterval(timer);
 if(exit.code!==0&&nonce){try{const observation=await collectOwnedReaderJvmFailureQaV1(resolve('.'),nonce,{nativePid:child.pid,nativeEntrySha256:innerNativeEntrySha256,nativeEntryPath:'scripts/verify-cold-auth-audit-map-v6-attach-diagnostic-v1.mjs',observedChecks:checks});console.log(JSON.stringify(observation));}catch{observationFailed=true;console.log(JSON.stringify({format:'OWNED_READER_JVM_FAILURE_OBSERVATION_UNAVAILABLE_V1',nonce,nativeRestarted:false,readerRestarted:false,rawLogsOrCredentialsPrinted:false}));}}
 assert(bootstrapObservation?.helperObservation?.format==='OWNED_READER_HELPER_CHILD_OBSERVATION_V1'&&bootstrapObservation.helperObservation.observedHelpers>0&&bootstrapObservation.helperObservation.allOriginalHelperHandlesClosed&&!bootstrapObservation.helperObservation.observationFailed&&!bootstrapObservation.helperObservation.spawnOrExecReplaced&&!bootstrapObservation.helperObservation.signalsSent&&!bootstrapObservation.helperObservation.rawArgumentsOrCredentialsPrinted,'COLD_REVIEW_HELPER_OBSERVATION_UNCONFIRMED');
 assert.equal(sha(await readFile('scripts/verify-cold-auth-audit-map-v6-attach-diagnostic-v1.mjs')),innerNativeEntrySha256);assert.equal(sha(await readFile('scripts/fixtures/owned-reader-jvm-failure-v4-qa.mjs')),observerSourceSha256);
 assert(!spawnError&&!stdoutOverflow&&started&&checks===57&&final?.passed&&final.cleanupErrorCount===0&&exit.code===0&&exit.signal===null&&child.stdout.closed&&child.stderr.closed&&sha(await readFile(entry))===entrySha256,'COLD_REVIEW_ORIGINAL_NATIVE_TERMINAL');
 console.log(JSON.stringify({format:'COLD_AUTH_AUDIT_MAP_ORIGINAL_JOB_EXIT_V1',nonce,checks,actualZeroExit:true,originalChildAndBothStreamsClosed:true,entrySha256,innerNativeEntrySha256,observerSourceSha256,entryUnchanged:true,observationFailed,rawBusinessOrCredentialsPrinted:false}));
}finally{finished=true;clearInterval(timer);}
