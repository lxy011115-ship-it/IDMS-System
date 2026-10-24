import {fieldSiteChildRetirementV1} from '../scripts/runtime-field-site-retirement-v1.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
import {observeOwnedForkTerminalV1} from '../scripts/owned-fork-terminal-v1.mjs';

const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
function bounded(promise,label){return new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error(label)),10000);promise.then(v=>{clearTimeout(timer);ok(v);},e=>{clearTimeout(timer);no(e);});});}
async function launch(){
 const root=resolve('work/field-site-manager-proof-v1',randomUUID()),runtimeFile=join(root,'runtime.private.json'),launchFile=join(root,'launch.private.json'),resultFile=join(root,'site-result.private.json');await privateDirectory(root);
 const bytes=JSON.stringify({format:1,purpose:'FIELD_MAP_SITE_RUNTIME_V1',baseRuntimeFile:'missing-base.private.json',field:{enabled:false}});await privateNewFile(runtimeFile,bytes);
 const e={format:'RUNTIME_FIELD_SITE_CHILD_V1',ownerId:randomUUID(),parentPid:process.pid,component:{id:'site',kind:'SITE',tenantId:null,runtimeFile},runtimeFile,configSha256:createHash('sha256').update(bytes).digest('hex'),manifestSha256:'a'.repeat(64),challenge:randomBytes(32).toString('hex'),binding:{controlId:randomUUID(),sourceHash:'b'.repeat(64),authorityHash:'c'.repeat(64)},expectedTenantIds:['sandbox'],pins:[{path:runtimeFile,sha256:createHash('sha256').update(bytes).digest('hex')}],resultFile};await privateNewFile(launchFile,JSON.stringify(e));
 const child=fork(resolve('scripts/runtime-field-site-child-v1.mjs'),[launchFile],{execArgv:[],windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe','ipc']}),messages=[];child.stdout.resume();child.stderr.resume();const terminal=observeOwnedForkTerminalV1(child);terminal.catch(()=>{});
 let createdOk;const created=new Promise(ok=>createdOk=ok);child.on('message',m=>{assert.equal(m.ownerId,e.ownerId);assert.equal(m.componentId,'site');assert.equal(m.challenge,e.challenge);assert.equal(m.pid,child.pid);messages.push(m);if(m.event==='APPLICATION_COMPONENT_CREATED')createdOk(m);});
 const send=(type,details={})=>child.send({type,ownerId:e.ownerId,componentId:'site',challenge:e.challenge,...details});
 return{child,e,messages,send,proof:async(requestId)=>fieldSiteChildRetirementV1(JSON.parse(await readFile(resultFile,'utf8')),{ownerId:e.ownerId,componentId:'site',pid:child.pid,parentPid:process.pid,configSha256:e.configSha256,manifestSha256:e.manifestSha256,challenge:e.challenge,enabled:false,requestId}),created:bounded(Promise.race([created,terminal.then(()=>{throw Error('CHILD_EXIT_BEFORE_CREATED');})]),'CHILD_CREATED_TIMEOUT'),terminal,result:async()=>JSON.parse(await readFile(resultFile,'utf8')),async cleanup(){if(child.exitCode===null&&child.signalCode===null&&child.connected){const requestId=randomUUID();send('APPLICATION_COMPONENT_STOP',{requestId});}await bounded(terminal,'CHILD_TERMINAL_TIMEOUT');}};
}

test('manager-grade proof: actual SITE fork waits for START, ignores foreign stop, and normally cancels before touching missing base',async()=>{
 const h=await launch();try{await h.created;await sleep(80);assert.equal(h.child.exitCode,null);assert.deepEqual(h.messages.map(m=>m.event),['APPLICATION_COMPONENT_CREATED']);h.send('APPLICATION_COMPONENT_STOP',{challenge:'0'.repeat(64),requestId:randomUUID()});await sleep(60);assert.equal(h.child.exitCode,null);const requestId=randomUUID();h.send('APPLICATION_COMPONENT_STOP',{requestId});h.send('APPLICATION_COMPONENT_STOP',{requestId});assert.deepEqual(await bounded(h.terminal,'CHILD_STOP_TIMEOUT'),{code:0,signal:null});const r=await h.result();assert(r.normalClose&&r.startupCancelled&&!r.started&&!r.ready);assert.equal(r.requestId,requestId);assert.equal(r.runtimeTerminal,null);assert.equal(r.errorCode,null);const proof=await h.proof(requestId);assert(proof.allOwnedResourcesRetired&&proof.startupCancelled&&proof.runtimeOwner===null);assert.equal(h.messages.at(-1).event,'APPLICATION_COMPONENT_CLOSED');assert.equal(h.messages.at(-1).requestId,requestId);}finally{await h.cleanup();}
});

test('manager-grade proof: explicit START reports actual SITE configuration failure and retired resources instead of normal readiness',async()=>{
 const h=await launch();try{await h.created;h.send('APPLICATION_COMPONENT_START');assert.deepEqual(await bounded(h.terminal,'CHILD_FAILURE_TIMEOUT'),{code:1,signal:null});const r=await h.result();assert(r.started&&!r.ready&&!r.normalClose&&!r.startupCancelled);assert.equal(r.reason,'FAILED');assert(r.errorCode);assert(r.runtimeTerminal.allOwnedResourcesRetired&&r.runtimeTerminal.state.closed);assert.equal(r.runtimeTerminal.state.field,null);const proof=await h.proof(null);assert(proof.allOwnedResourcesRetired&&!proof.normalClose&&!proof.startupCancelled&&proof.runtimeOwner);assert(!h.messages.some(m=>m.event==='APPLICATION_COMPONENT_READY'||m.event==='APPLICATION_COMPONENT_CLOSED'));}finally{await h.cleanup();}
});

test('manager-grade proof: closing one actual SITE fork leaves an unrelated owner waiting and does not accept its stop identity',async()=>{
 const [a,b]=await Promise.all([launch(),launch()]);try{
  await Promise.all([a.created,b.created]);const first=randomUUID(),second=randomUUID();b.send('APPLICATION_COMPONENT_STOP',{ownerId:a.e.ownerId,requestId:first});a.send('APPLICATION_COMPONENT_STOP',{requestId:first});
  assert.deepEqual(await bounded(a.terminal,'FIRST_CHILD_STOP_TIMEOUT'),{code:0,signal:null});assert.equal((await a.result()).requestId,first);await sleep(70);assert.equal(b.child.exitCode,null);assert.deepEqual(b.messages.map(m=>m.event),['APPLICATION_COMPONENT_CREATED']);
  b.send('APPLICATION_COMPONENT_STOP',{requestId:second});assert.deepEqual(await bounded(b.terminal,'SECOND_CHILD_STOP_TIMEOUT'),{code:0,signal:null});const r=await b.result();assert(r.normalClose&&r.startupCancelled);assert.equal(r.requestId,second);assert.notEqual(r.requestId,first);assert.notEqual(r.ownerId,a.e.ownerId);const pa=await a.proof(first),pb=await b.proof(second);assert(pa.allOwnedResourcesRetired&&pb.allOwnedResourcesRetired);assert.throws(()=>fieldSiteChildRetirementV1(r,{...b.e,componentId:'site',pid:a.child.pid,parentPid:process.pid,enabled:false,requestId:second}),/FIELD_SITE_RESULT_BINDING/);
 }finally{await Promise.all([a.cleanup(),b.cleanup()]);}
});
