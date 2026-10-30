import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {lstat} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {canonical} from '../server/imports.ts';
const workerRecordHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const records=new WeakMap(),active=new Set(),entry=fileURLToPath(new URL('./field-map-full-evidence-worker-entry-v1.mjs',import.meta.url)),exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});},identity=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs),nlink:String(s.nlink)});
async function filePin(file,max){const before=await lstat(file,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n,'FIELD_EVIDENCE_WORKER_FILE');const hash=await coldFileHashV1(file,max),after=await lstat(file,{bigint:true});need(canonical(identity(before))===canonical(identity(after)),'FIELD_EVIDENCE_WORKER_FILE_CHANGED');return{file,identity:identity(after),...hash};}
/** Fixed offline data consumer only. No SQL connection, token, runtime approval or arbitrary entry/callback. */
export async function launchFieldMapFullEvidenceWorkerV2(raw){
 need(exact(raw,['file','expectedFacts','workDirectory'])&&[raw.file,raw.workDirectory].every(p=>typeof p==='string'&&isAbsolute(p)&&resolve(p)===p)&&raw.expectedFacts?.format==='FIELD_MAP_FULL_FACTS_V1'&&active.size<32,'FIELD_EVIDENCE_WORKER_INPUT');
 const facts=structuredClone(raw.expectedFacts),evidencePin=await filePin(raw.file,2*1024**3),entryPin=await filePin(entry,2*1024**2),nodePin=await filePin(process.execPath,256*1024**2);await privateDirectory(raw.workDirectory);
 const nonce=randomBytes(32).toString('hex'),prefix=join(raw.workDirectory,'original-evidence-worker-'+nonce),inputFile=prefix+'.input.private.json',inputBody={format:'FIELD_MAP_ORIGINAL_EVIDENCE_WORKER_INPUT_V1',nonce,file:raw.file,expectedFacts:facts,workDirectory:raw.workDirectory};await privateNewFile(inputFile,JSON.stringify(inputBody));const inputPin=await filePin(inputFile,2*1024**2),input=await readApplicationFileV1(inputFile);need(input.sha256===inputPin.sha256,'FIELD_EVIDENCE_WORKER_INPUT_CHANGED');
 const child=spawn(process.execPath,[entry,inputFile],{cwd:raw.workDirectory,windowsHide:true,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe']}),r={child,nonce,prefix,inputPin,evidencePin,entryPin,nodePin,facts,stdout:'',stderr:'',truncated:false,spawnFailed:false,promise:null,settled:false,startedAt:new Date().toISOString()};
 active.add(r);child.once('error',()=>{r.spawnFailed=true;});for(const[name,stream]of [['stdout',child.stdout],['stderr',child.stderr]])stream.on('data',b=>{if(Buffer.byteLength(r[name])+b.length>65536){r.truncated=true;return;}r[name]+=b.toString('utf8');});
 r.terminal=new Promise(ok=>child.once('close',(code,signal)=>{r.settled=true;active.delete(r);ok({code,signal,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed,spawnFailed:r.spawnFailed,truncated:r.truncated,originalChildHandleHeld:true,pid:child.pid??null,startedAt:r.startedAt,observedAt:new Date().toISOString()});}));
 const handle=Object.freeze({});records.set(handle,r);return handle;
}
export function awaitFieldMapFullEvidenceWorkerV2(handle){
 const r=records.get(handle);need(r,'FIELD_EVIDENCE_WORKER_HANDLE_NOT_MINTED');if(r.promise)return r.promise;
 r.promise=(async()=>{const terminal=await r.terminal;await privateNewFile(r.prefix+'.terminal.private.json',JSON.stringify({terminal,stdout:r.stdout,stderr:r.stderr},null,2));
 need(terminal.code===0&&terminal.signal===null&&terminal.stdoutClosed&&terminal.stderrClosed&&!terminal.spawnFailed&&!terminal.truncated,'FIELD_EVIDENCE_WORKER_REJECTED');
 for(const p of [r.inputPin,r.evidencePin,r.entryPin,r.nodePin])need(canonical(await filePin(p.file,p===r.nodePin?256*1024**2:p===r.evidencePin?2*1024**3:2*1024**2))===canonical(p),'FIELD_EVIDENCE_WORKER_BINDING_CHANGED');
 const lines=r.stdout.trim().split(/\r?\n/);need(lines.length===1,'FIELD_EVIDENCE_WORKER_RESULT');let value;try{value=JSON.parse(lines[0]);}catch{need(false,'FIELD_EVIDENCE_WORKER_RESULT');}
 need(exact(value,['format','nonce','inputSha256','result'])&&value.format==='FIELD_MAP_ORIGINAL_EVIDENCE_WORKER_RESULT_V1'&&value.nonce===r.nonce&&value.inputSha256===r.inputPin.sha256&&value.result?.format==='FIELD_MAP_FULL_EVIDENCE_VERIFIED_V1'&&value.result.factsSha256===r.facts.factsSha256&&value.result.tenantId===r.facts.tenantId&&canonical(value.result.head)===canonical(r.facts.head)&&value.result.entireCurrentRootIndependentlyRebuilt&&value.result.fullDomainPayloadIndependentlyReconstructed&&value.result.currentOidcApprovalVerified===false&&value.result.formalFieldActivationGranted===false,'FIELD_EVIDENCE_WORKER_RESULT_BINDING');
 const terminalPin=await filePin(r.prefix+'.terminal.private.json',2*1024**2),recordBody={format:'FIELD_MAP_ORIGINAL_EVIDENCE_WORKER_RECORD_V2',nonce:r.nonce,input:r.inputPin,evidence:r.evidencePin,entry:r.entryPin,node:r.nodePin,terminal:terminalPin,resultSha256:workerRecordHash(value.result)},originalEvidenceRecord={...structuredClone(recordBody),sha256:workerRecordHash(recordBody)};
 return{result:structuredClone(value.result),terminal:{...terminal,entryAndNodeAndPrivateInputAndActualEvidenceBytesAndIdentitiesUnchanged:true,sourceOrUserOrRuntimeAuthorityGranted:false,originalEvidenceRecord}};
 })();return r.promise;
}
