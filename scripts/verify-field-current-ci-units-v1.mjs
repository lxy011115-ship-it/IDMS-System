import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {retainFieldCiTapSummaryV1} from './field-current-ci-tap-summary-v1.mjs';

assert.equal(process.argv.length,3);const mode=process.argv[2];assert(['SCRAM','CASE','COUNTERS'].includes(mode));
const root=resolve('.'),sha=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse(await readFile(p,'utf8'));
const caseFiles=['tests/cold-field-current-native-fixture-v3.test.mjs','tests/cold-field-material-source-files-v3.test.mjs','tests/cold-field-deployment-files-v3.test.mjs','tests/cold-field-spool-snapshot-v2.test.mjs','tests/cold-field-source-history-v2.test.mjs','tests/cold-field-spool-graph-v2.test.mjs','tests/field-current-transport-endpoint-v2.test.mjs','tests/field-current-ci-safe-output-v2.test.mjs','tests/controlled-cold-stage-diagnostic-v3.test.mjs','tests/cold-field-observation-group-v1.test.mjs','tests/field-current-ci-tap-summary-v1.test.mjs'];
const files=mode==='SCRAM'?['tests/cold-field-pg-scram-v1.test.mjs']:mode==='CASE'?caseFiles:['tests/field-current-ci-tap-summary-v1.test.mjs'],expected=mode==='SCRAM'?8:mode==='CASE'?88:6;
let nonce=null;
if(mode==='CASE'){
 assert(process.env.IDMS_COLD_FIELD_MATERIAL_QA_CASE&&process.env.IDMS_COLD_FIELD_MATERIAL_QA_WORK&&process.env.IDMS_FIELD_CI_SAFE_BASELINE_INDEPENDENT);
 const reportFile=join(resolve(process.env.IDMS_COLD_FIELD_MATERIAL_QA_CASE),'verification.json'),stat=await lstat(reportFile);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=16*1024**2);
 const report=await read(reportFile);assert(report.format==='IDMS_FIELD_CURRENT_MATERIALS_NATIVE_QA_V5'&&report.passed&&report.checks.length===43&&/^[a-f0-9]{12}$/.test(report.nonce));nonce=report.nonce;
 await mkdir(resolve(process.env.IDMS_COLD_FIELD_MATERIAL_QA_WORK),{recursive:true,mode:0o700});
}else if(mode==='SCRAM'){
 assert(process.env.IDMS_COLD_FIELD_PG_BIN&&process.env.IDMS_COLD_FIELD_PG_WORK);await mkdir(resolve(process.env.IDMS_COLD_FIELD_PG_WORK),{recursive:true,mode:0o700});
}
assert(process.env.IDMS_FIELD_CI_RESULT_DIRECTORY);const output=resolve(process.env.IDMS_FIELD_CI_RESULT_DIRECTORY);await mkdir(output,{recursive:true,mode:0o700});assert(!(await lstat(output)).isSymbolicLink());
const pinned=[...files,'scripts/field-current-ci-tap-summary-v1.mjs','scripts/verify-field-current-ci-units-v1.mjs'],sourcePins=[];
for(const path of pinned)sourcePins.push({path,sha256:sha(await readFile(resolve(root,path)))});
assert.equal(resolve(fileURLToPath(import.meta.url)),resolve(root,'scripts/verify-field-current-ci-units-v1.mjs'));
const child=spawn(process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...files],{cwd:root,windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe']});
let stdoutBytes=0,stderrBytes=0,stdoutClosed=false,stderrClosed=false,overflow=false,spawnFailed=false;const chunks=[];
child.stdout.on('data',bytes=>{stdoutBytes+=bytes.length;if(stdoutBytes<=8*1024**2)chunks.push(Buffer.from(bytes));else overflow=true;});child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>8*1024**2)overflow=true;});
child.stdout.once('close',()=>{stdoutClosed=true;});child.stderr.once('close',()=>{stderrClosed=true;});child.once('error',()=>{spawnFailed=true;});
const terminal=await new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal})));let sourcesUnchanged=true;
for(const pin of sourcePins)if(sha(await readFile(resolve(root,pin.path)))!==pin.sha256)sourcesUnchanged=false;
const processEvidence={format:'FIELD_CI_ORIGINAL_UNIT_PROCESS_V1',mode,originalChildPid:child.pid??null,actualExitCode:terminal.code,actualSignal:terminal.signal,originalChildAndBothStreamsClosed:stdoutClosed&&stderrClosed,stdoutBytes,stderrBytes,overflow,spawnFailed,selectedSourcesUnchanged:sourcesUnchanged,noSignalsSent:true,rawTapOrStderrSaved:false};
const save=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});await save(mode.toLowerCase()+'-unit-process.json',processEvidence);
let retained;try{if(!overflow&&!spawnFailed)retained=retainFieldCiTapSummaryV1(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)),expected);}catch{}finally{for(const bytes of chunks)bytes.fill(0);chunks.length=0;}
if(retained)await save(mode.toLowerCase()+'-unit-summary.json',{format:'FIELD_CI_BOUNDED_UNIT_RESULT_V1',mode,nonce,sourcePins,retained,processEvidence,strictExpectedCountersAndOriginalProcessAccepted:retained.exactExpectedPass&&terminal.code===0&&terminal.signal===null&&stdoutClosed&&stderrClosed&&sourcesUnchanged&&!overflow&&!spawnFailed,authorizationGranted:false,fullGoalComplete:false});
assert(terminal.code===0&&terminal.signal===null&&stdoutClosed&&stderrClosed&&sourcesUnchanged&&!overflow&&!spawnFailed&&retained?.exactExpectedPass,'FIELD_CI_EXACT_UNIT_COUNT_AND_ORIGINAL_NORMAL0_REQUIRED');
console.log(JSON.stringify({format:'FIELD_CI_BOUNDED_UNIT_PROCESS_RESULT_V1',mode,nonce,tests:expected,pass:expected,actualExitCode:0,originalChildAndBothStreamsClosed:true,selectedSourcesUnchanged:true,rawTapOrStderrSaved:false,fullGoalComplete:false}));
