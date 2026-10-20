import {test} from 'node:test';
import assert from 'node:assert/strict';
import {governanceBasicAccessV4,type GovernanceCommandV4} from './governance-plan-v4.ts';
import type {AccessContext} from './access.ts';
test('typed governance gate rejects arbitrary actions, demo/AI actors, missing scope and role spoofing',()=>{
 const ctx:AccessContext={tenantId:'acme',actorId:'author',actorType:'USER',correlationId:'qa',authMode:'oidc',roles:['tenant-admin','data-uploader']},command:GovernanceCommandV4={action:'TEMPLATE_CREATE',input:{}};
 assert.doesNotThrow(()=>governanceBasicAccessV4(command,ctx));
 for(const denied of [{...ctx,authMode:'demo' as const},{...ctx,actorType:'AI'},{...ctx,roles:['auditor'],permissions:['read','template:edit']},{...ctx,roles:['data-uploader'],scope:undefined}])assert.throws(()=>governanceBasicAccessV4(command,denied));
 for(const bad of [{action:'__proto__',input:{}},{action:'RAW_DELTA',input:{}},{...command,namespace:'audit'},{...command,input:[]}])assert.throws(()=>governanceBasicAccessV4(bad as GovernanceCommandV4,ctx));
});
