import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';

test('private runtime stop rejects malformed requests and drains once before natural pipe closure',async()=>{
 const parent=await realpath(tmpdir()),directory=await mkdtemp(join(parent,'idms-stop-')),proof=join(directory,'drain.json'),nonce=randomBytes(32).toString('hex');
 const child=spawn(process.execPath,[resolve('scripts/fixtures/controlled-node-service-qa.ts'),proof,'200'],{windowsHide:true,env:{...process.env,NODE_OPTIONS:'',IDMS_PARENT_CONTROL_NONCE:nonce},stdio:['ignore','pipe','pipe','ipc']});
 const messages:Record<string,unknown>[]=[],closed=new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(exitCode,signal)=>resolve({exitCode,signal}));});
 child.stdout.resume();child.stderr.resume();
 const message=(type:string)=>new Promise<void>((resolve,reject)=>{if(messages.some(m=>m.type===type))return resolve();const onMessage=(m:Record<string,unknown>)=>{if(m.type===type){child.off('message',onMessage);child.off('close',onClose);resolve();}},onClose=()=>reject(Error('CHILD_CLOSED_BEFORE_'+type));child.on('message',onMessage);child.once('close',onClose);});
 child.on('message',m=>messages.push(m as Record<string,unknown>));
 await message('IDMS_QA_READY_V1');
 const envelope={type:'IDMS_SERVICE_STOP_V1',service:'edge',nonce,requestId:randomUUID()};
 // Byte-length mismatch must not throw in timingSafeEqual or stop the service.
 child.send({...envelope,nonce:'汉'.repeat(64)});await message('IDMS_SERVICE_STOP_REJECTED_V1');
 assert.equal(child.exitCode,null);assert(!messages.some(m=>m.type==='IDMS_SERVICE_STOP_ACCEPTED_V1'));
 child.send(envelope);child.send(envelope);
 await message('IDMS_SERVICE_STOP_ACCEPTED_V1');await message('IDMS_SERVICE_STOP_COMPLETED_V1');
 assert.deepEqual(await closed,{exitCode:0,signal:null});
 assert.equal(messages.filter(m=>m.type==='IDMS_SERVICE_STOP_COMPLETED_V1').length,1);
 const saved=JSON.parse(await readFile(proof,'utf8'));assert.equal(saved.stops,1);assert.equal(saved.pendingCompleted,true);
 const rel=relative(parent,await realpath(directory));assert(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('idms-stop-'));await rm(directory,{recursive:true});
});
