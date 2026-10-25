import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{observeOwnedReaderHelperChildrenQaV1}from'./fixtures/owned-reader-jvm-failure-v2-qa.mjs';
// Additional observation inputs are separate from the unchanged 1733 inner native source pins.
const sha=b=>createHash('sha256').update(b).digest('hex'),innerPath='scripts/verify-cold-auth-audit-map-v6.mjs',observerPath='scripts/fixtures/owned-reader-jvm-failure-v2-qa.mjs',innerExpected='a65b8fad49eacff8a7542c95c7f451a171066b9c1876b96a8c4e5086e94a9916',observerExpected='b1ce9adc1de66816cdd2238f955faea766feb56dc2a4366ce1f13273e6c423e7';
const check=async()=>{assert.equal(sha(await readFile(innerPath)),innerExpected);assert.equal(sha(await readFile(observerPath)),observerExpected);};
assert.equal(process.argv.length,9);await check();const observer=observeOwnedReaderHelperChildrenQaV1();
try{await import('./verify-cold-auth-audit-map-v6.mjs');}
finally{const helperObservation=observer.close();await check();console.log(JSON.stringify({format:'COLD_AUTH_AUDIT_MAP_DIAGNOSTIC_BOOTSTRAP_V1',nativePid:process.pid,innerNativeEntrySha256:innerExpected,observerSourceSha256:observerExpected,helperObservation,rawArgumentsOrCredentialsPrinted:false,innerNativeRestarted:false,fullGoalComplete:false}));}
