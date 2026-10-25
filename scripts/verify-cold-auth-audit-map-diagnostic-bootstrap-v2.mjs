import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{observeOwnedReaderHelperChildrenQaV1}from'./fixtures/owned-reader-jvm-failure-v4-qa.mjs';
// Additional observation inputs are separate from the selected diagnostic inner source pins; actual NativeStart must verify the new total.
const sha=b=>createHash('sha256').update(b).digest('hex'),innerPath='scripts/verify-cold-auth-audit-map-v6-attach-diagnostic-v1.mjs',observerPath='scripts/fixtures/owned-reader-jvm-failure-v4-qa.mjs',innerExpected='c137eabdba3148571d56c6518300fb2b95b035851af5fcba3d978c6524901002',observerExpected='a8c3c63f1817dc7ee0544c2b5e4582fec83c5d0dc207afe4c1f1e2ccd0593523';
const check=async()=>{assert.equal(sha(await readFile(innerPath)),innerExpected);assert.equal(sha(await readFile(observerPath)),observerExpected);};
assert.equal(process.argv.length,9);await check();const observer=observeOwnedReaderHelperChildrenQaV1();
try{await import('./verify-cold-auth-audit-map-v6-attach-diagnostic-v1.mjs');}
finally{const helperObservation=observer.close();await check();console.log(JSON.stringify({format:'COLD_AUTH_AUDIT_MAP_DIAGNOSTIC_BOOTSTRAP_V1',nativePid:process.pid,innerNativeEntrySha256:innerExpected,observerSourceSha256:observerExpected,helperObservation,rawArgumentsOrCredentialsPrinted:false,innerNativeRestarted:false,fullGoalComplete:false}));}
