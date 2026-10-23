import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {validateControlledColdSourceBundleV1} from './controlled-cold-source-bundle-v1.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
assert.equal(process.argv.length,2);
const expected='02664eb55e17d44a381e6a94f12cd4c2eabdd81993ab41423652e09e06278c50';
const source=resolve('docs/validation/platform-core-public-source-v1.json'),target=resolve('work/runtime-cold-source-bundles-20261022/public-source.json'),bytes=await readFile(source),hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(bytes),expected);const value=validateControlledColdSourceBundleV1(JSON.parse(bytes.toString('utf8')));assert.equal(value.profile,'PUBLIC_APPROVED_TEMPLATES_V1');assert.equal(value.evidence.fileCount,8);assert.equal(value.evidence.totalBytes,2962);
const exists=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(exists){assert(exists.isFile()&&!exists.isSymbolicLink());assert.equal(hash(await readFile(target)),expected);}
else{await privateDirectory(dirname(target));await privateNewFile(target,bytes);}
console.log(JSON.stringify({publicBaselinePrepared:true,existingMatchingBaselineKept:!!exists,sha256:expected,profile:value.profile,fileCount:8,servicesStarted:false}));
