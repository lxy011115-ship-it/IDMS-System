import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {PredictiveJobCryptoV4} from './predictive-job-crypto-v4.ts';
import {canonicalDigest} from './canonical-state.ts';
const binding={tenantId:'sandbox',databaseOid:'1234',roleOid:'5678',catalogHash:'a'.repeat(64),deployment:'b'.repeat(64)};
const ring=()=>({format:1 as const,activeKeyId:'k1',keys:[{keyId:'k1',key:randomBytes(32).toString('base64url')}]});
const job=()=>({id:randomUUID(),actorId:'engineer',commandId:randomUUID(),requestHash:canonicalDigest({action:'claim'})});
test('predictive encrypted grant is bound to its purpose, actor, command, deployment, tenant, database and revision',()=>{
 const keys=ring(),meta=job(),crypto=new PredictiveJobCryptoV4(keys,binding),ref={kind:'SESSION',value:randomBytes(32).toString('base64url')},sealed=crypto.seal(ref,meta,'GRANT','2');
 assert.deepEqual(crypto.open(sealed,meta,'GRANT','2'),ref);
 for(const changed of [{...meta,id:randomUUID()},{...meta,actorId:'other'},{...meta,commandId:randomUUID()},{...meta,requestHash:'c'.repeat(64)}])assert.throws(()=>crypto.open(sealed,changed,'GRANT','2'),/SEALED_INTEGRITY/);
 for(const changed of [{...binding,tenantId:'acme'},{...binding,databaseOid:'9999'},{...binding,deployment:'d'.repeat(64)}])assert.throws(()=>new PredictiveJobCryptoV4(keys,changed).open(sealed,meta,'GRANT','2'),/SEALED_INTEGRITY/);
 assert.throws(()=>crypto.open(sealed,meta,'COMMAND','2'),/SEALED_INTEGRITY/);assert.throws(()=>crypto.open(sealed,meta,'GRANT','1'),/SEALED_INTEGRITY/);
 assert.throws(()=>crypto.open({...sealed,tag:Buffer.alloc(16).toString('base64url')},meta,'GRANT','2'),/SEALED_INTEGRITY/);
 assert.throws(()=>crypto.open({...sealed,extra:true},meta,'GRANT','2'),/SEALED_INTEGRITY/);
});
test('predictive key rotation reads old ciphertext and writes with the active key',()=>{
 const keys=ring(),meta=job(),first=new PredictiveJobCryptoV4(keys,binding),old=first.seal({id:'order'},meta,'COMMAND'),next={...keys,activeKeyId:'k2',keys:[...keys.keys,{keyId:'k2',key:randomBytes(32).toString('base64url')}]},rotated=new PredictiveJobCryptoV4(next,binding);
 assert.deepEqual(rotated.open(old,meta,'COMMAND'),{id:'order'});const fresh=rotated.seal({id:'order'},meta,'COMMAND');assert.equal(fresh.keyId,'k2');assert.throws(()=>first.open(fresh,meta,'COMMAND'),/SEALED_INTEGRITY/);
});
