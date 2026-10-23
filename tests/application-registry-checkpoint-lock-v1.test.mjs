import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {observeOwnedForkTerminalV1} from '../scripts/owned-fork-terminal-v1.mjs';
import {readApplicationRegistryV1} from '../scripts/runtime-application-registry-v1.mjs';

test('a real held read snapshot blocks TRUNCATE, then bounded checkpoint wait completes after that exact reader releases',async()=>{
 await mkdir('work',{recursive:true});const base=await mkdtemp(resolve('work/application-registry-checkpoint-lock-v1-')),child=fork(resolve('scripts/fixtures/application-registry-checkpoint-lock-v1-qa.mjs'),[base],{execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']}),terminal=observeOwnedForkTerminalV1(child);terminal.catch(()=>{});child.stdout.resume();child.stderr.resume();let trust,busy,complete,readDb;
 let gotTrust,gotBusy,rejectTrust,rejectBusy;const trusted=new Promise((ok,no)=>{gotTrust=ok;rejectTrust=no;}),blocked=new Promise((ok,no)=>{gotBusy=ok;rejectBusy=no;});blocked.catch(()=>{});
 child.on('message',value=>{if(value.event==='TRUST'){trust=value.trust;gotTrust();}else if(value.event==='BUSY_OBSERVED'){busy=value;gotBusy();}else if(value.event==='COMPLETE')complete=value;});terminal.then(()=>{if(!trust)rejectTrust(Error('CHECKPOINT_WRITER_EXIT_BEFORE_TRUST'));if(!busy)rejectBusy(Error('CHECKPOINT_WRITER_EXIT_BEFORE_BUSY'));},error=>{rejectTrust(error);rejectBusy(error);});
 try{
  await trusted;readDb=new DatabaseSync(trust.storeFile,{readOnly:true,allowExtension:false,timeout:3000});readDb.exec('BEGIN;');assert.equal(readDb.prepare('SELECT sequence FROM application_meta WHERE id=1').get().sequence,0);child.send('READ_LOCKED');await blocked;
  assert.equal(busy.blocked.busy,1);assert(busy.blocked.log>0);assert.equal(busy.configuredTimeout,3000);await new Promise(ok=>setTimeout(ok,100));assert.equal(complete,undefined);assert.equal(child.exitCode,null);assert.equal(readDb.prepare('SELECT sequence FROM application_meta WHERE id=1').get().sequence,0);
  readDb.exec('COMMIT;');readDb.close();readDb=null;assert.deepEqual(await terminal,{code:0,signal:null});assert(complete);assert.deepEqual(complete.completed,{busy:0,log:0,checkpointed:0});assert.equal(complete.sequence,1);assert.equal(complete.configuredTimeout,3000);assert(complete.elapsedMs>=50&&complete.elapsedMs<3000);assert.equal((await readApplicationRegistryV1(trust)).sequence,1);
 }finally{if(readDb){try{readDb.exec('ROLLBACK;');}finally{readDb.close();}}if(child.exitCode===null&&child.signalCode===null&&child.connected)child.disconnect();await terminal;}
});
