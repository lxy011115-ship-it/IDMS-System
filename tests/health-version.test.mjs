import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {demoEnvironment} from '../scripts/demo-runtime.mjs';

test('HTTP health uses the package version when started outside the source directory',{timeout:25000},async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url)),parent=resolve(root,'work/health-version-tests');
 const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 await mkdir(parent,{recursive:true});const isolated=await mkdtemp(join(parent,'owned-'));
 const reservation=createServer();await new Promise((ok,fail)=>{reservation.once('error',fail);reservation.listen(0,'127.0.0.1',ok);});
 const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));
 const child=spawn(process.execPath,[join(root,'server/index.ts')],{cwd:isolated,env:demoEnvironment({...process.env,NODE_ENV:'development'},{port,namespace:'version-check'}),stdio:['ignore','ignore','pipe'],windowsHide:true});
 let diagnostic='';child.stderr.on('data',chunk=>{if(diagnostic.length<4096)diagnostic+=chunk.toString('utf8').slice(0,4096-diagnostic.length);});
 let exited=false,spawnError;const stopped=new Promise(ok=>{child.once('exit',()=>{exited=true;ok();});child.once('error',error=>{spawnError=error;exited=true;ok();});});
 try{
  const deadline=Date.now()+15000;let health;
  while(Date.now()<deadline){
   if(exited)throw Error('Isolated HTTP process exited before readiness'+(spawnError?': '+spawnError.code:'')+'\n'+diagnostic);
   try{const response=await fetch(`http://127.0.0.1:${port}/api/v1/health`,{signal:AbortSignal.timeout(700)});if(response.ok){health=await response.json();break;}}catch{}
   await delay(50);
  }
  assert.ok(health,'Isolated HTTP health did not become ready');
  assert.equal(health.status,'UP');assert.equal(health.version,metadata.version);assert.notEqual(health.storage,'postgres-tenant-databases');assert.equal(health.authentication,'demo');
  const ready=await fetch(`http://127.0.0.1:${port}/api/v1/ready`);assert.equal(ready.status,503);const readiness=await ready.json();assert.equal(readiness.status,'NOT_READY');assert.equal(readiness.productionApproved,false);
  const details=await fetch(`http://127.0.0.1:${port}/api/v1/runtime/status`);assert.equal(details.status,503);assert.equal((await details.json()).code,'MAINTENANCE_NOT_CONFIGURED');
 }finally{
  if(!exited)child.kill();
  await Promise.race([stopped,delay(5000,undefined,{ref:false}).then(()=>{throw Error('Owned HTTP process termination unconfirmed; fixture retained');})]);
  const inside=relative(parent,isolated);if(!inside.startsWith('owned-')||inside.includes('/')||inside.includes('\\')||isAbsolute(inside))throw Error('Unsafe health fixture cleanup');
  await rm(isolated,{recursive:true,force:true});
 }
});
