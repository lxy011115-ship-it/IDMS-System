import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {PredictiveCancelJobCryptoV1} from './predictive-cancel-job-crypto-v1.ts';
import {cancelJobCommandV1,cancelJobHashesV1,verifyCancelJobCommandV1} from './predictive-cancel-job-input-v1.ts';
const binding={tenantId:'sandbox',databaseOid:'123',roleOid:'456',deployment:'a'.repeat(64),catalogHash:'b'.repeat(64),stateCatalogHash:'c'.repeat(64)},ring={format:1,activeKeyId:'qa',keys:[{keyId:'qa',key:randomBytes(32).toString('base64url')}]};
const command=()=>{const id=randomUUID();return {action:'OPEN' as const,caseId:id,request:{id,commandId:randomUUID(),expectedNativeHash:'e'.repeat(64)}};};
test('sealed session references bind case, action, operation, actor, request, deployment and authorization generation',()=>{
 const c=command(),meta={id:randomUUID(),caseId:c.caseId,operationId:c.caseId,actorId:randomUUID(),action:c.action,...cancelJobHashesV1(c)},crypto=new PredictiveCancelJobCryptoV1(ring,binding),reference={kind:'SESSION',value:'z'.repeat(43)},sealed=crypto.seal(reference,meta,'GRANT','2');assert.deepEqual(crypto.open(sealed,meta,'GRANT','2'),reference);
 for(const patch of [{caseId:randomUUID()},{operationId:randomUUID()},{actorId:randomUUID()},{requestHash:'d'.repeat(64)},{domainHash:'d'.repeat(64)},{action:'REVIEW'}])assert.throws(()=>crypto.open(sealed,{...meta,...patch} as any,'GRANT','2'),/SEALED_INTEGRITY/);
 assert.throws(()=>crypto.open(sealed,meta,'GRANT','1'),/SEALED_INTEGRITY/);assert.throws(()=>crypto.open(sealed,meta,'COMMAND','2'),/SEALED_INTEGRITY/);assert.throws(()=>new PredictiveCancelJobCryptoV1(ring,{...binding,tenantId:'acme'}).open(sealed,meta,'GRANT','2'),/SEALED_INTEGRITY/);assert.throws(()=>new PredictiveCancelJobCryptoV1(ring,{...binding,deployment:'d'.repeat(64)}).open(sealed,meta,'GRANT','2'),/SEALED_INTEGRITY/);
});
test('HTTP commands cannot supply another actor, an external receipt, or a different case/action than the authenticated sealed job',()=>{
 const c=command(),parsed=cancelJobCommandV1(c),meta={id:randomUUID(),caseId:c.caseId,operationId:c.caseId,actorId:randomUUID(),action:c.action,...cancelJobHashesV1(c)};assert.deepEqual(verifyCancelJobCommandV1(meta,parsed),parsed);
 for(const changed of [{...c,actorId:randomUUID()},{...c,request:{...c.request,externalReceipt:{outcome:'BLOCKED'}}},{...c,caseId:randomUUID()}])assert.throws(()=>cancelJobCommandV1(changed),/RECON/);
 assert.throws(()=>verifyCancelJobCommandV1({...meta,operationId:randomUUID()},parsed),/SEALED_COMMAND_BINDING/);assert.throws(()=>verifyCancelJobCommandV1({...meta,domainHash:'f'.repeat(64)},parsed),/SEALED_COMMAND_BINDING/);
});
