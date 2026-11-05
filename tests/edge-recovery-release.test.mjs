import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRecoveryCi} from '../scripts/edge-recovery-release.mjs';
test('recovery qualification requires the exact successful maintenance commit and workflow',()=>{
 const head='a'.repeat(40),run={id:123,head_sha:head,head_branch:'release/prelaunch-20261030',name:'Linux source verification',path:'.github/workflows/linux-verification.yml',status:'completed',conclusion:'success',html_url:'https://github.com/lxy011115-ship-it/IDMS-System/actions/runs/123'};
 assert.equal(validateRecoveryCi(run,head).ciRunId,123);
 for(const change of [{head_sha:'b'.repeat(40)},{head_branch:'main'},{status:'in_progress'},{conclusion:'failure'},{conclusion:'cancelled'},{name:'another workflow'},{path:'.github/workflows/another.yml'},{html_url:'https://example.com/run'},{id:-1}])assert.throws(()=>validateRecoveryCi({...run,...change},head),/SAME_COMMIT_CI_REQUIRED/);
});
