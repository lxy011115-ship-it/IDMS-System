import test from 'node:test';
import assert from 'node:assert/strict';
import type {AccessContext} from './access.ts';
import {currentHistoryPlan,historyPageCursor,historyPageAnchor} from './spares-history-cursor.ts';
const ctx:AccessContext={tenantId:'qa',actorId:'reader',actorType:'USER',authMode:'oidc',roles:['spare-parts-clerk'],correlationId:'qa',scope:{provided:true,sites:['F1'],lines:['*'],devices:['*']}},stamp={revision:'20001',publicRevision:'7'};
test('current history requires signed opaque cursors and rejects duplicate or malformed input',()=>{
 for(const q of ['before=12','before=','before=x.y&before=x.y','before='+('a'.repeat(2100))+'.'+'a'.repeat(43),'limit=101','before=x.'+'a'.repeat(43)+'&tenant=other'])assert.throws(()=>currentHistoryPlan(new URLSearchParams(q)));
 const plan=currentHistoryPlan(new URLSearchParams('limit=2&q=备件')),cursor=historyPageCursor(ctx,plan,stamp,'19999'),next=currentHistoryPlan(new URLSearchParams({limit:'2',q:'备件',before:cursor}));assert.equal(historyPageAnchor(ctx,next,stamp),19999n);
 for(const anchor of ['0','-1','01','9223372036854775808'])assert.throws(()=>historyPageCursor(ctx,plan,stamp,anchor));
 const [body,mac]=next.cursor.split('.'),edited={...next,cursor:body+'.'+(mac.startsWith('a')?'b':'a')+mac.slice(1)};assert.throws(()=>historyPageAnchor(ctx,edited,stamp),e=>(e as any).status===400);
});
test('history cursor binds identity, roles, scope, filters, page size and both revisions',()=>{
 const plan=currentHistoryPlan(new URLSearchParams('limit=2')),next={...plan,cursor:historyPageCursor(ctx,plan,stamp,'19999')};
 for(const actor of [{...ctx,tenantId:'other'},{...ctx,actorId:'other'},{...ctx,roles:['tenant-admin']},{...ctx,scope:{...ctx.scope!,sites:['F2']}}])assert.throws(()=>historyPageAnchor(actor,next,stamp),e=>(e as any).status===409);
 for(const changed of [{...stamp,revision:'20002'},{...stamp,publicRevision:'8'}])assert.throws(()=>historyPageAnchor(ctx,next,changed),e=>(e as any).status===409);
 for(const changed of [{...next,q:'private-contact'},{...next,limit:3},{...next,action:'part.create'}])assert.throws(()=>historyPageAnchor(ctx,changed,stamp),e=>(e as any).status===409);
});
