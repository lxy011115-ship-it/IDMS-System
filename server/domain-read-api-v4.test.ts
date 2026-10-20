import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryAuditCursorCodec} from './audit-cursor.ts';
import {parseDomainReadPageV4,domainReadAccessV4} from './domain-read-api-v4.ts';
import type {AccessContext} from './access.ts';
const ctx:AccessContext={tenantId:'sandbox',actorId:'subject',actorType:'USER',correlationId:'test',authMode:'oidc',roles:['equipment-admin'],scope:{provided:true,sites:['SITE'],lines:[],devices:[]}};
test('v4 reads require verified OIDC user and actual scope even for direct callers',()=>{
 assert.doesNotThrow(()=>domainReadAccessV4(ctx));for(const bad of [{...ctx,scope:undefined},{...ctx,scope:{provided:true,sites:[],lines:[],devices:[]}},{...ctx,authMode:'demo' as const},{...ctx,actorType:'INTERFACE'}])assert.throws(()=>domainReadAccessV4(bad));
});
test('v4 read page parameters and purpose reject duplicates, oversized pages and foreign cursors',()=>{
 const codec=memoryAuditCursorCodec();assert.equal(parseDomainReadPageV4(new URLSearchParams('pageSize=3'),'AUDIT',ctx,codec).pageSize,3);
 for(const query of ['pageSize=1&pageSize=2','pageSize=21','pageSize=01','root=arbitrary','cursor=x'])assert.throws(()=>parseDomainReadPageV4(new URLSearchParams(query),'AUDIT',ctx,codec));
 assert.throws(()=>parseDomainReadPageV4(new URLSearchParams({cursor:codec.seal({purpose:'IDMS_AUDIT_PAGE_CURSOR_V1'})}),'AUDIT',ctx,codec));
});
