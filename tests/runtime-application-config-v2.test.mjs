import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {applicationManifestV2,inspectApplicationFieldSlotV2} from '../scripts/runtime-application-config-v2.mjs';
import {fieldApplicationManifestV2} from './fixtures/field-application-v2-input.mjs';

test('formal manifest binds an explicit enabled switch to its unique SITE while retaining complete tenant coverage',()=>{
 const m=fieldApplicationManifestV2();assert.deepEqual(applicationManifestV2(m),m);
 for(const mutate of [m=>delete m.field,m=>m.field.extra=true,m=>m.field.siteComponentId='governance',m=>m.field.enabled='true',m=>m.components.pop(),m=>m.components[0].tenantId='foreign',m=>m.components[1].id=m.components[0].id]){const bad=structuredClone(m);mutate(bad);assert.throws(()=>applicationManifestV2(bad),/APPLICATION_/);}
 const disabled=fieldApplicationManifestV2(false);assert.deepEqual(applicationManifestV2(disabled),disabled);disabled.field.siteComponentId='site';assert.throws(()=>applicationManifestV2(disabled),/APPLICATION_FIELD_FIELDS/);
});

test('enabled mismatch is refused from the wrapper without following absent gateway/base files',async()=>{
 const root=resolve('work/field-application-manager-v3-tests',randomUUID());await privateDirectory(root);
 const file=join(root,'manifest.json'),wrapper={format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:'missing-base.json',field:{enabled:true,gatewayFile:'missing-secret-gateway.json'}};await privateNewFile(join(root,'site.json'),JSON.stringify(wrapper));
 await assert.rejects(inspectApplicationFieldSlotV2(file,fieldApplicationManifestV2(false)),/APPLICATION_FIELD_ENABLED_MISMATCH/);
 const slot=await inspectApplicationFieldSlotV2(file,fieldApplicationManifestV2(true));assert(slot.enabled);assert.equal(slot.runtimeFile,join(root,'site.json'));assert.match(slot.pin.sha256,/^[a-f0-9]{64}$/);
});
