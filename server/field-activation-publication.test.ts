import test from 'node:test';
import assert from 'node:assert/strict';
import {activationPublicationIntent,FieldActivationPublication} from '../scripts/field-activation-publication.mjs';
const operationId='11111111-1111-4111-8111-111111111111',attemptId='22222222-2222-4222-8222-222222222222',planId='33333333-3333-4333-8333-333333333333',h='a'.repeat(64);
function intent(){
 const before={format:'idms-field-recovery-control-v1',tenantId:'acme',identity:{format:'idms-field-recovery-identity-v1',deploymentId:'44444444-4444-4444-8444-444444444444',activationId:'55555555-5555-4555-8555-555555555555',databaseBindingSha256:h},state:'RESTORING',operationId,previousActivationId:'66666666-6666-4666-8666-666666666666',changedAtMs:1000};
 return {format:'idms-field-activation-publication-intent-v1',tenantId:'acme',operationId,attemptId,operationIntentSha256:h,authorityId:h,ownerHostId:h,controlPathSha256:h,planId,planSha256:h,approvalPhase:{format:'idms-field-recovery-review-phase-v1',operationId,backupId:'77777777-7777-4777-8777-777777777777',databaseName:'idms_qa_target',databaseOid:'12345',planId,attemptId:'88888888-8888-4888-8888-888888888888',stage:'APPROVED',parentSha256:h,restorePhaseSha256:h,contentSha256:h,auditEventId:'99999999-9999-4999-8999-999999999999',auditHead:h,auditEvents:5,revision:5},registrationSha256:h,configSha256:h,before,after:{...before,state:'ACTIVE',operationId:null,previousActivationId:null,changedAtMs:2000},createdAtMs:2000};
}
test('activation file intent preserves the exact approved recovery identity and clears only the operation fields',()=>{
 const original=intent(),copy=activationPublicationIntent(original);assert.deepEqual(copy,original);original.after.identity.activationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';assert.notEqual(copy.after.identity.activationId,original.after.identity.activationId);
 const edits=[(v:any)=>v.approvalPhase.stage='SUBMITTED',(v:any)=>v.approvalPhase.planId=attemptId,(v:any)=>v.after.identity={...v.after.identity,databaseBindingSha256:'b'.repeat(64)},(v:any)=>v.after.operationId=operationId,(v:any)=>v.after.previousActivationId=v.before.previousActivationId,(v:any)=>v.after.changedAtMs++,(v:any)=>v.createdAtMs=999,(v:any)=>v.registrationSha256='invalid',(v:any)=>v.before.tenantId='sandbox',(v:any)=>v.format='idms-field-activation-publication-intent-v2'];
 for(const edit of edits){const v=intent();edit(v);assert.throws(()=>activationPublicationIntent(v));}
});
test('activation publication rejects reserved and ambiguous control filenames before claiming the authority workspace',()=>{
 let claimed=false;const guard={setWorkspace(){claimed=true;}};
 for(const name of ['CON','NUL.json','recovery.json.','COM1.txt','recovery?.json']){assert.throws(()=>new FieldActivationPublication(guard,name));assert.equal(claimed,false);}
});
