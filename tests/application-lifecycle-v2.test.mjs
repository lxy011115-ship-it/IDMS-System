import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {launchApplicationLifecycleV2,bindApplicationLifecycleV2,stopApplicationLifecycleV2,inspectApplicationRetirementV2} from '../scripts/application-lifecycle-v2.mjs';

test('external PID-shaped handles and unknown launch fields cannot adopt an application manager',async()=>{
 assert.throws(()=>stopApplicationLifecycleV2({process:{pid:12345}}),/APPLICATION_LIFECYCLE_HANDLE/);
 await assert.rejects(inspectApplicationRetirementV2({process:{pid:12345}}),/APPLICATION_LIFECYCLE_HANDLE/);
 await assert.rejects(bindApplicationLifecycleV2({process:{pid:12345}}),/APPLICATION_LIFECYCLE_HANDLE/);
 await assert.rejects(launchApplicationLifecycleV2({manifestFile:'missing',workDirectory:'missing',pid:12345}),/APPLICATION_LIFECYCLE_INPUT/);
});

test('fixed application fork is retained before failed startup; actual exit is saved without a false group shutdown',async()=>{
 const nonce=randomBytes(6).toString('hex'),work=resolve('work/application-lifecycle-v2-20261023',nonce),records=join(work,'records');await privateDirectory(records);
 const file=join(work,'manifest.private.json'),manifest={format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(work,'registry-not-created'),trustFile:join(work,'absent-trust.json'),authorityRuntimeFile:join(work,'absent-authority.json'),binding:{controlId:randomUUID(),sourceHash:'a'.repeat(64),authorityHash:'b'.repeat(64)},tenantIds:['acme'],components:[...['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION'].map(kind=>({id:kind.toLowerCase(),kind,tenantId:'acme',runtimeFile:join(work,kind+'-absent.json')})),{id:'site',kind:'SITE',tenantId:null,runtimeFile:join(work,'site-absent.json')}]};
 await privateNewFile(file,JSON.stringify(manifest));const h=await launchApplicationLifecycleV2({manifestFile:file,workDirectory:records});
 assert(h.process.pid>0);assert.equal(h.ready,false);await assert.rejects(inspectApplicationRetirementV2(h),/APPLICATION_LIFECYCLE_NOT_TERMINAL/);const pendingBind=bindApplicationLifecycleV2(h);pendingBind.catch(()=>{});
 const proof=await h.terminal;await assert.rejects(pendingBind,/APPLICATION_LIFECYCLE_EXIT_BEFORE_READY|APPLICATION_LIFECYCLE_NOT_RUNNING/);
 assert.equal(proof.exit.code,1);assert.equal(proof.exit.signal,null);assert.equal(proof.registryChecked,false);assert.equal(proof.allOwnedTerminalProven,false);assert.equal(proof.normalFullGroup,false);assert.equal(proof.startupCancelled,false);
 const exit=JSON.parse(await readFile(join(h.directory,'exit-observation.json'),'utf8'));assert.equal(exit.pid,h.process.pid);assert.equal(exit.code,1);assert.equal(exit.signal,null);assert(h.process.stdout.closed&&h.process.stderr.closed&&!h.process.connected);
 assert.throws(()=>stopApplicationLifecycleV2(h),/APPLICATION_LIFECYCLE_NOT_RUNNING/);
 const first=await readFile(join(h.directory,'terminal-proof.json'));await assert.rejects(inspectApplicationRetirementV2(h),/APPLICATION_LIFECYCLE_TERMINAL_UNPROVEN/);assert.deepEqual(await readFile(join(h.directory,'terminal-proof.json')),first);assert.equal(h.retirementProof.allOwnedTerminalProven,false);
 await privateNewFile(join(work,'verification.json'),JSON.stringify({nonce,actualForkPid:h.process.pid,actualExit:proof.exit,stdoutAndStderrClosed:true,ipcDisconnected:true,exitObservationSaved:true,managerCreatedBeforeReady:true,groupNormalShutdownClaimed:false,fullGroupPositiveNativeVerified:false,fullGoalComplete:false},null,2));
});

test('malformed private manifests expose only a fixed error code before fork',async()=>{
 const work=resolve('work/application-lifecycle-v2-20261023',randomBytes(6).toString('hex'));await privateDirectory(work);const file=join(work,'malformed.private.json');await privateNewFile(file,'{"password":"sensitive-fragment-for-error-test" invalid}');
 await assert.rejects(launchApplicationLifecycleV2({manifestFile:file,workDirectory:work}),e=>e.message==='APPLICATION_LIFECYCLE_MANIFEST_INVALID'&&!e.message.includes('sensitive-fragment-for-error-test'));
});
