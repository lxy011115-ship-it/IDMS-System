import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const parentPath='docs/validation/ci-source-parent-v2.json',policyPath='docs/validation/ci-source-policy-v2.json';
const cliPath='scripts/verify-ci-source-policy-v2.mjs';

test('real preflight rejects tampered files in an isolated copy of all authenticated source',async t=>{
  const fixtureParent=resolve(root,'work/ci-source-policy-preflight-v2');await mkdir(fixtureParent,{recursive:true});
  const fixtureRoot=await mkdtemp(resolve(fixtureParent,'case-'));
  t.after(async()=>{
    const child=relative(fixtureParent,fixtureRoot);
    assert(!isAbsolute(child)&&/^case-[A-Za-z0-9]+$/.test(child)&&!child.includes(sep));
    await rm(fixtureRoot,{recursive:true,force:false});
  });
  const parent=JSON.parse(await readFile(resolve(root,parentPath),'utf8'));
  assert.equal(parent.blobs.length,762);
  for(const path of [...parent.blobs.map(row=>row.path),parentPath,policyPath,'scripts/ci-source-policy-v2.mjs',cliPath]){
    const destination=resolve(fixtureRoot,path);await mkdir(dirname(destination),{recursive:true});await copyFile(resolve(root,path),destination);
  }
  function run(expectedPolicySha256){
    const args=expectedPolicySha256?['--input-type=module','-e',"import {inspectCiSourcePolicyV2} from './scripts/ci-source-policy-v2.mjs'; const r=await inspectCiSourcePolicyV2(process.argv[1]); console.log(JSON.stringify({profiles:r.profiles,ciFilesChangedSinceParent:r.ciFilesChangedSinceParent,runtimeChanges:r.runtimeChanges}));",expectedPolicySha256]:[cliPath];
    const result=spawnSync(process.execPath,args,{cwd:fixtureRoot,encoding:'utf8',timeout:30000});
    assert.equal(result.error,undefined);return result;
  }
  async function tamper(path,expect){
    const target=resolve(fixtureRoot,path),bytes=await readFile(target);
    try{await writeFile(target,Buffer.concat([bytes,Buffer.from('\n// isolated source tamper\n')]));const result=run();assert.notEqual(result.status,0);assert.match(result.stderr,expect);}
    finally{await writeFile(target,bytes);}
  }
  await t.test('unaltered complete source is admitted without starting lifecycle resources',()=>{
    const result=run();assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
    assert.equal(value.parentSourceBlobs,762);assert.equal(value.nonCiParentFilesUnchanged,756);
    assert.deepEqual(value.profiles.map(p=>[p.name,p.sourceBlobs,p.nonCiFilesUnchanged]),[['platform',707,702],['predictor',695,691],['postgres',656,652]]);
    assert.equal(value.servicesStarted,0);assert.equal(value.databasesContacted,0);assert.equal(value.nativeLifecycleExecuted,false);
  });
  await t.test('production runtime byte changes are rejected',()=>tamper('scripts/runtime-application-registry-v1.mjs',/CI_SOURCE_BYTES_CHANGED:scripts\/runtime-application-registry-v1\.mjs/));
  await t.test('a CI byte change without its declared after digest is rejected',()=>tamper('.github/workflows/predictor-lifecycle-verification.yml',/CI_SOURCE_BYTES_CHANGED:\.github\/workflows\/predictor-lifecycle-verification\.yml/));
  await t.test('rewriting a historical snapshot is rejected before interpreting it',()=>tamper('docs/validation/postgres-lifecycle-baseline-v4.json',/CI_SOURCE_BYTES_CHANGED:docs\/validation\/postgres-lifecycle-baseline-v4\.json/));
  await t.test('substituting the parent manifest or policy bytes cannot bypass a pinned entry',async()=>{
    await tamper(parentPath,/CI_SOURCE_MANIFEST_CHANGED/);await tamper(policyPath,/CI_SOURCE_MANIFEST_CHANGED/);
  });
  await t.test('an explicitly bound CI update passes all historical profiles while runtime tampering remains rejected',async()=>{
    const path='.github/workflows/predictor-lifecycle-verification.yml',target=resolve(fixtureRoot,path),originalCi=await readFile(target),originalPolicy=await readFile(resolve(fixtureRoot,policyPath));
    try{
      const ciBytes=Buffer.concat([originalCi,Buffer.from('\n# explicitly bound isolated CI update\n')]);await writeFile(target,ciBytes);
      const policy=JSON.parse(originalPolicy);policy.ciBindings.find(row=>row.path===path).afterSha256=hash(ciBytes);
      const policyBytes=Buffer.from(JSON.stringify(policy));await writeFile(resolve(fixtureRoot,policyPath),policyBytes);
      // An old entry must still reject the revised declaration; only the explicit new digest admits it.
      const oldEntry=run();assert.notEqual(oldEntry.status,0);assert.match(oldEntry.stderr,/CI_SOURCE_MANIFEST_CHANGED/);
      const result=run(hash(policyBytes));assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);
      assert.equal(value.ciFilesChangedSinceParent,policy.ciBindings.filter(row=>row.beforeSha256!==row.afterSha256).length);assert.equal(value.profiles.length,3);assert.equal(value.runtimeChanges,0);
      const runtime=resolve(fixtureRoot,'scripts/runtime-application-registry-v1.mjs'),runtimeBytes=await readFile(runtime);
      try{await writeFile(runtime,Buffer.concat([runtimeBytes,Buffer.from('\n// still forbidden\n')]));const denied=run(hash(policyBytes));assert.notEqual(denied.status,0);assert.match(denied.stderr,/CI_SOURCE_BYTES_CHANGED:scripts\/runtime-application-registry-v1\.mjs/);}
      finally{await writeFile(runtime,runtimeBytes);}
    }finally{await writeFile(target,originalCi);await writeFile(resolve(fixtureRoot,policyPath),originalPolicy);}
  });
});
