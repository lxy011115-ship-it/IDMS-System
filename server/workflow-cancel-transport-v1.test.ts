import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowCancelTransportV1,WorkflowCancelProofV1} from './workflow-cancel-transport-v1.ts';
const config={baseUrl:'http://127.0.0.1:1',tenantId:'acme',token:'private-test-credential-'.repeat(2),authorityId:'11111111-1111-1111-1111-111111111111',catalogHash:'a'.repeat(64)};
test('external reconciliation refuses public cleartext, redirected paths and absent authority/catalog witnesses',()=>{
 for(const patch of [{baseUrl:'http://example.com/'},{baseUrl:'http://127.0.0.1:1/a'},{baseUrl:'http://user:password@127.0.0.1:1/'},{authorityId:''},{catalogHash:''},{token:'x\n'.repeat(40)}])assert.throws(()=>new WorkflowCancelTransportV1({...config,...patch}),/WORKFLOW_CANCEL_CONFIG/);
});
test('untrusted JSON cannot manufacture an external cancellation decision proof',()=>{
 assert.throws(()=>new WorkflowCancelProofV1(Symbol('caller-created'),{} as any,'binding',{} as any),/WORKFLOW_CANCEL_PROOF_CONSTRUCTOR/);
});
test('invalid original/control identifiers fail before a network call can create a block',async()=>{
 const transport=new WorkflowCancelTransportV1(config);
 await assert.rejects(()=>transport.decide('not-a-control',{} as any),/WORKFLOW_CANCEL_CONTROL_ID/);
 await assert.rejects(()=>transport.decide(config.authorityId,null as any),/WORKFLOW_CANCEL_ORIGINAL_ENVELOPE/);
 await assert.rejects(()=>transport.decide(config.authorityId,{commandId:config.authorityId,entityId:config.authorityId,action:'claim',expectedVersion:1,requestDigest:'a'.repeat(64)} as any),/WORKFLOW_CANCEL_ORIGINAL_ENVELOPE/);
});
