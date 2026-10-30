import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {readRuntimeColdReviewWithFieldSourceV2} from '../scripts/runtime-cold-readonly-control-v7.mjs';
import {verifyCurrentDeploymentControlIndependentQaV3 as verify,readCurrentDeploymentOriginalPeerEvidenceIndependentQaV1 as peers} from '../scripts/fixtures/current-deployment-control-independent-v3-qa.mjs';
const inputFile=process.env.IDMS_CURRENT_DEPLOYMENT_INDEPENDENT_FIXTURE;assert(typeof inputFile==='string'&&isAbsolute(inputFile));
const fixture=JSON.parse(await readFile(inputFile,'utf8')),bytes=await readFile(join(fixture.caseDirectory,'verification.json'));
assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.reportSha256);
const report=JSON.parse(bytes);assert(report.passed&&report.checks.length===60&&report.implementationVersion===15);
const cases=[];for(const item of report.fieldCurrentMaterialsNative.cases)cases.push({item,state:await readRuntimeColdReviewWithFieldSourceV2(item.trust)});
assert.equal(cases.length,2);
for(const c of cases)test('actual '+c.item.mode+' intent, independent HMACs, original peer endpoint and private bytes authenticate',async()=>{
 assert.equal(Object.hasOwn(c.item.currentMaterial.finalOriginalPeerObservation,'evidenceFile'),false);
 const value=await verify(c);assert(value.rawIntentRowAndBothHmacAnchorsIndependentlyRebuilt&&value.newReadonlyCredentialsAndActualTargetEndpointBound&&value.privateFileIdentityAndBytesBound&&value.originalFilesUnchanged);
 assert(value.programInputFilesIndependentlyRead>=8);assert.equal(value.newHeldOrProgramApprovalInferred,false);
});
test('a missing original peer digest fails without using a caller-supplied evidence path',async()=>{
 const c=cases[0],item=structuredClone(c.item);item.currentMaterial.finalOriginalPeerObservation.evidenceSha256='0'.repeat(64);item.currentMaterial.finalOriginalPeerObservation.evidenceFile='ignored-untrusted-location';
 await assert.rejects(peers(item,c.state),/CURRENT_DEPLOYMENT_ORIGINAL_PEER_DIGEST_MATCH/);
});
test('an authentic peer file from a different reader lease is rejected',async()=>{
 const c=cases[0],item=structuredClone(c.item);item.sessionHeld.readerLeaseId='different-session-lease';await assert.rejects(peers(item,c.state));
});
