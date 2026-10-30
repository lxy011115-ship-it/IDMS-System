import {inspectCiSourcePolicyV2} from './ci-source-policy-v2.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,lstat,link,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {createOwnedPlatformPgQaV1} from './fixtures/owned-platform-pg-v1-qa.mjs';
import {coldStoppedV1} from './pg-cold-image-portable-tools-v1.mjs';
import {launchPostgresLifecycleV1,bindPostgresLifecycleV1,inspectPostgresLifecycleV1,stopPostgresLifecycleV1} from './postgres-lifecycle-v1.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex'),nonce=randomBytes(6).toString('hex'),work=resolve('work/postgres-lifecycle-v5-20261024',nonce);
const report={format:'IDMS_POSTGRES_LIFECYCLE_NATIVE_QA_V5',nonce,startedAt:new Date().toISOString(),checks:[],processes:[],passed:false,cleanupComplete:false,originalDatabaseContacted:false,genericKillUsed:false};
let cluster,options,current;const handles=[];
const checkpoint=async()=>writeFile(join(work,'current.private.json'),JSON.stringify({...report,work},null,2)+'\n',{mode:0o600});
const check=async name=>{report.checks.push(name);await checkpoint();console.log(JSON.stringify({nonce,check:report.checks.length,name}));};
async function connect(){const c=new pg.Client({...cluster.account,application_name:'idms-pg-lifecycle-native-qa',connectionTimeoutMillis:3000});await c.connect();return c;}
async function marker(){const c=await connect();try{return(await c.query('SELECT id,value FROM public.lifecycle_marker ORDER BY id')).rows;}finally{await c.end();}}
async function launch(){const h=await launchPostgresLifecycleV1(options);handles.push(h);current=h;report.processes.push({pid:h.process.pid,directory:h.directory,owner:h.binding.owner});await checkpoint();await bindPostgresLifecycleV1(h);return h;}

async function main(){
 await privateDirectory(resolve('work/postgres-lifecycle-v5-20261024'));await mkdir(work,{mode:0o700});await privateDirectory(work);await checkpoint();
 const admission=await inspectCiSourcePolicyV2('36d63806dd1f7f374631545fba9431e1342d48aeb307ff40c88fb727ae6eeb94');const publication=JSON.parse(await readFile('work/postgres-lifecycle-baseline-v5-20261024/'+admission.policySha256+'/git-publication.json','utf8'));assert.equal(publication.baselineParentCommit,admission.parentCommit);assert.equal(publication.format,'IDMS_POSTGRES_LIFECYCLE_EXECUTION_BASELINE_V5');assert.equal(publication.policySha256,admission.policySha256);assert.deepEqual(publication.blobs,admission.executionBaseline.blobs);assert.equal(publication.historicalSnapshot,admission.executionBaselines.postgres.historicalSnapshot);assert.equal(publication.historicalSnapshotSha256,admission.executionBaselines.postgres.historicalSnapshotSha256);report.sourcePolicy={parentCommit:admission.parentCommit,policySha256:admission.policySha256,profiles:admission.profiles};
 const newSourceFiles=["scripts/ci-source-policy-v2.mjs", "scripts/verify-ci-source-policy-v2.mjs", "tests/ci-source-policy-v2.test.mjs", "tests/ci-source-policy-preflight-v2.test.mjs", "docs/validation/ci-source-parent-v2.json", "docs/validation/ci-source-policy-v2.json", "scripts/verify-postgres-lifecycle-v5.mjs", "scripts/verify-postgres-lifecycle-cleanup-v5.mjs", "scripts/prepare-postgres-lifecycle-baseline-v5.mjs", "scripts/verify-postgres-lifecycle-windows-v6.ps1"];report.sourcePins=[...admission.executionBaseline.blobs];for(const path of newSourceFiles)report.sourcePins.push({path,sha256:hash(await readFile(path))});
 const bin=process.env.IDMS_QA_POSTGRES_BIN||join(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin');cluster=await createOwnedPlatformPgQaV1(bin);report.qaClusterNonce=cluster.nonce;report.qaPort=cluster.authority.port;assert.notEqual(cluster.authority.port,45432);
 let c=await cluster.client();try{await c.query('CREATE TABLE public.lifecycle_marker(id integer PRIMARY KEY,value text NOT NULL)');await c.query('INSERT INTO public.lifecycle_marker VALUES(1,$1)',[nonce]);}finally{await c.end();}await cluster.stop();
 const records=join(work,'records');await mkdir(records,{mode:0o700});await privateDirectory(records);
 options={binDirectory:cluster.bin,dataDirectory:cluster.source,workDirectory:records,expectedSystemIdentifier:cluster.systemIdentifier,port:cluster.authority.port,account:{user:cluster.account.user,password:cluster.account.password,database:'postgres'}};
 await check('new isolated PG16 cluster seeded with a synthetic row and cleanly stopped; original database and port are unused');
 await assert.rejects(launchPostgresLifecycleV1({...options,pid:12345}),/PG_LIFECYCLE_INPUT_FIELDS/);assert.throws(()=>stopPostgresLifecycleV1({process:{pid:12345}}),/PG_LIFECYCLE_HANDLE/);
 await check('injected PID fields and PID-shaped handles rejected without launching or signalling a process');
 const wrong=cluster.systemIdentifier==='1000000000000000000'?'1000000000000000001':'1000000000000000000';await assert.rejects(launchPostgresLifecycleV1({...options,expectedSystemIdentifier:wrong}),/COLD_IMAGE_SOURCE_NOT_CLEAN/);
 await check('wrong system identifier rejected while source remains clean and offline');
 const configFile=join(cluster.source,'postgresql.conf'),configBytes=await readFile(configFile);
 try{await writeFile(configFile,Buffer.concat([configBytes,Buffer.from("\narchive_command = 'echo unsafe'\n")]));await assert.rejects(launchPostgresLifecycleV1(options),/COLD_IMAGE_CONFIG/);}finally{await writeFile(configFile,configBytes);}
 await check('executable configuration hook rejected before spawn and original QA configuration restored');
 const alias=join(cluster.source,'lifecycle-version-alias');await link(join(cluster.source,'PG_VERSION'),alias);try{await assert.rejects(launchPostgresLifecycleV1(options),/FIELD_BACKUP_FILE_INVALID|COLD_IMAGE_LINK/);}finally{await unlink(alias);}
 await check('hard-link alias rejected before spawn; only this newly created alias removed');
 const h=await launch();assert.equal(h.bound,true);const pidLines=(await readFile(join(cluster.source,'postmaster.pid'),'utf8')).split(/\r?\n/);assert.equal(Number(pidLines[0]),h.process.pid);assert.equal(h.binding.systemIdentifier,cluster.systemIdentifier);assert.deepEqual(await marker(),[{id:1,value:nonce}]);
 await check('directly owned postmaster handle matches PID file and real SQL identity; committed synthetic data preserved');
 await assert.rejects(launchPostgresLifecycleV1(options),/COLD_IMAGE_SOURCE_RUNNING/);assert.throws(()=>stopPostgresLifecycleV1({...h}),/PG_LIFECYCLE_HANDLE/);assert.equal(h.helperAttempts,0);
 await check('already active data directory and cloned handle rejected; original owned postmaster remains available');
 c=await connect();try{await assert.rejects(stopPostgresLifecycleV1(h),/PG_LIFECYCLE_CLIENTS_REMAIN/);assert.equal(h.helperAttempts,0);await assert.rejects(lstat(join(h.directory,'stop-intent.json')),{code:'ENOENT'});}finally{await c.end();}
 await check('actual remaining client blocks smart stop before any helper or stop intent');
 try{await writeFile(configFile,Buffer.concat([configBytes,Buffer.from('\n# lifecycle drift test\n')]));await assert.rejects(stopPostgresLifecycleV1(h),/PG_LIFECYCLE_CONFIG_CHANGED/);assert.equal(h.helperAttempts,0);}finally{await writeFile(configFile,configBytes);}
 assert.equal((await inspectPostgresLifecycleV1(h)).otherClients,0);
 await check('raw configuration drift blocks stop without signalling; corrected preflight is inspectable again');
 const requestId=randomUUID(),stopping=stopPostgresLifecycleV1(h,{requestId});assert.equal(stopPostgresLifecycleV1(h,{requestId}),stopping);assert.throws(()=>stopPostgresLifecycleV1(h,{requestId:randomUUID()}),/PG_LIFECYCLE_STOP_REQUEST_CHANGED/);
 const proof=await stopping;assert.equal(proof.mode,'smart');assert.equal(proof.terminal.code,0);assert.equal(proof.terminal.signal,null);assert(proof.terminal.proofSaved&&proof.helperReplyConfirmed);assert.equal(proof.control.state,'shut down');assert.equal(proof.control.systemIdentifier,cluster.systemIdentifier);assert.equal(h.helperAttempts,1);assert.equal(await stopPostgresLifecycleV1(h),proof);await assert.rejects(lstat(join(cluster.source,'postmaster.pid')),{code:'ENOENT'});
 await check('one correlated smart stop yields actual owned exit0, clean same-system control state, no PID file and no repeated helper');
 const second=await launch();assert.notEqual(second.binding.owner,h.binding.owner);assert.notEqual(second.directory,h.directory);assert.deepEqual(await marker(),[{id:1,value:nonce}]);await assert.rejects(inspectPostgresLifecycleV1(h),/PG_LIFECYCLE_HANDLE/);
 await check('fresh owned restart retains data and receives a distinct owner; retired old handle cannot inspect the new process');
 const secondProof=await stopPostgresLifecycleV1(second);assert.equal(secondProof.terminal.code,0);assert.equal(secondProof.terminal.signal,null);assert.equal(secondProof.control.state,'shut down');assert.equal(second.helperAttempts,1);
 await check('second explicitly created postmaster also completes one real smart stop and clean offline verification');
 for(const pin of report.sourcePins)assert.equal(hash(await readFile(pin.path)),pin.sha256);for(const pin of publication.blobs)assert.equal(hash(await readFile(pin.path)),pin.sha256);
 await check('new verifier inputs and all 762 current execution inputs preserved; original 656-file PG snapshot retained separately');
 report.passed=true;
}

main().catch(error=>{report.errorCode=/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)?error.message:'POSTGRES_LIFECYCLE_NATIVE_QA_FAILED';report.errorName=error.name;report.failedAt=new Date().toISOString();process.exitCode=1;}).finally(async()=>{
 try{
  for(const h of [...handles].reverse())if(!h.stopProof&&h.process.exitCode===null&&h.process.signalCode===null){if(!h.bound)await bindPostgresLifecycleV1(h);await stopPostgresLifecycleV1(h);}
  if(cluster?.active)await cluster.stop();
  if(cluster){const control=await coldStoppedV1(cluster.source,cluster.tooling,cluster.systemIdentifier);report.finalControl={state:control.state,systemIdentifier:control.systemIdentifier};}
  const outcomes=[];for(const h of handles){const exit=await h.terminal;outcomes.push({pid:h.process.pid,owner:h.binding.owner,code:exit.code,signal:exit.signal,exitProofSaved:exit.proofSaved,normalStopProven:!!h.stopProof,helperAttempts:h.helperAttempts});}
  report.processOutcomes=outcomes;report.cleanupComplete=!!cluster&&outcomes.every(x=>x.code===0&&x.signal===null&&x.exitProofSaved&&x.normalStopProven&&x.helperAttempts===1);if(!report.cleanupComplete)process.exitCode=1;
 }catch(error){report.cleanupErrorCode=/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)?error.message:'POSTGRES_LIFECYCLE_CLEANUP_FAILED';process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await privateNewFile(join(work,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({nonce,passed:report.passed,checks:report.checks.length,cleanupComplete:report.cleanupComplete,errorCode:report.errorCode??null,cleanupErrorCode:report.cleanupErrorCode??null,processes:report.processOutcomes??[]}));
});
