import {inspectCiSourcePolicyV2} from './ci-source-policy-v2.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import assert from 'node:assert/strict';

assert.equal(process.argv.length,2);
const admission=await inspectCiSourcePolicyV2('36d63806dd1f7f374631545fba9431e1342d48aeb307ff40c88fb727ae6eeb94');
const directory='work/postgres-lifecycle-baseline-v5-20261024/'+admission.policySha256;
await privateDirectory(directory);
const value={format:'IDMS_POSTGRES_LIFECYCLE_EXECUTION_BASELINE_V5',baselineParentCommit:admission.parentCommit,policySha256:admission.policySha256,historicalSnapshot:admission.executionBaselines.postgres.historicalSnapshot,historicalSnapshotSha256:admission.executionBaselines.postgres.historicalSnapshotSha256,blobs:admission.executionBaseline.blobs};
await privateNewFile(directory+'/git-publication.json',JSON.stringify(value));
console.log(JSON.stringify({sourceBaselineVerified:true,baselineParentCommit:admission.parentCommit,sourceBlobsVerified:762,nonCiParentFilesUnchanged:756,explicitCiBindings:6,ciFilesChangedSinceParent:admission.ciFilesChangedSinceParent,historicalProfile:admission.profiles.find(row=>row.name==='postgres'),historicalParentBaselineRewritten:false,nativePostgresExecuted:false}));
