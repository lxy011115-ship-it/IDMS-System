import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,link,rm,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {applicationManifestV1,collectApplicationJsonGraphV1,assertApplicationPinsV1,applicationOutsideV1,applicationHashV1 as hash} from './runtime-application-config-v1.mjs';
import {createApplicationRegistryV1,appendApplicationRegistryV1,readApplicationRegistryV1,applicationRegistryLifecycleV1} from './runtime-application-registry-v1.mjs';

const binding={controlId:'00000000-0000-4000-8000-000000000001',sourceHash:'a'.repeat(64),authorityHash:'b'.repeat(64)};
function manifest(tenantIds=['sandbox']){return{format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:'registry',trustFile:'trust.json',authorityRuntimeFile:'authority.json',binding:{...binding},tenantIds,components:[{id:'site',kind:'SITE',tenantId:null,runtimeFile:'site.json'},...tenantIds.flatMap(t=>['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION'].map(k=>({id:t+'-'+k.toLowerCase(),kind:k,tenantId:t,runtimeFile:t+'-'+k.toLowerCase()+'.json'})))]};}
async function fixture(run){const directory=await mkdtemp(join(tmpdir(),'idms-application-v1-'));try{return await run(directory);}finally{const absolute=await realpath(directory),base=await realpath(tmpdir());assert(absolute.startsWith(base+sep)&&absolute.slice(base.length+1).startsWith('idms-application-v1-')&&!(await lstat(directory)).isSymbolicLink());await rm(absolute,{recursive:true});}}
function sequence(m){const values=[],pids=new Map();const push=(event,details={})=>values.push({event,...details});let nextPid=1000;
 for(const c of [...m.components].sort((a,b)=>(a.kind==='SITE'?1:0)-(b.kind==='SITE'?1:0))){const pid=nextPid++;pids.set(c.id,pid);push('LAUNCH_INTENT',{componentId:c.id,kind:c.kind,configSha256:'c'.repeat(64)});push('READY',{componentId:c.id,pid,kind:c.kind,configSha256:'c'.repeat(64),tenantIds:c.kind==='SITE'?[...m.tenantIds].sort():[c.tenantId],binding});}
 push('GROUP_READY');push('GROUP_STOPPING',{requestId:randomUUID()});
 for(const c of m.components){const pid=pids.get(c.id),requestId=randomUUID();push('STOP_INTENT',{componentId:c.id,pid,requestId});push('DRAINING',{componentId:c.id,pid,requestId});push('CLOSED',{componentId:c.id,pid,requestId});push('EXIT',{componentId:c.id,pid,code:0,signal:null});}
 push('GROUP_CLOSED');return values;
}

test('a complete tenant inventory requires exactly one site and four background kinds per tenant',()=>{
 for(const tenants of [['sandbox'],['acme','sandbox']]){const m=manifest(tenants);assert.deepEqual(applicationManifestV1(m),m);}
});
test('missing members, duplicate kinds or ids and foreign tenants fail before launching',()=>{
 for(const change of [m=>m.components.pop(),m=>m.components[1].kind='SITE',m=>m.components[1].id='site',m=>m.components[1].tenantId='foreign',m=>m.tenantIds.push('sandbox')]){const m=manifest();change(m);assert.throws(()=>applicationManifestV1(m));}
});
test('PID adoption, arbitrary programs, extra secrets and malformed binding claims are not manifest fields',()=>{
 for(const patch of [{pid:123},{executable:'node'},{password:'public-unit-only'},{binding:{...binding,authorityHash:'not-a-digest'}}])assert.throws(()=>applicationManifestV1({...manifest(),...patch}));
 for(const patch of [{pid:123},{script:'arbitrary.mjs'},{runtimeFile:'bad\nfile.json'}]){const m=manifest();Object.assign(m.components[1],patch);assert.throws(()=>applicationManifestV1(m));}
});
test('configuration graph binds shared and cyclic JSON references without copying values into pins',()=>fixture(async dir=>{
 await writeFile(join(dir,'root.json'),JSON.stringify({baseRuntimeFile:'shared.json',members:[{keyFile:'shared.json'}],privateKeyFile:'key.json'}));await writeFile(join(dir,'shared.json'),JSON.stringify({rootFile:'root.json',password:'public-unit-password-only'}));await writeFile(join(dir,'key.json'),JSON.stringify({key:'public-unit-key-only'}));
 const pins=await collectApplicationJsonGraphV1([join(dir,'root.json')]);assert.equal(pins.length,3);assert(pins.every(p=>Object.keys(p).sort().join(',')==='path,sha256'));assert(!JSON.stringify(pins).includes('public-unit-password'));await assertApplicationPinsV1(pins);
 await writeFile(join(dir,'shared.json'),'{}');await assert.rejects(assertApplicationPinsV1(pins),/APPLICATION_CONFIG_CHANGED/);
}));
test('hard-linked JSON configurations are rejected instead of classified as separate files',()=>fixture(async dir=>{
 await writeFile(join(dir,'one.json'),'{}');await link(join(dir,'one.json'),join(dir,'two.json'));await assert.rejects(collectApplicationJsonGraphV1([join(dir,'one.json')]),/APPLICATION_PRIVATE_FILE/);
}));
test('oversized private files and excessive graphs fail closed',()=>fixture(async dir=>{
 await writeFile(join(dir,'large.json'),' '.repeat(2*1024**2+1));await assert.rejects(collectApplicationJsonGraphV1([join(dir,'large.json')]),/APPLICATION_PRIVATE_FILE/);
 const files=[];for(let i=0;i<257;i++){const p=join(dir,i+'.json');await writeFile(p,'{}');files.push(p);}await assert.rejects(collectApplicationJsonGraphV1(files),/APPLICATION_CONFIG_FILE_LIMIT/);
}));
test('registry and private configuration paths must be outside both SQL data directories',()=>{
 const parent=join(tmpdir(),'application-pgdata');assert(!applicationOutsideV1(parent,parent));assert(!applicationOutsideV1(join(parent,'control'),parent));assert(applicationOutsideV1(join(tmpdir(),'application-control'),parent));
});
test('normal lifecycle requires correlated drain, close and actual zero-code exit for every member',()=>{
 const m=manifest(['acme','sandbox']),events=sequence(m);assert.deepEqual(applicationRegistryLifecycleV1({manifest:m},events),{groupReady:true,stopping:true,terminal:true});
 for(const name of ['DRAINING','CLOSED','EXIT'])assert.throws(()=>applicationRegistryLifecycleV1({manifest:m},events.filter(v=>!(v.componentId==='site'&&v.event===name))));
});
test('premature readiness, foreign stop replies and killed children cannot produce a green group close',()=>{
 const m=manifest();assert.throws(()=>applicationRegistryLifecycleV1({manifest:m},[{event:'GROUP_READY'}]));
 for(const change of [events=>events.find(v=>v.event==='CLOSED').requestId=randomUUID(),events=>events.find(v=>v.event==='EXIT').signal='SIGKILL',events=>events.find(v=>v.event==='READY').binding={...binding,authorityHash:'d'.repeat(64)}]){const events=sequence(m);change(events);assert.throws(()=>applicationRegistryLifecycleV1({manifest:m},events));}
});
test('ingress cannot start before the workers or remain live when worker stop begins',()=>{
 const m=manifest();assert.throws(()=>applicationRegistryLifecycleV1({manifest:m},[{event:'LAUNCH_INTENT',componentId:'site',kind:'SITE',configSha256:'c'.repeat(64)}]),/INGRESS_EARLY/);
 const rows=sequence(m),at=rows.findIndex(v=>v.event==='GROUP_STOPPING'),worker=rows.find(v=>v.event==='STOP_INTENT'&&v.componentId!=='site');assert.throws(()=>applicationRegistryLifecycleV1({manifest:m},[...rows.slice(0,at+1),worker]),/INGRESS_STILL_LIVE/);
});
test('SQLite journal is durable, readable from a separate connection, and refuses directory reuse',()=>fixture(async dir=>{
 const m=manifest(),pins=[{path:join(dir,'manifest.json'),sha256:'e'.repeat(64)}],trust=await createApplicationRegistryV1(join(dir,'registry'),m,pins);
 for(const{event,...details}of sequence(m))await appendApplicationRegistryV1(trust,event,details);
 const result=await readApplicationRegistryV1(trust);assert(result.lifecycle.terminal);assert.equal(result.events.at(-1).event,'GROUP_CLOSED');assert.equal(result.sequence,sequence(m).length);
 await assert.rejects(createApplicationRegistryV1(join(dir,'registry'),m,pins),e=>e.code==='EEXIST');await assert.rejects(appendApplicationRegistryV1(trust,'GROUP_READY'),/AFTER_TERMINAL/);
}));
test('journal refuses secret-shaped extra details before writing an event',()=>fixture(async dir=>{
 const trust=await createApplicationRegistryV1(join(dir,'registry'),manifest(),[{path:'public-test.json',sha256:'e'.repeat(64)}]);
 await assert.rejects(appendApplicationRegistryV1(trust,'LAUNCH_INTENT',{componentId:'site',kind:'SITE',configSha256:'c'.repeat(64),password:'public-unit-only'}),/APPLICATION_REGISTRY_DETAILS/);assert.equal((await readApplicationRegistryV1(trust)).sequence,0);
}));
test('hash corruption is rejected; a recomputed hash still cannot invent a normal lifecycle',()=>fixture(async dir=>{
 const trust=await createApplicationRegistryV1(join(dir,'registry'),manifest(),[{path:'public-test.json',sha256:'e'.repeat(64)}]);await appendApplicationRegistryV1(trust,'GROUP_STOPPING',{requestId:randomUUID()});
 let db=new DatabaseSync(trust.storeFile);db.prepare('UPDATE application_events SET body=? WHERE sequence=1').run('{}');db.close();await assert.rejects(readApplicationRegistryV1(trust),/APPLICATION_REGISTRY_CHAIN/);
}));
test('even a coherently rehashed journal cannot claim an unobserved successful group close',()=>fixture(async dir=>{
 const trust=await createApplicationRegistryV1(join(dir,'registry'),manifest(),[{path:'public-test.json',sha256:'e'.repeat(64)}]);await appendApplicationRegistryV1(trust,'GROUP_STOPPING',{requestId:randomUUID()});const before=await readApplicationRegistryV1(trust),value={...before.events[0],event:'GROUP_CLOSED'};delete value.requestId;
 // Use the same actual canonical serializer as the stored protocol.
 const {canonical}=await import('../server/imports.ts');const encoded=canonical(value),digest=hash(trust.headerHash+'\n'+encoded),db=new DatabaseSync(trust.storeFile);db.prepare('UPDATE application_events SET body=?,body_hash=? WHERE sequence=1').run(encoded,digest);db.prepare('UPDATE application_meta SET tip=? WHERE id=1').run(digest);db.close();await assert.rejects(readApplicationRegistryV1(trust),/APPLICATION_REGISTRY_GROUP_CLOSE/);
}));
