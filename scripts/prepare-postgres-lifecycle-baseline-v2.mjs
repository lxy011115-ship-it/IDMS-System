import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
const value=JSON.parse(await readFile('docs/validation/postgres-lifecycle-baseline-v2.json','utf8'));
assert.equal(value.format,'IDMS_POSTGRES_LIFECYCLE_SOURCE_BASELINE_V2');assert.equal(value.commit,'b1a351b0cb6fd798082a5c0742e8d5b00fc25a20');assert.equal(value.blobs.length,640);
const seen=new Set();for(const row of value.blobs){assert(/^[A-Za-z0-9_./-]+$/.test(row.path)&&!row.path.startsWith('/')&&!row.path.split('/').includes('..')&&!seen.has(row.path));seen.add(row.path);assert.equal(createHash('sha256').update(await readFile(resolve(row.path))).digest('hex'),row.sha256);}
await privateDirectory('work/postgres-lifecycle-baseline-v2-20261023');
await privateNewFile('work/postgres-lifecycle-baseline-v2-20261023/git-publication.json',JSON.stringify({...value,sourceBaselineOnly:true}));
console.log(JSON.stringify({sourceBaselineVerified:true,sourceBaselineCommit:value.commit,unchangedManagedBlobs:640,historicalParentBaselineRewritten:false,nativePostgresExecuted:false}));
