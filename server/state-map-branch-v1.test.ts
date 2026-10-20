import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {branchSeedV1,branchStepRequestV1,branchPublishRequestV1,type StateBranchV1} from './state-map-branch-v1.ts';
const head={revision:'4',rootId:'1'.repeat(64),rootHash:'2'.repeat(64),count:'7',receiptHash:'3'.repeat(64)};
test('branch domain hashes bind tenant, branch, base receipt and stage history separately',()=>{
 const id=randomUUID(),command=randomUUID(),ops=[{namespace:'asset',key:'x',expected:null,valueText:'true'}],seed=branchSeedV1('acme',id,head),stage=branchStepRequestV1('acme',id,command,head,ops),branch:StateBranchV1={format:'STATE_MAP_BRANCH_V1',tenantId:'acme',branchId:id,base:head,head:{...head,revision:'8',receiptHash:'4'.repeat(64)},publishedCommandId:null},publish=branchPublishRequestV1(branch,command);
 assert.notEqual(seed,branchSeedV1('other',id,head));assert.notEqual(seed,branchSeedV1('acme',randomUUID(),head));assert.notEqual(seed,branchSeedV1('acme',id,{...head,receiptHash:'5'.repeat(64)}));
 assert.notEqual(stage,branchStepRequestV1('acme',randomUUID(),command,head,ops));assert.notEqual(stage,branchStepRequestV1('acme',id,command,head,[{...ops[0],valueText:'false'}]));
 assert.notEqual(publish,branchPublishRequestV1({...branch,head:{...branch.head,receiptHash:'6'.repeat(64)}},command));assert.notEqual(stage,publish);assert.notEqual(seed,stage);
});
