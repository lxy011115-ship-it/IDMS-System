import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readApplicationFileV1,applicationHashV1 as hash} from './runtime-application-config-v1.mjs';

const need=(v,c)=>{if(!v)throw Error(c);},exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(','),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const expectedFiles=['.github/workflows/application-lifecycle-verification.yml','.github/workflows/application-registry-checkpoint-verification.yml','.github/workflows/platform-core-lifecycle-verification.yml'];
const ownFile='.github/workflows/platform-predictor-lifecycle-verification.yml',ownBefore='c1dfb0ec882fcf004a39754e503600f12aa310f68882062d1d55ea379fdd373d';

/** A CI overlay cannot authorize a runtime, test, path or arbitrary file change. */
export function platformCiOverlayContractV1(value,baseline){
 need(exact(value,['format','parent','previousPublishedCommit','overlays','ownWorkflow','runtimeChanges'])&&value.format==='IDMS_PLATFORM_CI_OVERLAYS_V1'&&value.parent==='3666870e72e2539c7c3cc7d92a4b6de7a6c3fcf1'&&value.previousPublishedCommit==='bbe3a8f7d66579836f393c65b9b7e68cb69dc9ff','PLATFORM_CI_OVERLAY_FIELDS');
 need(Array.isArray(value.runtimeChanges)&&value.runtimeChanges.length===0&&Array.isArray(baseline)&&baseline.length===707,'PLATFORM_CI_RUNTIME_CHANGE');
 need(Array.isArray(value.overlays)&&value.overlays.length===3&&value.overlays.map(v=>v.path).sort().join(',')===expectedFiles.join(','),'PLATFORM_CI_OVERLAY_SCOPE');
 const byPath=new Map(baseline.map(v=>[v.path,v.sha256]));need(byPath.size===707,'PLATFORM_CI_PARENT_DUPLICATE');
 for(const row of value.overlays)need(exact(row,['path','beforeSha256','afterSha256'])&&digest(row.beforeSha256)&&digest(row.afterSha256)&&row.beforeSha256!==row.afterSha256&&byPath.get(row.path)===row.beforeSha256,'PLATFORM_CI_OVERLAY_BINDING');
 const own=value.ownWorkflow;need(exact(own,['path','beforeSha256','afterSha256'])&&own.path===ownFile&&own.beforeSha256===ownBefore&&digest(own.afterSha256)&&own.afterSha256!==own.beforeSha256&&!byPath.has(ownFile),'PLATFORM_CI_OWN_WORKFLOW');
 return structuredClone(value);
}

export async function inspectPlatformCiSourceV1(expectedOverlaySha256){
 need(digest(expectedOverlaySha256),'PLATFORM_CI_OVERLAY_DIGEST');const root=fileURLToPath(new URL('../',import.meta.url)),parent=await readApplicationFileV1(resolve(root,'docs/validation/platform-predictor-parent-v1.json')),overlay=await readApplicationFileV1(resolve(root,'docs/validation/platform-ci-overlays-v1.json'));
 need(parent.sha256==='94dfa54903cb12dfae4fa983935ed7406448d78927fb2c4a23cd8c0612f2fe90'&&overlay.sha256===expectedOverlaySha256,'PLATFORM_CI_MANIFEST_CHANGED');
 const baseline=JSON.parse(parent.bytes.toString('utf8'));need(baseline.parent==='3666870e72e2539c7c3cc7d92a4b6de7a6c3fcf1','PLATFORM_CI_PARENT');const declaration=platformCiOverlayContractV1(JSON.parse(overlay.bytes.toString('utf8')),baseline.blobs),changes=new Map(declaration.overlays.map(v=>[v.path,v]));
 for(const pin of baseline.blobs){const expected=changes.get(pin.path)?.afterSha256??pin.sha256;need((await readApplicationFileV1(resolve(root,pin.path))).sha256===expected,'PLATFORM_CI_PARENT_SOURCE_CHANGED');}
 need((await readApplicationFileV1(resolve(root,ownFile))).sha256===declaration.ownWorkflow.afterSha256,'PLATFORM_CI_OWN_WORKFLOW_CHANGED');
 return{parentBaseline:baseline,overlayPin:{path:overlay.path,sha256:hash(overlay.bytes)},unchangedParentFiles:704,changedParentCiFiles:3,ownWorkflowChanged:true,runtimeChanges:0};
}
