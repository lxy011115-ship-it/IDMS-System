import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{observeOwnedReaderHelperChildrenQaV1}from'./fixtures/owned-reader-jvm-failure-v5-qa.mjs';
// Additional observation inputs are separate from the selected diagnostic inner source pins; actual NativeStart must verify the new total.
const sha=b=>createHash('sha256').update(b).digest('hex'),innerPath='scripts/verify-cold-auth-audit-map-v6-request-file-v1.mjs',observerPath='scripts/fixtures/owned-reader-jvm-failure-v5-qa.mjs',innerExpected='2529b54f14e0fabaf2817d70532929a95984f5d83f90fbb5c52b363a9e6ad591',observerExpected='655f3a2555c712f4fc3a48339577191c561399808cde6c61f79e5b8af72ec577';
const check=async()=>{assert.equal(sha(await readFile(innerPath)),innerExpected);assert.equal(sha(await readFile(observerPath)),observerExpected);};
assert.equal(process.argv.length,9);await check();const observer=observeOwnedReaderHelperChildrenQaV1();
try{await import('./verify-cold-auth-audit-map-v6-request-file-v1.mjs');}
finally{const helperObservation=observer.close();await check();console.log(JSON.stringify({format:'COLD_AUTH_AUDIT_MAP_DIAGNOSTIC_BOOTSTRAP_V1',nativePid:process.pid,innerNativeEntrySha256:innerExpected,observerSourceSha256:observerExpected,helperObservation,rawArgumentsOrCredentialsPrinted:false,innerNativeRestarted:false,fullGoalComplete:false}));}
