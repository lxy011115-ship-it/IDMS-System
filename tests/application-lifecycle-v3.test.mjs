import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {launchApplicationLifecycleV3,bindApplicationLifecycleV3,stopApplicationLifecycleV3,inspectApplicationRetirementV3} from '../scripts/application-lifecycle-v3.mjs';
import {launchApplicationSuiteV3} from '../scripts/runtime-application-manager-v3.mjs';
import {fieldApplicationManifestV2} from './fixtures/field-application-v2-input.mjs';

test('new lifecycle rejects foreign handles and cancelled manager creates no resources',async()=>{
 assert.throws(()=>stopApplicationLifecycleV3({process:{pid:12345}}),/APPLICATION_LIFECYCLE_HANDLE/);await assert.rejects(bindApplicationLifecycleV3({process:{pid:12345}}),/APPLICATION_LIFECYCLE_HANDLE/);await assert.rejects(inspectApplicationRetirementV3({process:{pid:12345}}),/APPLICATION_LIFECYCLE_HANDLE/);
 const c=new AbortController();c.abort();await assert.rejects(launchApplicationSuiteV3('never-read.json',{startupSignal:c.signal}),e=>e.message==='APPLICATION_SUITE_START_CANCELLED'&&e.shutdown.allOwnedChildrenTerminal&&e.shutdown.allOwnedResourcesRetired&&e.shutdown.components===0);
});

test('actual new manager fork failing before admission never invents group or field retirement',async()=>{
 const root=resolve('work/application-lifecycle-v3-tests',randomUUID()),records=join(root,'records');await privateDirectory(records);
 const m=fieldApplicationManifestV2(false),file=join(root,'manifest.json');await privateNewFile(file,JSON.stringify(m));await privateNewFile(join(root,'site.json'),JSON.stringify({format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:'missing-base.json',field:{enabled:false}}));
 const h=await launchApplicationLifecycleV3({manifestFile:file,workDirectory:records});assert(h.process.pid>0&&!h.ready);const binding=bindApplicationLifecycleV3(h);binding.catch(()=>{});const p=await h.terminal;
 await assert.rejects(binding,/APPLICATION_LIFECYCLE_EXIT_BEFORE_READY|APPLICATION_LIFECYCLE_NOT_RUNNING/);assert.deepEqual(p.exit,{code:1,signal:null});assert(!p.normalFullGroup&&!p.startupCancelled&&!p.allOwnedTerminalProven&&!p.allOwnedResourcesRetired);assert(h.process.stdout.closed&&h.process.stderr.closed&&!h.process.connected);
 const saved=JSON.parse(await readFile(join(h.directory,'exit-observation.json'),'utf8'));assert.equal(saved.pid,h.process.pid);assert.equal(saved.code,1);await assert.rejects(inspectApplicationRetirementV3(h),/APPLICATION_LIFECYCLE_TERMINAL_UNPROVEN/);
});

test('immediate stop of the actual manager fork retains one request and proves preflight cancellation without adopting any process',async()=>{
 const root=resolve('work/application-lifecycle-v3-tests',randomUUID()),records=join(root,'records');await privateDirectory(records);
 const m=fieldApplicationManifestV2(false),file=join(root,'manifest.json');await privateNewFile(file,JSON.stringify(m));await privateNewFile(join(root,'site.json'),JSON.stringify({format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:'missing-base.json',field:{enabled:false}}));
 const h=await launchApplicationLifecycleV3({manifestFile:file,workDirectory:records}),requestId=randomUUID(),first=stopApplicationLifecycleV3(h,{requestId});
 assert.equal(stopApplicationLifecycleV3(h,{requestId}),first);assert.throws(()=>stopApplicationLifecycleV3(h,{requestId:randomUUID()}),/APPLICATION_LIFECYCLE_REQUEST_CHANGED/);
 const p=await first;assert.deepEqual(p.exit,{code:0,signal:null});assert(p.startupCancelled&&p.allOwnedTerminalProven&&p.allOwnedResourcesRetired&&!p.normalFullGroup);assert.equal(p.membersCreated,0);assert(h.process.stdout.closed&&h.process.stderr.closed&&!h.process.connected);assert.deepEqual(await inspectApplicationRetirementV3(h),p);
});
