import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
// Historical frame/root rules remain independent unit fixtures. The current
// production entrypoint is exercised through its current source protocol.
for(const args of [['--test','server/cold-proof.test.ts'],['scripts/verify-cold-imports.mjs']]){console.log('Cold regression:',args.at(-1));const child=spawn(process.execPath,args,{windowsHide:true,stdio:'inherit'});const code=await new Promise((ok,reject)=>{child.once('error',reject);child.once('exit',ok);});assert.equal(code,0,'Cold regression process failed');}
const production=JSON.parse(await readFile('outputs/cold-imports-verification.json')),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const proof={verifiedAt:new Date().toISOString(),historicalFramedCanonicalUnitCorpusPassed:true,historicalVerifierSha256:sha(await readFile('server/cold-proof.ts')),historicalUnitSha256:sha(await readFile('server/cold-proof.test.ts')),currentProductionVerifier:'batchwise-input-fact-proof-v1',currentProductionProof:production,historicalOriginalNativeScriptPreserved:'scripts/verify-cold-proof.mjs',sourceFramingNoLongerUsesTheHistoricalSqlFrameProtocol:true,productionAcceptance:false};await writeFile('outputs/cold-proof-verification.json',JSON.stringify(proof,null,2));
