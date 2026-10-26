import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {backupDirectory} from './field-backup-io.mjs';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {verifyWorkflowLifecycleToolsV1,lifecycleJavaEnvV1,lifecycleOptionsV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {canonical} from '../server/imports.ts';
const owned=new WeakMap(),exec=promisify(execFile),need=(v,c)=>{if(!v)throw Error(c);};
export const workflowReaderPeerJavaSourcesV2=['scripts/lifecycle-java/LifecycleWireV1.java','scripts/lifecycle-java-peer-file-v4/OwnedReaderPeerAttachV1.java','scripts/lifecycle-java-peer-file-v4/OwnedReaderPeerAgentV1.java','scripts/lifecycle-java-peer-bracket-v1/OwnedReaderPeerBracketV1.java'];
export async function buildWorkflowReaderPeerToolsV2(parent,tools){
 const base=await verifyWorkflowLifecycleToolsV1(tools);parent=await backupDirectory(parent);
 const work=join(parent,'reader-peer-tools-'+randomUUID());await mkdir(work,{mode:0o700});await privateDirectory(work);
 const source=join(work,'source'),classes=join(work,'classes');await mkdir(source);await mkdir(classes);const inputs=[];
 for(const path of workflowReaderPeerJavaSourcesV2){const bytes=await readFile(path),file=join(source,path.split('/').at(-1));await privateNewFile(file,bytes);inputs.push({path,file,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const suffix=process.platform==='win32'?'.exe':'',env=lifecycleJavaEnvV1();
 const compiled=await exec(join(base.javaBin,'javac'+suffix),['--release','21','--add-modules','jdk.attach','-d',classes,...inputs.map(v=>v.file)],{env,windowsHide:true,maxBuffer:1024**2,timeout:120000});
 await privateNewFile(join(work,'compile.log'),compiled.stdout+compiled.stderr);
 const manifest=join(work,'manifest.mf');await privateNewFile(manifest,'Manifest-Version: 1.0\nAgent-Class: com.idms.lifecycle.OwnedReaderPeerAgentV1\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n');
 const agentJar=join(work,'owned-reader-peer-v1.jar');await exec(join(base.javaBin,'jar'+suffix),['--create','--file',agentJar,'--manifest',manifest,'-C',classes,'.'],{env,windowsHide:true,maxBuffer:65536,timeout:120000});
 const classPins=[];for(const n of(await readdir(join(classes,'com/idms/lifecycle'))).sort()){need(/^[A-Za-z0-9$]+\.class$/.test(n),'READER_PEER_CLASS');const path=join(classes,'com/idms/lifecycle',n);classPins.push({path,...await coldFileHashV1(path)});}
 need(classPins.length===5,'READER_PEER_CLASSES');const agent=await coldFileHashV1(agentJar),record={tools,work,classes,agentJar,agent,inputs,classPins};
 for(const p of inputs)need((await coldFileHashV1(p.path)).sha256===p.sha256,'READER_PEER_TOOL_SOURCE_CHANGED');
 await privateNewFile(join(work,'verification.json'),canonical({format:'IDMS_WORKFLOW_READER_PEER_TOOLS_V2',work,classes,agentJar,agent,inputs,classPins,toolsVerificationFile:tools.verificationFile}));
 const handle=Object.freeze({work,verificationFile:join(work,'verification.json')});owned.set(handle,record);return handle;
}
export async function verifyWorkflowReaderPeerToolsV2(handle){
 const s=owned.get(handle);need(s,'READER_PEER_TOOLS_NOT_OWNED');const base=await verifyWorkflowLifecycleToolsV1(s.tools);await backupDirectory(s.work);
 for(const p of[...s.classPins,{path:s.agentJar,...s.agent}])need(canonical(await coldFileHashV1(p.path,512*1024**2))===canonical({bytes:p.bytes,sha256:p.sha256}),'READER_PEER_TOOL_CHANGED');
 return{...s,java:base.java};
}

/** Wait on the actual newly spawned helper and both original output streams.
 * No timeout is converted into an exit, no PID is adopted and no signal is sent. */
async function originalHelper(java,args){
 const child=spawn(java,args,{env:lifecycleJavaEnvV1(),windowsHide:true,stdio:['ignore','pipe','pipe']});
 const parts={stdout:[],stderr:[]},sizes={stdout:0,stderr:0};let spawnError=false,overflow=false;
 child.once('error',()=>{spawnError=true;});
 for(const name of ['stdout','stderr'])child[name].on('data',bytes=>{sizes[name]+=bytes.length;if(sizes[name]>65536)overflow=true;else parts[name].push(bytes);});
 const exit=await new Promise(ok=>child.once('close',(code,signal)=>ok({code,signal})));
 const terminal={format:'IDMS_READER_PEER_BRACKET_HELPER_EXIT_V1',pid:child.pid??null,exit,originalChildHandleHeld:true,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed,spawnError,overflow,targetSignalSent:false};
 need(!spawnError&&!overflow&&exit.code===0&&exit.signal===null&&terminal.stdoutClosed&&terminal.stderrClosed,'READER_PEER_BRACKET_HELPER_EXIT');
 return{terminal,stdout:Buffer.concat(parts.stdout).toString('utf8'),stderr:Buffer.concat(parts.stderr).toString('utf8')};
}
export async function runWorkflowReaderPeerHelperV2(tools,pid,binding,{operation,leaseId,requestId,tenantId,configSha256}){
 const s=await verifyWorkflowReaderPeerToolsV2(tools),base=await verifyWorkflowLifecycleToolsV1(s.tools),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
 need(Number.isInteger(pid)&&pid>0&&uuid(leaseId)&&uuid(requestId)&&['ACQUIRE','PROBE','CAPTURE','RELEASE'].includes(operation)&&typeof tenantId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)&&/^[a-f0-9]{64}$/.test(configSha256)&&/^\d{10,16}$/.test(binding.start)&&!binding.requestId,'READER_PEER_HELPER_INPUT');
 const bound={...binding,requestId,agentSha256:s.agent.sha256};
 const result=await originalHelper(s.java,['--add-modules','jdk.attach','-cp',s.classes,'com.idms.lifecycle.OwnedReaderPeerBracketV1',String(pid),lifecycleOptionsV1(binding),base.agentJar,lifecycleOptionsV1(bound),s.agentJar,operation,leaseId,tenantId,configSha256]);
 need(result.stderr===''&&result.stdout.endsWith('\n'),'READER_PEER_BRACKET_OUTPUT');
 const lines=result.stdout.trimEnd().split(/\r?\n/);need(lines.length===2&&lines[0]==='OWNED_READER_PEER_AGENT_RETURNED','READER_PEER_BRACKET_OUTPUT');
 const bracket=JSON.parse(lines[1]);need(Object.keys(bracket).sort().join(',')==='after,before,format,requestId'&&bracket.format==='IDMS_READER_PEER_LIFECYCLE_BRACKET_V1'&&bracket.requestId===requestId,'READER_PEER_BRACKET_OUTPUT');
 const expected={format:'IDMS_WORKFLOW_LIFECYCLE_V1',phase:'BOUND',pid:String(pid),start:binding.start,owner:binding.owner,deployment:binding.deployment,jarSha256:binding.jarSha256,agentSha256:binding.agentSha256,requestId:'-',directory:binding.directory};
 need(canonical(bracket.before)===canonical(expected)&&canonical(bracket.after)===canonical(expected),'READER_PEER_BRACKET_IDENTITY');
 await verifyWorkflowReaderPeerToolsV2(tools);
 const evidenceFile=join(binding.directory,'reader-peer-helper-'+requestId+'.private.json'),evidence={format:'IDMS_READER_PEER_ORIGINAL_LIFECYCLE_BRACKET_V1',binding:bound,request:{operation,leaseId,requestId,tenantId,configSha256},bracket,helperTerminal:result.terminal,observedAt:new Date().toISOString(),freshLifecycleProbes:2,freshOriginalPeerAgentOperations:1,helperProcessesStarted:1,cachedObservationUsed:false};
 await privateNewFile(evidenceFile,canonical(evidence));return{bound,bracket,evidenceFile};
}
