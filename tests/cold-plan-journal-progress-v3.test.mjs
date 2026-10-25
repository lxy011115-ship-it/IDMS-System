import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {coldOwnedReviewProgressQaV1} from '../scripts/fixtures/cold-plan-journal-progress-v3-qa.mjs';
test('observation rejects traversal and arbitrary directory claims before reading files',async()=>{
 for(const nonce of ['../private','',randomUUID(),'A'.repeat(12)])await assert.rejects(coldOwnedReviewProgressQaV1(resolve('.'),nonce),/COLD_REVIEW_PROGRESS_NONCE/);
});
test('observation emits only counters and sizes while private contents remain unread',async()=>{
 const root=resolve('work/cold-plan-journal-progress-v3-tests',randomUUID()),nonce='123456abcdef',review=join(root,'work/cold-plan-journal-native-v3-20261025',nonce,'review-private'),id=randomUUID(),session=join(review,'owned-session-'+id);
 await mkdir(session,{recursive:true});const secret='SENTINEL_PRIVATE_VALUE_NEVER_READ';
 await writeFile(join(review,'readers.private.json'),secret);await writeFile(join(review,'target-map-acme-'+id+'.jsonl'),'private original source rows\n');
 await writeFile(join(session,'peers-'+id+'.private.json'),secret);await writeFile(join(session,'intent-derived-reader.private.json'),secret);
 const got=await coldOwnedReviewProgressQaV1(root,nonce);assert.equal(got.targetEvidenceFiles,1);assert.equal(got.originalSessionPeerEvidenceFiles,1);assert.equal(got.targetEvidenceBytes,Buffer.byteLength('private original source rows\n'));assert.equal(got.latestTargetEvidenceBytes,got.targetEvidenceBytes);
 assert.deepEqual(Object.keys(got).sort(),['latestTargetEvidenceBytes','latestTargetEvidenceModifiedAt','originalSessionPeerEvidenceFiles','targetEvidenceBytes','targetEvidenceFiles']);assert(!JSON.stringify(got).includes(secret)&&!JSON.stringify(got).includes(id)&&!JSON.stringify(got).includes('source rows'));
});
