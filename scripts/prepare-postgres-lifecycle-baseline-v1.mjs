import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {privateNewFile} from './backup-support.mjs';
const value=JSON.parse(await readFile('docs/validation/postgres-lifecycle-baseline-v1.json','utf8'));
assert.equal(value.format,'IDMS_POSTGRES_LIFECYCLE_PARENT_BASELINE_V1');assert.equal(value.commit,'bc0d65da9182ca1caa8ea0a91a4b211d104e1fce');assert.equal(value.blobs.length,596);
const seen=new Set();for(const row of value.blobs){assert(/^[A-Za-z0-9_./-]+$/.test(row.path)&&!row.path.startsWith('/')&&!row.path.split('/').includes('..')&&!seen.has(row.path));seen.add(row.path);assert.equal(createHash('sha256').update(await readFile(resolve(row.path))).digest('hex'),row.sha256);}
// Compatibility input for the unchanged native verifier. The commit identifies
// these 596 parent blobs, not the new module or the current GitHub HEAD.
await privateNewFile('work/application-suite-20261023/git-publication.json',JSON.stringify({commit:value.commit,blobs:value.blobs,parentBaselineOnly:true}));
console.log(JSON.stringify({parentBaselineVerified:true,parentCommit:value.commit,unchangedManagedBlobs:596}));
