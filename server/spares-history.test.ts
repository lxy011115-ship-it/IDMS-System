import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,canonical} from './imports.ts';
import {sparesHistoryPlan,SparesHistoryCollector} from './spares-history.ts';
import type {AccessContext} from './access.ts';
const ctx:AccessContext={tenantId:'qa',actorId:'reader',actorType:'USER',authMode:'oidc',roles:['spare-parts-clerk'],correlationId:'qa',scope:{provided:true,sites:['F1'],lines:['*'],devices:['*']}},refs={devices:[{code:'P1',name:'泵',siteCode:'F1'}],orders:[]};
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function chain(count:number){let previous='GENESIS';return Array.from({length:count},(_,i)=>{const after={id:id(i+1),kind:'supplier',tenantId:'qa',siteCode:i%2?'F2':'F1',version:1,code:'SUP-'+(i+1),name:'供应商',phone:'private-contact'},body={tenantId:'qa',actor:'clerk',action:'supplier.create',at:'2026-10-29T16:30:00Z',previousHash:previous,before:[null],after:[after]},hash=digest(canonical(body));previous=hash;return {sequence:String(i+1),site_code:after.siteCode,body,hash};});}
test('history rejects unknown/duplicate parameters, oversized pages, invalid dates and anchors',()=>{
 for(const q of ['limit=0','limit=101','before=01','before=-1','limit=10&limit=20','tenant=other','from=2026-02-30','from=2026-11-01&to=2026-10-30','action=not-valid','entityId=not-an-id'])assert.throws(()=>sparesHistoryPlan(new URLSearchParams(q)));
 const p=sparesHistoryPlan(new URLSearchParams('from=2026-10-30&to=2026-10-30'));assert.equal(p.start,Date.parse('2026-10-29T16:00:00Z'));assert.equal(p.end,Date.parse('2026-10-30T16:00:00Z'));
});
test('keyset pages retain bounded memory while verifying hidden events and numeric sequence order',()=>{
 const rows=chain(20021),a=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams('limit=2')));for(const r of rows)a.accept(r);const first=a.finish(String(rows.length));assert.deepEqual(first.items.map(e=>e.sequence),['20021','20019']);assert.equal(a.maxRetained,3);assert.equal(first.hasMore,true);assert.doesNotMatch(JSON.stringify(first),/private-contact|F2/);
 const b=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams('limit=2&before='+first.nextBefore)));for(const r of rows)b.accept(r);assert.deepEqual(b.finish(String(rows.length)).items.map(e=>e.sequence),['20017','20015']);
});
test('search uses only public summaries; site/device scope is recomputed and hidden tampering fails',()=>{
 const rows=chain(5),filtered=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams('q=SUP-3&from=2026-10-30&to=2026-10-30&entityId='+id(3))));for(const r of rows)filtered.accept(r);assert.deepEqual(filtered.finish('5').items.map(e=>e.sequence),['3']);
 const privateSearch=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams('q=private-contact')));for(const r of rows)privateSearch.accept(r);assert.equal(privateSearch.finish('5').items.length,0);
 const corrupt=structuredClone(rows);corrupt[1].body.actor='tampered';const c=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams('limit=1')));assert.throws(()=>{for(const r of corrupt)c.accept(r);});
 const missing=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams()));for(const r of rows.slice(0,-1))missing.accept(r);assert.throws(()=>missing.finish('5'));
 const hiddenDevice=chain(1);hiddenDevice[0].body.after[0].deviceCode='removed-device';hiddenDevice[0].hash=digest(canonical(hiddenDevice[0].body));const d=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams()));d.accept(hiddenDevice[0]);assert.equal(d.finish('1').items.length,0);
});

test('history excludes an event when its linked work order leaves the current task scope',()=>{
 const rows=chain(1),record=rows[0].body.after[0] as any;record.kind='movement';record.deviceCode='P1';record.workOrderId='W1';rows[0].hash=digest(canonical(rows[0].body));const allowedRefs={...refs,orders:[{id:'W1',deviceCode:'P1',assignee:'reader',state:'IN_PROGRESS'}]};
 const visible=new SparesHistoryCollector(ctx,allowedRefs,sparesHistoryPlan(new URLSearchParams()));visible.accept(rows[0]);assert.equal(visible.finish('1').items.length,1);
 const revoked=new SparesHistoryCollector(ctx,refs,sparesHistoryPlan(new URLSearchParams()));revoked.accept(rows[0]);assert.equal(revoked.finish('1').items.length,0);
});
