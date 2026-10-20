import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {PredictiveJobCryptoV4} from './predictive-job-crypto-v4.ts';
import {openPredictiveCommandV4} from './predictive-command-worker-v4.ts';
import {canonicalDigest} from './canonical-state.ts';
function fixture(command:unknown,action='ANALYZE'){
 const crypto=new PredictiveJobCryptoV4({format:1,activeKeyId:'test',keys:[{keyId:'test',key:randomBytes(32).toString('base64url')}]},{tenantId:'sandbox',databaseOid:'123',roleOid:'456',catalogHash:'a'.repeat(64),deployment:'b'.repeat(64)});
 const meta={id:randomUUID(),commandId:randomUUID(),actorId:'original-user',requestHash:canonicalDigest(command)};
 return {crypto,job:{...meta,action,sealedCommand:crypto.seal(command,meta,'COMMAND')}};
}
test('a valid authenticated box cannot substitute an analysis command with unsupported client-supplied fields',()=>{
 const {crypto,job}=fixture({kind:'ANALYZE',deviceCode:'PUMP-1',source:'APPROVED_IMPORT',serviceToken:'untrusted'});
 assert.throws(()=>openPredictiveCommandV4(job,crypto),/PREDICTIVE_ANALYSIS_INPUT/);
});
test('specific queued action must match the authenticated command kind even with a valid digest and box',()=>{
 const command={kind:'ANALYZE',deviceCode:'PUMP-1',source:'APPROVED_IMPORT'},f=fixture(command,'REVIEW');
 assert.throws(()=>openPredictiveCommandV4(f.job,f.crypto),/PREDICTIVE_COMMAND_BINDING/);
 const good=fixture(command);assert.deepEqual(openPredictiveCommandV4(good.job,good.crypto),command);
});
test('a valid authenticated review box still requires the independent review version and evidence shape',()=>{
 const {crypto,job}=fixture({kind:'REVIEW',alertId:'alert-1',expectedVersion:0,evidenceDigest:'a'.repeat(64),decision:'APPROVED',comment:'review'},'REVIEW');
 assert.throws(()=>openPredictiveCommandV4(job,crypto),/PREDICTIVE_REVIEW_INPUT/);
});
