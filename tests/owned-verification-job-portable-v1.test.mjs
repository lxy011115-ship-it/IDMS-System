import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOwnedVerificationJobV1,probeOwnedVerificationJobV1} from '../scripts/owned-verification-job-v1.mjs';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';

const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function fixture(exitCode,delay=300){const directory=resolve('work/owned-verification-job-portable-v1-tests',randomUUID());await privateDirectory(directory);const entryFile=join(directory,'native.mjs');await privateNewFile(entryFile,`console.log(JSON.stringify({nativeStarted:true,nonce:'123456abcdef',pid:process.pid}));console.error('OWNED_QA_STDERR');await new Promise(ok=>setTimeout(ok,${delay}));console.log(JSON.stringify({check:1,nonce:'123456abcdef'}));process.exitCode=${exitCode};`);const job=await createOwnedVerificationJobV1({workingDirectory:resolve('.'),entryFile,args:[],workDirectory:process.platform==='win32'?directory:await mkdtemp(join(tmpdir(),'vj-'))}),child=spawn(process.execPath,[job.supervisorFile,'--supervise',job.file],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();const terminal=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok({code,signal}));});terminal.catch(()=>{});return{job,child,terminal};}
async function observed(file){const end=performance.now()+10000;while(performance.now()<end){try{return await probeOwnedVerificationJobV1(file,{timeoutMs:1000});}catch(e){if(!['VERIFICATION_JOB_PROBE_UNAVAILABLE','VERIFICATION_JOB_PROBE_EMPTY','VERIFICATION_JOB_PROBE_BINDING'].includes(e.message))throw e;}await sleep(30);}throw Error('JOB_NOT_OBSERVED');}

test('portable control directory: live authenticated probe identifies the held actual child and terminal proves actual output closure',async()=>{
 const h=await fixture(0,1200);const live=await observed(h.job.file);assert.equal(live.phase,'RUNNING');assert(live.originalChildHandleHeld&&live.nativePid>0);assert.equal(live.supervisorPid,h.child.pid);
 const e=JSON.parse(await readFile(h.job.file,'utf8')),endpoint=process.platform==='win32'?'\\\\.\\pipe\\idms-verification-'+e.jobId:join(h.job.directory,'control.sock');await new Promise((ok,no)=>{const socket=createConnection(endpoint);socket.once('error',no);socket.once('connect',()=>socket.end(JSON.stringify({body:{type:'PROBE',jobId:e.jobId,requestId:randomUUID()},signature:'0'.repeat(64)})+'\n'));socket.once('close',ok);});
 assert.deepEqual(await h.terminal,{code:0,signal:null});const terminal=await probeOwnedVerificationJobV1(h.job.file);assert(terminal.normal&&terminal.stdoutClosed&&terminal.stderrClosed&&terminal.entryUnchanged&&terminal.supervisorUnchanged&&terminal.probeSocketsRetired);assert.deepEqual(terminal.exit,{code:0,signal:null});assert.equal(terminal.nonce,'123456abcdef');assert.equal(terminal.checkCount,1);assert.equal(terminal.nativePid,live.nativePid);assert.equal((await readFile(join(h.job.directory,'stderr.private.log'),'utf8')).trim(),'OWNED_QA_STDERR');
});

test('portable control directory: nonzero actual native exit remains failed although the supervisor itself completes its receipt',async()=>{
 const h=await fixture(3,5);assert.deepEqual(await h.terminal,{code:0,signal:null});const r=await probeOwnedVerificationJobV1(h.job.file);assert.equal(r.normal,false);assert.deepEqual(r.exit,{code:3,signal:null});assert(r.stdoutClosed&&r.stderrClosed&&!r.logFailure);assert.equal(r.checkCount,1);
});
