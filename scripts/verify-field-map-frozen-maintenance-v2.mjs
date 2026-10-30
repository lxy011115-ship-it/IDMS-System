import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {exerciseFieldMapFrozenMaintenanceQaV2} from './fixtures/field-map-frozen-maintenance-v2-qa.mjs';
assert.equal(process.argv.length,3);const nonce=randomBytes(6).toString('hex'),work=resolve('work/field-map-frozen-maintenance-v2-20261024',nonce),hash=v=>createHash('sha256').update(v).digest('hex');await privateDirectory(work);
const roots=['scripts/field-map-frozen-profile-v2.mjs','scripts/field-map-frozen-maintenance-v2.mjs','scripts/fixtures/field-map-frozen-maintenance-v2-qa.mjs','scripts/verify-field-map-frozen-maintenance-v2.mjs'];
const parent=JSON.parse(await readFile('docs/validation/field-map-frozen-maintenance-parent-v1.json','utf8'));assert.equal(parent.commit,'93d42fb73a822e35ae557292b05da940af87efff');assert.equal(parent.blobs.length,1035);for(const p of parent.blobs)assert.equal(hash(await readFile(p.path)),p.sha256);
const paths=[...parent.blobs.map(p=>p.path),...roots,'scripts/state-map-v1.sql','scripts/runtime-write-fence-v1.sql','tests/field-map-frozen-profile-v2.test.mjs','docs/validation/field-map-frozen-maintenance-parent-v1.json','docs/superpowers/specs/2026-10-24--field-map-frozen-maintenance.md','docs/superpowers/plans/2026-10-24--field-map-frozen-maintenance.md'];
const graphFile=join(work,'source-graph-input.private.json');await privateNewFile(graphFile,JSON.stringify({format:'FIELD_SOURCE_STATIC_GRAPH_V1',paths,roots}));
const graph=JSON.parse((await promisify(execFile)(process.execPath,['--experimental-vm-modules','scripts/field-source-static-graph-v1.mjs',resolve('.'),graphFile],{windowsHide:true,maxBuffer:4*1024**2})).stdout);assert.equal(graph.productModulesLinkedOrEvaluated,false);
const sourcePins=[];for(const path of graph.paths)sourcePins.push({path,sha256:hash(await readFile(path))});await privateNewFile(join(work,'native-input-pins.json'),JSON.stringify({sourcePins}));
const report={format:'FIELD_MAP_FROZEN_MAINTENANCE_QA_V1',nonce,rootPid:process.pid,sourcePins,checks:[],cleanupErrors:[],passed:false,currentOidcApprovalVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};let problem;
console.log(JSON.stringify({nativeStarted:true,nonce,pid:process.pid,sourcePins:sourcePins.length,expectedChecks:9}));
const note=name=>{report.checks.push(name);console.log(JSON.stringify({check:report.checks.length,nonce,name}));};
try{await exerciseFieldMapFrozenMaintenanceQaV2({pgBin:resolve(process.argv[2]),work,nonce,note,report});assert.equal(report.checks.length,9);assert.equal(report.cleanupErrors.length,0);assert(report.allOriginalProcessesTerminal&&report.allSqlConnectionsClosed);report.passed=true;}
catch(e){problem=e;report.failure={kind:e.constructor?.name,sqlState:e.code??null,inventoryDifferencePaths:e.inventoryDifferencePaths??[],messageSha256:hash(e.message??'')};}
finally{for(const pin of sourcePins)assert.equal(hash(await readFile(pin.path)),pin.sha256);await privateNewFile(join(work,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({nonce,passed:report.passed,checks:report.checks.length,cleanupErrorCount:report.cleanupErrors.length,work}));}
if(problem||!report.passed)process.exitCode=1;
