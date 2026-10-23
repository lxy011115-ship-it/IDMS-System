import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {observeOwnedForkTerminalV1} from './owned-fork-terminal-v1.mjs';
const fixture=fileURLToPath(new URL('./fixtures/owned-fork-terminal-v1-fixture.mjs',import.meta.url));
const spawn=(mode,options={})=>fork(fixture,[mode],{execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],...options});
test('parent IPC disconnect completes only after real exit and both output pipes close',async()=>{
 const p=spawn('disconnect'),facts={exit:false,stdout:false,stderr:false,disconnect:false};let output='';
 p.once('exit',()=>facts.exit=true);p.stdout.once('close',()=>facts.stdout=true);p.stderr.once('close',()=>facts.stderr=true);p.once('disconnect',()=>facts.disconnect=true);
 const terminal=observeOwnedForkTerminalV1(p);p.stderr.resume();
 await new Promise(ok=>p.stdout.on('data',b=>{output+=b;if(output.includes('OWNED_FORK_FIXTURE_READY'))ok();}));
 p.disconnect();assert.deepEqual(await terminal,{code:0,signal:null});assert.deepEqual(facts,{exit:true,stdout:true,stderr:true,disconnect:true});assert(output.includes('OWNED_FORK_FIXTURE_CLOSED'));
});
test('an actual nonzero exit remains nonzero after complete terminal observation',async()=>{
 const p=spawn('nonzero'),terminal=observeOwnedForkTerminalV1(p);p.stdout.resume();p.stderr.resume();assert.deepEqual(await terminal,{code:7,signal:null});assert.throws(()=>observeOwnedForkTerminalV1(p),/ATTACHED_LATE/);
});
test('a fork launch failure rejects instead of inventing a terminal success',async()=>{
 const p=spawn('nonzero',{execPath:fixture+'.missing-executable'}),terminal=observeOwnedForkTerminalV1(p);p.stdout.resume();p.stderr.resume();await assert.rejects(terminal,error=>error.code==='ENOENT');
});
test('a PID-shaped object cannot replace an owned ChildProcess',()=>{
 assert.throws(()=>observeOwnedForkTerminalV1({pid:process.pid,exitCode:null,signalCode:null}),/HANDLE_REQUIRED/);
});
