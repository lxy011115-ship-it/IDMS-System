import test from 'node:test';
import assert from 'node:assert/strict';
import {telemetryQualityFixture} from '../scripts/fixtures/telemetry-quality-model.mjs';
import {fieldIssuanceModel} from '../scripts/fixtures/field-issuance-model.mjs';
import {fieldSiteSourceUpgradeQaV1} from '../scripts/fixtures/field-site-source-upgrade-v1-qa.mjs';
import {tenantSeed} from '../scripts/database-migrations.mjs';
import {validateSourcePublication,sourcePolicyHistory} from '../server/source-policy-history.ts';
import {publicationIndex} from '../server/template-history.ts';
import {createTemplate,submitTemplate,approveTemplate} from '../server/catalog.ts';
import {canonical} from '../server/imports.ts';

test('future FIELD switch preserves the actual same-key history and remains valid after independent approval',()=>{
 const f=telemetryQualityFixture({count:0}),source=f.sources[0],model=fieldIssuanceModel(f.store,f.imports,source),{audits,idempotency,...business}=f.store,payload=tenantSeed({version:2,business,audits,imports:f.imports,idempotency:[...idempotency]},'acme'),plan=fieldSiteSourceUpgradeQaV1(payload,source,model.sourcePolicy.entries[0].mapping.points);
 assert.equal(plan.templateKey,model.sourceTemplate.templateKey);assert.notEqual(plan.version,model.sourceTemplate.version);assert.equal(plan.policy.changeIntent,'PROSPECTIVE');assert.deepEqual(plan.policy.entries.slice(0,-1),model.sourcePolicy.entries);assert(plan.effectiveAt>Date.now()+170000);
 const previous=canonical(model.sourceTemplate.manifest),t=createTemplate(f.store,{templateKey:plan.templateKey,version:plan.version,industry:'真实历史升级边界',manifest:{...model.sourceTemplate.manifest,telemetrySourcePolicy:plan.policy}},model.author,f.imports),expected=()=>({expectedRevision:t.revision,expectedDigest:t.contentDigest});submitTemplate(f.store,t.id,expected(),model.author,f.imports);validateSourcePublication(f.store,t,new Date().toISOString(),f.imports);approveTemplate(f.store,t.id,{...expected(),decision:'APPROVED',comment:'独立核对未来切换及完整历史'},model.reviewer,f.imports);
 const index=publicationIndex(f.store.audits,'acme'),history=sourcePolicyHistory(f.store.templates,'acme',source.edgeId,Date.now(),id=>index.get(id),index);assert.equal(history.selected.source.templateKey,plan.templateKey);assert.equal(history.selected.source.version,plan.version);assert.equal(canonical(model.sourceTemplate.manifest),previous);
 const duplicate=structuredClone(payload);duplicate.business.templates.push({...structuredClone(model.sourceTemplate),id:'00000000-0000-0000-0000-000000000001',templateKey:'parallel-edge-history'});assert.throws(()=>fieldSiteSourceUpgradeQaV1(duplicate,source,model.sourcePolicy.entries[0].mapping.points));
});
