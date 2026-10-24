import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {privateDirectory} from '../scripts/backup-support.mjs';
import {applicationHashV1 as hash} from '../scripts/runtime-application-config-v1.mjs';
import {createApplicationRegistryV2,appendApplicationRegistryV2,readApplicationRegistryV2} from '../scripts/runtime-application-registry-v2.mjs';
import {fieldSiteChildRetirementV1} from '../scripts/runtime-field-site-retirement-v1.mjs';
import {fieldApplicationManifestV2,fieldSiteTerminalFixtureV1} from './fixtures/field-application-v2-input.mjs';

test('SQLite journal refuses READY before START and refuses background stop until actual SITE retirement facts are recorded',async()=>{
 const root=resolve('work/field-application-registry-v2-tests',randomUUID());await privateDirectory(root);
 const manifest=fieldApplicationManifestV2(),trust=await createApplicationRegistryV2(resolve(root,'registry'),manifest,[{path:'structural-test-only',sha256:'a'.repeat(64)}]),write=(event,details)=>appendApplicationRegistryV2(trust,event,details);
 const {result,expected}=fieldSiteTerminalFixtureV1();Object.assign(expected,{ownerId:trust.ownerId,parentPid:process.pid,manifestSha256:hash(canonical(manifest))});Object.assign(result,{ownerId:expected.ownerId,parentPid:expected.parentPid,manifestSha256:expected.manifestSha256});
 let pid=20000;const pids=new Map();
 for(const c of manifest.components.filter(c=>c.kind!=='SITE')){pids.set(c.id,++pid);await write('LAUNCH_INTENT',{componentId:c.id,kind:c.kind,configSha256:'a'.repeat(64),challengeSha256:'b'.repeat(64)});await write('READY',{componentId:c.id,pid,configSha256:'a'.repeat(64),kind:c.kind,tenantIds:[c.tenantId],binding:manifest.binding});}
 await write('LAUNCH_INTENT',{componentId:'site',kind:'SITE',configSha256:expected.configSha256,challengeSha256:hash(expected.challenge)});
 const ready={componentId:'site',pid:expected.pid,configSha256:expected.configSha256,kind:'SITE',tenantIds:manifest.tenantIds,binding:manifest.binding};
 await assert.rejects(write('READY',ready),/APPLICATION_REGISTRY_READY/);
 await write('CREATED',{componentId:'site',pid:expected.pid,challengeSha256:hash(expected.challenge)});await write('START_AUTHORIZED',{componentId:'site',pid:expected.pid});await write('READY',ready);await write('GROUP_READY',{});
 await write('GROUP_STOPPING',{requestId:expected.requestId});await write('STOP_INTENT',{componentId:'site',pid:expected.pid,requestId:expected.requestId});await write('DRAINING',{componentId:'site',pid:expected.pid,requestId:expected.requestId});await write('CLOSED',{componentId:'site',pid:expected.pid,requestId:expected.requestId});await write('EXIT',{componentId:'site',pid:expected.pid,code:0,signal:null});
 const next=manifest.components[0],stop={componentId:next.id,pid:pids.get(next.id),requestId:expected.requestId};
 await assert.rejects(write('STOP_INTENT',stop),/APPLICATION_REGISTRY_INGRESS_STILL_LIVE/);
 const proof=fieldSiteChildRetirementV1(result,expected),bad=structuredClone(proof);bad.counts.hostConnectionsRetired--;
 await assert.rejects(write('RETIRED',{componentId:'site',pid:expected.pid,proof:bad}),/FIELD_SITE_PROOF_COUNTS/);
 await write('RETIRED',{componentId:'site',pid:expected.pid,proof});
 for(const c of manifest.components.filter(c=>c.kind!=='SITE')){const v={componentId:c.id,pid:pids.get(c.id),requestId:expected.requestId};await write('STOP_INTENT',v);await write('DRAINING',v);await write('CLOSED',v);await write('EXIT',{componentId:c.id,pid:v.pid,code:0,signal:null});}
 await write('GROUP_CLOSED',{});const journal=await readApplicationRegistryV2(trust);assert(journal.lifecycle.groupReady&&journal.lifecycle.terminal);assert.equal(journal.events.filter(e=>e.event==='RETIRED').length,1);assert.equal(journal.events.at(-1).event,'GROUP_CLOSED');
 await assert.rejects(write('FAILED',{errorCode:'QA_FAILURE'}),/APPLICATION_REGISTRY_AFTER_TERMINAL/);
});
