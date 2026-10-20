import test from 'node:test';
import assert from 'node:assert/strict';
import {TenantQueue,tenantWorkspace,workspacePayload,freezeWorkspace} from './tenant-workspace.ts';
import {tenantPayload} from './entity-repository.ts';
import {seedStore} from './store.ts';
import {emptyImports} from './imports.ts';
function payload(){const {audits,idempotency,...business}=seedStore();return tenantPayload({version:2,business,imports:emptyImports(),audits,idempotency:[...idempotency]},'acme');}
test('tenant queue lets B commit while A waits, orders A, and removes drained keys',async()=>{
 const q=new TenantQueue(),events:string[]=[];let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(ok=>release=ok),ready=new Promise<void>(ok=>entered=ok);
 const a=q.run('acme',async()=>{events.push('A1');entered();await gate;events.push('A2');});await ready;
 const next=q.run('acme',async()=>{events.push('A3');});await q.run('sandbox',async()=>{events.push('B');});assert.deepEqual(events,['A1','B']);release();await Promise.all([a,next]);await q.drain();assert.deepEqual(events,['A1','B','A2','A3']);assert.equal(q.size,0);
});
test('failed jobs do not poison a tenant and nested waits fail instead of deadlocking',async()=>{
 const q=new TenantQueue();await assert.rejects(q.run('acme',async()=>{throw Error('rolled back');}),/rolled back/);
 await assert.rejects(q.run('acme',()=>q.run('acme',async()=>true)),/不可嵌套/);
 await assert.rejects(q.run('acme',()=>new TenantQueue().run('acme',async()=>true)),/不可嵌套/);
 assert.equal(await q.run('acme',async()=>42),42);await q.drain();assert.equal(q.size,0);
});
test('command workspaces clone one tenant and cannot mutate their before snapshot',()=>{
 const before=payload(),a=tenantWorkspace(before),b=tenantWorkspace(before);a.store.devices[0].name='changed';a.store.idempotency.set('acme:qa',{response:{value:1}});
 assert.notEqual(before.business.devices[0].name,'changed');assert.notEqual(b.store.devices[0].name,'changed');assert.equal(b.store.idempotency.size,0);assert.equal(workspacePayload(a,'acme').business.devices[0].name,'changed');
});
test('a command cannot run against a disabled or missing tenant loaded after the database lock',()=>{
 const disabled=payload();disabled.business.tenants[0].status='SUSPENDED';assert.throws(()=>tenantWorkspace(disabled),/已停用/);disabled.business.tenants=[];assert.throws(()=>tenantWorkspace(disabled),/已停用/);
});
test('foreign entities, audit, imports and receipt keys are rejected without filtering',()=>{
 for(const poison of [(w:any)=>w.store.devices[0].tenantId='sandbox',(w:any)=>w.store.audits.push({tenantId:'sandbox'}),(w:any)=>w.imports.records.push({tenantId:'sandbox'}),(w:any)=>w.store.idempotency.set('sandbox:secret',{})]){const w=tenantWorkspace(payload());poison(w);assert.throws(()=>workspacePayload(w,'acme'));}
});
test('frozen read workspaces prevent deep changes and Map mutators while allowing iteration and cloning',()=>{
 const w=tenantWorkspace(payload());w.store.idempotency.set('acme:qa',{response:{value:1}});freezeWorkspace(w);
 assert.throws(()=>w.store.devices[0].name='changed');assert.throws(()=>w.store.devices.push(w.store.devices[0]));assert.throws(()=>w.store.idempotency.set('acme:new',{}));assert.throws(()=>w.store.idempotency.delete('acme:qa'));assert.throws(()=>w.store.idempotency.clear());assert.throws(()=>{(w.store.idempotency.get('acme:qa') as any).response.value=2;});
 assert.equal(w.store.idempotency.size,1);assert.equal(structuredClone(w).store.idempotency.size,1);assert.equal([...w.store.idempotency][0][0],'acme:qa');
});
