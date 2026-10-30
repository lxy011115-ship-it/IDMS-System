import assert from 'node:assert/strict';
import {resolve,isAbsolute} from 'node:path';
import {readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {verifyFieldMapFullEvidenceFastV1} from './field-map-full-evidence-fast-v1.mjs';
try{
 assert.equal(process.argv.length,3);
 const input=await readApplicationFileV1(process.argv[2]),body=JSON.parse(input.bytes.toString('utf8'));
 assert(Object.keys(body).sort().join(',')===['format','nonce','file','expectedFacts','workDirectory'].sort().join(','));
 assert(body.format==='FIELD_MAP_ORIGINAL_EVIDENCE_WORKER_INPUT_V2'&&typeof body.nonce==='string'&&/^[a-f0-9]{64}$/.test(body.nonce)&&[body.file,body.workDirectory].every(p=>typeof p==='string'&&isAbsolute(p)&&resolve(p)===p));
 const result=await verifyFieldMapFullEvidenceFastV1({file:body.file,expectedFacts:body.expectedFacts,workDirectory:body.workDirectory});
 assert((await readApplicationFileV1(input.path)).sha256===input.sha256);
 console.log(JSON.stringify({format:'FIELD_MAP_ORIGINAL_EVIDENCE_WORKER_RESULT_V2',nonce:body.nonce,inputSha256:input.sha256,result}));
}catch(error){console.error(typeof error?.message==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'FIELD_MAP_ORIGINAL_EVIDENCE_WORKER_REJECTED');process.exitCode=1;}
