import test from 'node:test';
import assert from 'node:assert/strict';
import {publicRegistry,registrySnapshot,registryObservation,RegistryChain,registryRowHash,type RegistryRow} from './registry-history.ts';
import {canonical,digest} from './imports.ts';
const at='2026-10-16T00:00:00.000Z',later='2026-10-16T00:01:00.000Z',source=(edge='edge-a',tenantId='acme')=>({tenantId,edgeId:edge,deviceCode:'DEVICE-A',mapVersion:'map-1',origin:'SIMULATOR' as const,signingKey:'PRIVATE-KEY',acknowledgementKey:'PRIVATE-ACK',statusKey:'PRIVATE-STATUS',statusUrl:'http://PRIVATE/status',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=private-point',unit:'mm/s'},{tagCode:'bearing_temperature',nodeId:'ns=1;s=temp',unit:'degC'}]});
const fixture=()=>{const snap=publicRegistry([source()],'acme'),a=registryObservation(snap,null,at,'core-a')!,b=registryObservation(publicRegistry([{...source(),mapVersion:'map-2'}],'acme'),a,later,'core-b')!;return {snap,a,b,head:{tenant_id:'acme',count:'2',revision:'2',hash:b.hash}};};
test('registry snapshots are deterministic public whitelists with no credentials or URLs',()=>{
 const a=publicRegistry([source('z'),source('a'),source('other','sandbox')],'acme'),b=publicRegistry([{...source('a'),points:[...source().points].reverse()},source('z')],'acme');assert.equal(canonical(a),canonical(b));assert.ok(!canonical(a).includes('PRIVATE-'));assert.ok(!canonical(a).includes('statusUrl'));assert.equal(a.sources[0].edgeId,'a');assert.deepEqual(registrySnapshot(a),a);
 for(const mutate of [(x:any)=>x.sources[0].signingKey='x',(x:any)=>x.sources[0].tenantId='sandbox',(x:any)=>x.sources[0].points[0].private='bad',(x:any)=>x.sources.reverse(),(x:any)=>x.sources[0].points.push(x.sources[0].points[0]),(x:any)=>x.sources[0].deviceCode='../secret']){const x=structuredClone(a);mutate(x);assert.throws(()=>registrySnapshot(x));}
 assert.throws(()=>publicRegistry([source(),source()],'acme'));assert.throws(()=>publicRegistry(Array(101).fill(source()),'acme'));
});
test('observations record actual changes including empty registry and suppress identical restarts',()=>{
 const {snap,a,b}=fixture();assert.equal(registryObservation(snap,a,later,'core-b'),null);assert.equal(a.revision,'1');assert.equal(b.revision,'2');assert.equal(b.previous_hash,a.hash);const empty=registryObservation(publicRegistry([],'acme'),b,later,'core-c')!;assert.equal(empty.revision,'3');assert.deepEqual(empty.body.sources,[]);assert.equal(registryObservation(empty.body,empty,later,'core-d'),null);
 assert.throws(()=>registryObservation(snap,a,'2026-10-15T23:59:59.999Z','core-b'));assert.throws(()=>registryObservation(snap,a,later,'bad id'));assert.throws(()=>registryObservation(publicRegistry([],'sandbox'),a,later,'core-b'));
});
test('full chain selection uses logical observed cutoff with deterministic same-millisecond order',()=>{
 const {a,b,head}=fixture();for(const [knownAt,selected]of [[Date.parse(at)-1,null],[Date.parse(at),a],[Date.parse(later)-1,a],[Date.parse(later),b]] as const){const chain=new RegistryChain('acme',knownAt);chain.accept(a);chain.accept(b);const r=chain.finish(head);assert.deepEqual(r.selected,selected);assert.equal(r.firstObservedAt,at);assert.equal(r.verifiedRevisions,'2');assert.equal(r.knowledgeBasis,'SERVER_OBSERVED_CONFIGURATION');}
 const tie=registryObservation(b.body,a,at,'core-c')!,chain=new RegistryChain('acme',Date.parse(at));chain.accept(a);chain.accept(tie);assert.equal(chain.finish({...head,hash:tie.hash}).selected?.revision,'2');
});
test('missing duplicated foreign mutated or reordered configuration rows fail closed and release retained state',()=>{
 const {a,b,head}=fixture();const attempts=[{...b,revision:'3'},{...b,tenant_id:'sandbox'},{...b,configuration_hash:'0'.repeat(64)},{...b,previous_hash:'GENESIS'},{...b,hash:'0'.repeat(64)},{...b,observed_at:'2026-10-15T00:00:00.000Z'},{...b,body:{...b.body,signingKey:'PRIVATE'}}] as RegistryRow[];
 for(const row of attempts){const c=new RegistryChain('acme',Date.parse(later));c.accept(a);assert.throws(()=>c.accept(row),/不可验证/);assert.equal(c.last,null);assert.equal(c.selected,null);}
 const c=new RegistryChain('acme',Date.parse(later));c.accept(a);assert.throws(()=>c.accept(a));const dropped=new RegistryChain('acme',Date.parse(later));dropped.accept(a);assert.throws(()=>dropped.finish(head));
 for(const mutate of [(h:any)=>h.count='1',(h:any)=>h.revision='3',(h:any)=>h.tenant_id='sandbox',(h:any)=>h.hash=a.hash]){const c=new RegistryChain('acme',Date.parse(later)),h={...head};c.accept(a);c.accept(b);mutate(h);assert.throws(()=>c.finish(h));}
});
test('public hashes cannot substitute for strict source schema, stable time or transition evidence',()=>{
 const {a,b,head}=fixture();for(const body of [{...b.body,sources:[{...b.body.sources[0],points:[]}]},{...b.body,sources:[{...b.body.sources[0],statusKey:'PRIVATE'}]}]){const row={...b,body};row.configuration_hash=digest(canonical(body));row.hash=registryRowHash(row);const c=new RegistryChain('acme',Date.parse(later));c.accept(a);assert.throws(()=>c.accept(row));}
 const same={...b,body:a.body,configuration_hash:a.configuration_hash};same.hash=registryRowHash(same);const c=new RegistryChain('acme',Date.parse(later));c.accept(a);assert.throws(()=>c.accept(same));const empty=new RegistryChain('acme',Date.parse(later));assert.equal(empty.finish({tenant_id:'acme',count:'0',revision:'0',hash:'GENESIS'}).selected,null);assert.throws(()=>empty.accept(a));assert.throws(()=>new RegistryChain('acme',NaN));
});
