import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,lstat,link,unlink,copyFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readApplicationRegistryV1} from '../scripts/runtime-application-registry-v1.mjs';

test('live registry snapshots survive real concurrent checkpoint writes and still reject links or tampered chains',async()=>{
 await mkdir('work',{recursive:true});const base=await mkdtemp(resolve('work/application-registry-live-v1-'));
 const child=fork(resolve('scripts/fixtures/application-registry-checkpoint-writer-v1-qa.mjs'),[base],{execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 let trust,complete,ended=false,diagnostic='';child.stderr.on('data',b=>diagnostic+=b);child.stdout.resume();
 const terminal=new Promise((ok,no)=>{child.once('error',no);child.once('close',(code,signal)=>{ended=true;if(code===0&&signal===null)ok();else no(Error('REGISTRY_WRITER_FAILED '+diagnostic.slice(-300)));});});terminal.catch(()=>{});
 const trusted=new Promise((ok,no)=>{child.on('message',m=>{if(m.event==='TRUST'){trust=m.trust;ok();}else if(m.event==='COMPLETE')complete=m;});child.once('error',no);child.once('exit',()=>{if(!trust)no(Error('REGISTRY_WRITER_EXIT_BEFORE_TRUST'));});});
 try{
  await trusted;const initial=await lstat(trust.storeFile,{bigint:true});child.send('START');let reads=0,liveReads=0,lastSequence=0,changed=false;
  while(!ended){
   const value=await readApplicationRegistryV1(trust);assert(value.sequence>=lastSequence);lastSequence=value.sequence;reads++;if(value.sequence>0&&value.sequence<33)liveReads++;
   if((await lstat(trust.storeFile,{bigint:true})).mtimeNs!==initial.mtimeNs)changed=true;
   await new Promise(ok=>setTimeout(ok,1));
  }
  await terminal;assert.equal(complete.checkpoints,33);assert(reads>10&&liveReads>5&&changed);
  const final=await readApplicationRegistryV1(trust);assert.equal(final.sequence,33);assert(final.lifecycle.groupReady&&final.lifecycle.terminal);assert.equal(final.events.at(-1).event,'GROUP_CLOSED');
  const alias=join(base,'hardlink.sqlite');await link(trust.storeFile,alias);
  try{await assert.rejects(readApplicationRegistryV1({...trust,storeFile:alias}),/APPLICATION_REGISTRY_FILE/);await assert.rejects(readApplicationRegistryV1(trust),/APPLICATION_REGISTRY_FILE/);}finally{await unlink(alias);}
  assert.equal((await readApplicationRegistryV1(trust)).sequence,33);
  const tampered=join(base,'tampered.sqlite');await copyFile(trust.storeFile,tampered);const db=new DatabaseSync(tampered);try{db.exec("UPDATE application_events SET body='{}' WHERE sequence=1;");}finally{db.close();}
  await assert.rejects(readApplicationRegistryV1({...trust,storeFile:tampered}),/APPLICATION_REGISTRY_CHAIN/);
 }finally{
  if(!ended){if(child.connected)child.disconnect();await terminal;}
 }
});
