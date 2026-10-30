import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {coldOwnedReviewProgressQaV1} from './fixtures/cold-plan-journal-progress-v3-qa.mjs';
/** Linux CI observation only; the original native entry and every check are unchanged. */
assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.argv.length,9);
const entry=resolve('scripts/verify-cold-plan-journal-v3.mjs'),sha=b=>createHash('sha256').update(b).digest('hex'),entrySha256=sha(await readFile(entry));
const child=spawn(process.execPath,[entry,...process.argv.slice(2)],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
const decoder=new StringDecoder('utf8');
let finished=false,reading=false,observationFailed=false,nonce=null,checks=0,lastOutputAt=null,started=false,final=null,buffer='',spawnError=false,stdoutOverflow=false;
const consume=data=>{
 lastOutputAt=new Date().toISOString();buffer+=decoder.write(data);if(buffer.length>1024**2){stdoutOverflow=true;buffer='';}
 let end;while((end=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
  process.stdout.write(line+'\n');
  try{
   const v=JSON.parse(line);
   if(v.nativeStarted===true&&v.pid===child.pid&&v.sourcePins===1570&&v.expectedChecks===43&&/^[a-f0-9]{12}$/.test(v.nonce)){nonce=v.nonce;started=true;}
   if(v.nonce===nonce&&Number.isInteger(v.check)&&v.check===checks+1)checks=v.check;
   if(v.nonce===nonce&&typeof v.passed==='boolean'&&v.checks===43)final={passed:v.passed,checks:v.checks,cleanupErrorCount:v.cleanupErrorCount};
  }catch{}
 }
};
child.stdout.on('data',consume);child.stderr.on('data',b=>process.stderr.write(b));child.once('error',()=>{spawnError=true;});
const native=new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal})));
const observe=async()=>{
 if(reading||finished)return;reading=true;
 try{
  let files=null;if(nonce)files=await coldOwnedReviewProgressQaV1(resolve('.'),nonce);
  console.log(JSON.stringify({format:'COLD_OWNED_REVIEW_ORIGINAL_JOB_PROGRESS_V1',phase:child.exitCode===null?'RUNNING':'DRAINING',nonce,checks,lastNativeOutputAt:lastOutputAt,originalNativeHandleHeld:true,files}));
 }catch{observationFailed=true;console.log(JSON.stringify({format:'COLD_OWNED_REVIEW_PROGRESS_OBSERVATION_UNAVAILABLE_V1',nativeRestarted:false}));}
 finally{reading=false;}
};
const timer=setInterval(observe,30000);timer.unref();
try{
 const exit=await native;finished=true;clearInterval(timer);
 assert(!spawnError&&!stdoutOverflow&&started&&checks===43&&final?.passed&&final.cleanupErrorCount===0&&exit.code===0&&exit.signal===null&&child.stdout.closed&&child.stderr.closed&&sha(await readFile(entry))===entrySha256,'COLD_REVIEW_ORIGINAL_NATIVE_TERMINAL');
 console.log(JSON.stringify({format:'COLD_OWNED_REVIEW_ORIGINAL_JOB_EXIT_V1',nonce,checks,actualZeroExit:true,originalChildAndBothStreamsClosed:true,entrySha256,entryUnchanged:true,observationFailed,rawBusinessOrCredentialsPrinted:false}));
}finally{finished=true;clearInterval(timer);}
