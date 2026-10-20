import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendAudit,verifyAuditChain,AuditChainVerifier} from './audit.ts';
import {seedStore} from './store.ts';
import type {AuditEvent} from './domain.ts';
import type {AccessContext} from './access.ts';
import {memoryAuditCursorCodec,AuditPageError} from './audit-cursor.ts';
import {AuditPageCollector,auditHead,auditPageLifetime,auditPageResponse,parseAuditPage,type AuditPagePlan,type AuditPageRow} from './audit-page.ts';
const ctx:AccessContext={tenantId:'acme',actorId:'auditor-1',actorType:'USER',authMode:'oidc',roles:['auditor'],permissions:['read'],correlationId:'test',scope:{provided:true,sites:['*'],lines:['*'],devices:['*']}};
const now=Date.parse('2026-10-16T10:00:00Z');
const codec=memoryAuditCursorCodec();
const plan=(params='pageSize=7',who=ctx)=>parseAuditPage(new URLSearchParams(params),who,codec,now)!;
const errorCode=(code:string,status?:number)=>(e:unknown)=>e instanceof AuditPageError&&e.code===code&&(status===undefined||e.status===status);
function rows(count=37):AuditPageRow[]{const store=seedStore();store.audits=[];const result:AuditPageRow[]=[];for(let i=0;i<count;i++){
 const event=appendAudit(store,{tenantId:'acme',objectType:i%2?'DEVICE':'TELEMETRY_EVENT',objectId:'object-'+i,action:i%3?'QA':'OTHER',actorType:'USER',actorId:'actor-'+i%2,correlationId:'test',metadata:{comment:'search '+i,site:i%2?'F1':'F2'}});result.push({sequence:String(i*2+1),tenant_id:'acme',event_id:event.eventId,hash:event.hash,previous_hash:event.previousHash,event});store.audits=[event];}return result;}
function collect(all:AuditPageRow[],p:AuditPagePlan,visible=(event:AuditEvent)=>true,options:any={}){const collector=new AuditPageCollector(p,auditHead(all.at(-1)),visible,{clock:()=>now,...options});try{for(const row of all)collector.accept(row);return {slice:collector.finish(),collector};}catch(e){collector.discard();throw e;}}
function response(all:AuditPageRow[],p:AuditPagePlan,visible=(event:AuditEvent)=>true){return auditPageResponse(collect(all,p,visible).slice,p,codec,false);}
function next(token:string){return plan('cursor='+encodeURIComponent(token));}
test('audit query parsing is strict, normalized and bound to identity, permissions and effective scope',()=>{
 assert.equal(parseAuditPage(new URLSearchParams(),ctx,codec),undefined);assert.equal(plan('q=%20SEARCH%20').filters.q,'search');assert.equal(plan().pageSize,7);
 for(const q of ['pageSize=0','pageSize=201','pageSize=01','pageSize=2.0','pageSize=','q=a&q=b','cursor=a&cursor=b','page=1','q=%00','q='+('a'.repeat(161)),'from=2026-02-30T00:00:00Z','from=2026-10-16','from=2026-10-16T00:00:00','from=2026-10-17T00:00:00Z&to=2026-10-16T00:00:00Z'])assert.throws(()=>plan(q),errorCode('AUDIT_QUERY_INVALID'));
 const a=response(rows(),plan()),token=a.nextCursor!;assert.throws(()=>plan('cursor='+encodeURIComponent(token),{...ctx,actorId:'other'}),errorCode('AUDIT_CURSOR_INVALID',400));assert.throws(()=>plan('cursor='+encodeURIComponent(token),{...ctx,permissions:['read','analyze']}),errorCode('AUDIT_SCOPE_CHANGED',409));assert.throws(()=>plan('cursor='+encodeURIComponent(token)+'&q=different'),errorCode('AUDIT_QUERY_CHANGED',400));assert.throws(()=>plan('cursor='+encodeURIComponent(token)+'&pageSize=8'),errorCode('AUDIT_QUERY_CHANGED'));
 const restricted={...ctx,roles:['production-supervisor'],scope:{provided:true,sites:['F1'],lines:['*'],devices:['*']}};const restrictedToken=response(rows(),plan('pageSize=7',restricted)).nextCursor!;assert.throws(()=>plan('cursor='+encodeURIComponent(restrictedToken),{...restricted,scope:{...restricted.scope,sites:['F2']}}),errorCode('AUDIT_SCOPE_CHANGED'));
 const duplicateRoles={...ctx,roles:['auditor','auditor']};assert.equal(plan('cursor='+encodeURIComponent(token),duplicateRoles).prior?.identity,next(token).prior?.identity);
});
test('signed malformed cursor bodies, future windows and fixed expired windows fail before SQL',()=>{
 const a=response(rows(),plan()),body:any=codec.open(a.nextCursor!);for(const edit of [(v:any)=>v.extra=true,(v:any)=>v.pageSize=201,(v:any)=>v.move.anchor.sequence='01',(v:any)=>v.window.head.sequence='9223372036854775808',(v:any)=>v.expected.total=-1,(v:any)=>v.filters.from='bad',(v:any)=>v.window.expiresAt++,(v:any)=>v.move.direction='SIDEWAYS']){const v=structuredClone(body);edit(v);assert.throws(()=>next(codec.seal(v)),errorCode('AUDIT_CURSOR_INVALID'));}
 assert.throws(()=>parseAuditPage(new URLSearchParams({cursor:a.nextCursor!}),ctx,codec,now+auditPageLifetime),errorCode('AUDIT_CURSOR_EXPIRED',410));const future=structuredClone(body);future.window.capturedAt=now+31000;future.window.expiresAt=future.window.capturedAt+auditPageLifetime;assert.throws(()=>next(codec.seal(future)),errorCode('AUDIT_CURSOR_INVALID'));
});
test('forward and backward pages visit each matching authorized event once with exact authorized ranges',()=>{
 const all=rows(103),visible=(e:AuditEvent)=>e.metadata.site==='F1',p=plan('pageSize=7&action=QA'),expected=all.filter(r=>visible(r.event)&&r.event.action==='QA').map(r=>r.event.eventId).reverse();let current=response(all,p,visible),forward:string[]=[],pages:any[]=[];
 while(true){pages.push(current);forward.push(...current.items.map(e=>e.eventId));assert.equal(current.total,expected.length);assert.equal(current.range.from,forward.length-current.items.length+1);assert.equal(current.range.to,forward.length);if(!current.nextCursor)break;current=response(all,next(current.nextCursor),visible);}
 assert.deepEqual(forward,expected);assert.equal(new Set(forward).size,expected.length);
 for(let index=pages.length-2;index>=0;index--){assert.ok(current.previousCursor);current=response(all,next(current.previousCursor!),visible);assert.deepEqual(current.items,pages[index].items);assert.deepEqual(current.range,pages[index].range);}assert.equal(current.previousCursor,null);
});
test('empty tenants and filters produce verified empty pages without exposing any head or tenant totals',()=>{
 for(const [all,p]of [[[],plan()], [rows(),plan('q=no-such-event')]] as [AuditPageRow[],AuditPagePlan][]){const a=response(all,p);assert.deepEqual(a.items,[]);assert.deepEqual(a.range,{from:0,to:0});assert.equal(a.total,0);assert.equal(a.nextCursor,null);assert.equal(a.previousCursor,null);assert.equal(a.chainValid,true);assert.equal('head'in a.snapshot,false);assert.equal(JSON.stringify(a).includes('sequence'),false);}
});
test('appends leave a fixed window stable while refresh includes them; old visibility changes invalidate its cursor',()=>{
 const all=rows(31),p=plan(),first=response(all,p),store=seedStore();store.audits=[all.at(-1)!.event];const event=appendAudit(store,{tenantId:'acme',objectType:'DEVICE',objectId:'appended',action:'QA',actorType:'USER',actorId:'actor-1',correlationId:'append',metadata:{}}),extended=[...all,{sequence:'999',tenant_id:'acme',event_id:event.eventId,hash:event.hash,previous_hash:event.previousHash,event}];
 assert.deepEqual(collect(extended,next(first.nextCursor!)).slice,collect(all,next(first.nextCursor!)).slice);
 const refreshed=response(extended,p);assert.equal(refreshed.total,32);assert.equal(refreshed.items[0].eventId,event.eventId);
 assert.throws(()=>response(extended,next(first.nextCursor!),e=>e.eventId!==all[0].event.eventId),errorCode('AUDIT_SCOPE_CHANGED',409));
 const bad=structuredClone(extended);bad.at(-1)!.event.action='TAMPERED_AFTER_WINDOW';assert.throws(()=>response(bad,next(first.nextCursor!)),errorCode('AUDIT_INTEGRITY',503));
});
test('paging validates hidden, older, filtered and appended rows before it returns any partial page',()=>{
 const all=rows(41),p=plan('pageSize=3&objectType=DEVICE');for(const index of [0,1,20,40]){const bad=structuredClone(all);bad[index].event.action='TAMPERED';assert.throws(()=>response(bad,p,e=>e.metadata.site==='F1'),errorCode('AUDIT_INTEGRITY',503));}
 const first=response(all,p),bad=structuredClone(all);bad.at(-1)!.event.action='APPENDED_TAMPER';assert.throws(()=>response(bad,next(first.nextCursor!)),errorCode('AUDIT_INTEGRITY'));
 for(const edit of [(r:AuditPageRow[])=>r[1].sequence=r[0].sequence,(r:AuditPageRow[])=>r[1].event_id='wrong',(r:AuditPageRow[])=>r[1].tenant_id='sandbox',(r:AuditPageRow[])=>r[1].event=null as any,(r:AuditPageRow[])=>r.splice(7,1)]){const r=structuredClone(all);edit(r);assert.throws(()=>response(r,p),errorCode('AUDIT_INTEGRITY'));}
 const missingHead=all.slice(0,-1),collector=new AuditPageCollector(p,auditHead(all.at(-1)),()=>true,{clock:()=>now});for(const row of missingHead)collector.accept(row);assert.throws(()=>collector.finish(),errorCode('AUDIT_INTEGRITY'));
});
test('collector retains at most one page and releases evictions and failed pages exactly once',()=>{
 const all=rows(2000);let held=0,peak=0,released=0;const retain=()=>{held++;peak=Math.max(peak,held);let live=true;return()=>{if(live){live=false;held--;released++;}};};const p=plan('pageSize=9'),{collector,slice}=collect(all,p,()=>true,{retain});assert.equal(collector.retainedPeak,9);assert.equal(held,9);assert.equal(peak,9);assert.equal(released,1991);assert.equal(slice.items.length,9);collector.discard();collector.discard();assert.equal(held,0);
 const bad=structuredClone(all);bad.at(-1)!.event.action='bad';assert.throws(()=>collect(bad,p,()=>true,{retain}),errorCode('AUDIT_INTEGRITY'));assert.equal(held,0);
});
test('audit filter time boundaries, actor and search combine without counting hidden events',()=>{
 const all=rows(15),time=all[0].event.businessTime,p=plan('pageSize=5&q=SEARCH&actorId=actor-1&from='+encodeURIComponent(time)+'&to='+encodeURIComponent(new Date(Date.parse(time)+1000).toISOString())),visible=(e:AuditEvent)=>e.objectType==='DEVICE',a=response(all,p,visible);assert.equal(a.total,7);assert.ok(a.items.every(e=>e.actorId==='actor-1'));assert.equal(a.items.length,5);
});
test('incremental verifier preserves historical canonical hash bytes and rejects a broken chain permanently',()=>{
 const base={tenantId:'acme',objectType:'DEVICE',objectId:'D-1',action:'CREATE',actorType:'USER',actorId:'u',correlationId:'c',metadata:{b:2,a:'中文'},eventId:'e-1',businessTime:'2026-10-16T00:00:00Z',previousHash:'GENESIS'};
 const canonical='{"action":"CREATE","actorId":"u","actorType":"USER","businessTime":"2026-10-16T00:00:00Z","correlationId":"c","eventId":"e-1","metadata":{"a":"中文","b":2},"objectId":"D-1","objectType":"DEVICE","previousHash":"GENESIS","tenantId":"acme"}';const event={...base,hash:createHash('sha256').update('GENESIS'+canonical).digest('hex')} as AuditEvent;
 assert.equal(verifyAuditChain([event],'acme'),true);const verifier=new AuditChainVerifier('acme');assert.equal(verifier.accept({...event,action:'BAD'}),false);assert.equal(verifier.accept(event),false);assert.equal(new AuditChainVerifier('sandbox').accept(event),false);
});
