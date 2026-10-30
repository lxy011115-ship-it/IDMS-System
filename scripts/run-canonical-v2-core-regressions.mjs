import assert from 'node:assert/strict';
import {readFile,writeFile,open,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const work=resolve('work/canonical-v2-core-20261019'),prepared=JSON.parse(await readFile(join(work,'prepared.json'),'utf8')),source=prepared.sourceRoot,results=[];
await assert.rejects(stat(join(work,'suite-verification.json')),e=>e.code==='ENOENT');
const steps=[['units',['--test','server/*.test.ts']],['maintenance',['scripts/verify-maintenance-demo.mjs']],['catalog',['scripts/verify-catalog.mjs']],['data',['scripts/verify-data-management.mjs']],['mapping',['scripts/verify-import-mapping.mjs']],['corrections',['scripts/verify-record-corrections.mjs']],['quality',['scripts/verify-quality-scope.mjs']],['equipment',['scripts/verify-equipment-profiles.mjs']],['write-postimage',['scripts/verify-write-postimage.mjs']],['shared-sessions',['scripts/verify-shared-sessions.mjs']],['telemetry',['scripts/verify-telemetry.mjs']],['workers',['scripts/verify-worker-ha.mjs']]];
const loader=pathToFileURL(join(source,'scripts/fixtures/canonical-v2-runtime-witness.mjs')).href;
for(const [label,args]of steps){
 const journal=join(work,label+'-witnesses.private.jsonl'),log=await open(join(work,label+'.private.log'),'wx',0o600);await writeFile(journal,'',{flag:'wx',mode:0o600});
 const env={...process.env,NODE_OPTIONS:'--import='+loader,NODE_ENV:'',IDMS_CANONICAL_V2_QA_ROOT:source,IDMS_CANONICAL_V2_WITNESS_FILE:journal,IDMS_STORAGE:'',IDMS_POSTGRES_CONFIG:'',IDMS_AUTH_MODE:'demo',IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:'',IDMS_PREDICTOR_URL:'',IDMS_CAPACITY_CONFIG:''};
 const child=spawn(process.execPath,args,{cwd:source,env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});console.log(JSON.stringify({phase:'RUNNING_V2_CORE_REGRESSION',label,childPid:child.pid}));await writeFile(join(work,'active-step.json'),JSON.stringify({label,pid:child.pid,args,startedAt:new Date().toISOString()},null,2));
 const terminal=await new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>ok({code,signal}));});await log.close();const witnesses=(await readFile(journal,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.ok(witnesses.length&&witnesses.every(w=>w.actualV2CanonicalFunctionReferenceBound));
 const row={label,args,childPid:child.pid,...terminal,witnessCount:witnesses.length,entries:[...new Set(witnesses.map(w=>w.entry))],logSha256:createHash('sha256').update(await readFile(join(work,label+'.private.log'))).digest('hex'),finishedAt:new Date().toISOString()};await writeFile(join(work,label+'-terminal.json'),JSON.stringify(row,null,2),{flag:'wx'});results.push(row);console.log(JSON.stringify({phase:'V2_CORE_REGRESSION_TERMINAL',label,code:terminal.code,witnessCount:witnesses.length}));
 assert.equal(terminal.code,0,'V2 core regression failed: '+label);
}
const proof={format:'idms-canonical-v2-core-regressions-v1',verifiedAt:new Date().toISOString(),results,allCompleted:true,allNodeWitnessesBoundToV2:true,independentQaSourceAndOutputs:true,originalCoreDeployed:false,productionAcceptance:false};await writeFile(join(work,'suite-verification.json'),JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({phase:'V2_CORE_REGRESSIONS_COMPLETE',count:results.length}));
