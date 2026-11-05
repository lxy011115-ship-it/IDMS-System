import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {stopControlledNode} from '../scripts/owned-node-control.mjs';
import {processFacts,sameProcess} from '../scripts/existing-platform-process.mjs';
import {runtimeSourceEvidence} from '../scripts/existing-platform-binding.mjs';
import {createHash} from 'node:crypto';

async function observe(file,alive,budget=30000){const start=performance.now();for(;;){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}assert(await alive(),'original wrapper exited before receipt');assert(performance.now()-start<budget,'receipt observation budget expired; original handle is retained');await new Promise(resolve=>setTimeout(resolve,50));}}
test('native detached creators reject wrong IPC, drain work once, and resume the original stop after timeout',{skip:process.platform!=='win32'},async()=>{
 const caseFiles=['tests/owned-node-control.test.mjs','scripts/owned-node-control.mjs','scripts/existing-platform-child.mjs','scripts/existing-platform-process.mjs','scripts/fixtures/controlled-node-wrapper-qa.mjs','scripts/fixtures/controlled-node-service-qa.ts','scripts/fixtures/controlled-node-service-env-qa.ts'];
 const pins=()=>Promise.all(caseFiles.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
 const sourceBefore=await runtimeSourceEvidence(),caseSourcePinsBefore=await pins();
 const parent=resolve('work/controlled-node-qa');await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,'run-'));
 const instances=[];
 for(let i=0;i<2;i++){
  const dir=join(directory,String(i));await mkdir(dir);await writeFile(join(dir,'input.json'),JSON.stringify({delay:2500}));
  const wrapper=spawn(process.execPath,[resolve('scripts/fixtures/controlled-node-wrapper-qa.mjs'),dir],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:''},windowsHide:true,detached:true,stdio:'ignore'});
  const end=new Promise(resolve=>{wrapper.once('error',error=>resolve({error:error.code}));wrapper.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
  instances.push({dir,wrapper,end});
 }
 for(const instance of instances){const cap=await observe(join(instance.dir,'capability.json'),async()=>instance.wrapper.exitCode===null);assert.equal(cap.rejected,3);instance.control=cap.control;}
 const [first,twin]=instances;
 await assert.rejects(stopControlledNode({...first.control,nonce:'0'.repeat(64)}),/NODE_CONTROL_STATUS_CHANGED/);
 await assert.rejects(stopControlledNode({...first.control,process:{...first.control.process,born:'substituted'}}),/NODE_CONTROL_STATUS_CHANGED/);
 await assert.rejects(access(first.control.requestFile),{code:'ENOENT'});
 // Wrong nonce is refused before a request is created (status binding is checked first).
 assert(sameProcess(twin.control.process,await processFacts(twin.control.process.pid)));
 const a=await stopControlledNode(first.control,{budgetMs:0});assert.equal(a.status,'UNCONFIRMED');
 assert(sameProcess(first.control.process,await processFacts(first.control.process.pid)));
 const requestBefore=await readFile(first.control.requestFile);
 await assert.rejects(stopControlledNode(first.control,{requestId:'11111111-1111-1111-1111-111111111111'}),/NODE_CONTROL_REQUEST_CHANGED/);
 const normal=await stopControlledNode(first.control,{requestId:a.requestId,budgetMs:30000});assert.equal(normal.status,'NORMAL_EXIT');assert.equal(normal.requestId,a.requestId);assert.deepEqual(await readFile(first.control.requestFile),requestBefore);
 assert(sameProcess(twin.control.process,await processFacts(twin.control.process.pid)));
 const second=await stopControlledNode(twin.control,{budgetMs:30000});assert.equal(second.status,'NORMAL_EXIT');
 const reports=[];
 for(const instance of instances){const end=await instance.end;assert.deepEqual(end,{exitCode:0,signal:null});const terminal=JSON.parse(await readFile(join(instance.dir,'terminal.json'),'utf8'));assert.equal(terminal.end.pipesClosed,true);assert.equal(terminal.final.drainCompleted,true);assert.equal(terminal.drain.stops,1);assert.equal(terminal.drain.pendingCompleted,true);assert.equal(await processFacts(instance.control.process.pid),null);reports.push({...terminal,wrapper:end});}
 const sourceAfter=await runtimeSourceEvidence(),caseSourcePinsAfter=await pins();assert.equal(sourceBefore.digest,sourceAfter.digest);assert.equal(sourceBefore.files,sourceAfter.files);assert.deepEqual(caseSourcePinsBefore,caseSourcePinsAfter);
 await writeFile(join(directory,'verification.json'),JSON.stringify({format:'IDMS_CONTROLLED_NODE_QA_V1',passed:true,scope:'synthetic work through shared ordinary creator/control functions; not actual main/edge/OPC integration',sourceBefore,sourceAfter,caseSourcePinsBefore,caseSourcePinsAfter,originalStopResumed:true,wrongIpcRefused:3,twinsIsolated:true,reports},null,2));
});
