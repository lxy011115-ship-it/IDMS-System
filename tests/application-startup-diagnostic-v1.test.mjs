import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {observeOwnedForkTerminalV1} from '../scripts/owned-fork-terminal-v1.mjs';
import {inspectApplicationStartupDiagnosticQaV1,summarizeApplicationStartupDiagnosticQaV1} from '../scripts/fixtures/application-startup-diagnostic-v1-qa.mjs';

async function failedStartup(){
 await mkdir('work',{recursive:true});const base=await mkdtemp(resolve('work/application-startup-diagnostic-v1-')),launchFile=join(base,'manifest.private.json'),child=fork(resolve('scripts/fixtures/application-startup-diagnostic-root-v1-qa.mjs'),[launchFile],{execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']}),terminal=observeOwnedForkTerminalV1(child);child.stdout.resume();child.stderr.resume();let reported;child.on('message',v=>{if(v.event==='EXPECTED_STARTUP_FAILURE')reported=v;});const exit=await terminal;assert.deepEqual(exit,{code:1,signal:null});assert(reported&&reported.childActualExit.code===1);return{root:{pid:child.pid,launchFile,exit},reported};
}

test('a failed real application child yields bound startup diagnostics and remains a failure with its actual root and child exits',async()=>{
 const f=await failedStartup(),observed=[];const result=await inspectApplicationStartupDiagnosticQaV1({roots:[f.root],retired:async(pid,markers,at)=>{assert(Number.isInteger(pid)&&markers.length===1&&Number.isFinite(Date.parse(at)));observed.push(pid);}});
 assert.equal(result.rootsObserved,1);assert.equal(result.membersWithBoundExitResults,1);assert.equal(result.failedMembers,1);assert.equal(result.normalMembers,0);assert(result.allDiscoveredMemberRetirementsBound&&result.independentPidObservationsPerformed);assert.equal(result.groups[0].terminalEvent,'FAILED');assert.equal(result.groups[0].terminalErrorCode,'APPLICATION_CHILD_EXIT_BEFORE_READY');assert.equal(result.groups[0].members[0].errorCode,'APPLICATION_CHILD_RUNTIME_FAILURE');assert.equal(result.groups[0].members[0].ready,false);assert.deepEqual(observed.sort((a,b)=>a-b),[f.root.pid,f.reported.childPid].sort((a,b)=>a-b));
});

test('startup observation rejects a forged private child challenge even when recorded exits are present',async()=>{
 const f=await failedStartup(),before=await readFile(f.reported.resultFile),value=JSON.parse(before);try{await writeFile(f.reported.resultFile,JSON.stringify({...value,challengeSha256:'0'.repeat(64)}));await assert.rejects(inspectApplicationStartupDiagnosticQaV1({roots:[f.root]}),/APPLICATION_STARTUP_DIAGNOSTIC_BINDING/);}finally{await writeFile(f.reported.resultFile,before);}
});

test('bounded startup summaries retain only validated failure codes and never a raw error or private body',()=>{
 const privateValue='sensitive-body-fragment-for-observer';const result=summarizeApplicationStartupDiagnosticQaV1({passed:false,failure:{message:privateValue,stack:privateValue},applicationStartupDiagnosticError:privateValue,applicationStartupDiagnostics:{format:'IDMS_APPLICATION_STARTUP_DIAGNOSTIC_V1',rootsObserved:1,membersWithBoundExitResults:1,allDiscoveredMemberRetirementsBound:true,groups:[{terminalErrorCode:'APPLICATION_CHILD_EXIT_BEFORE_READY',members:[{errorCode:'APPLICATION_CHILD_RUNTIME_FAILURE',private:privateValue}]}]}});assert(result.startupDiagnosticNeeded&&result.startupDiagnosticObserved&&result.startupAllDiscoveredMemberRetirementsBound);assert(!JSON.stringify(result).includes(privateValue));assert.equal(result.startupDiagnosticFailureCode,null);assert.deepEqual(result.startupFailureCodes,['APPLICATION_CHILD_EXIT_BEFORE_READY','APPLICATION_CHILD_RUNTIME_FAILURE']);assert.equal(summarizeApplicationStartupDiagnosticQaV1({passed:true}).startupAllDiscoveredMemberRetirementsBound,null);
});
