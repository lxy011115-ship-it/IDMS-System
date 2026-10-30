import {execFile} from 'node:child_process';
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
export const workflowReaderPeerJavaSourcesV1=['scripts/lifecycle-java/LifecycleWireV1.java','scripts/lifecycle-java-peer-file-v4/OwnedReaderPeerAttachV1.java','scripts/lifecycle-java-peer-file-v4/OwnedReaderPeerAgentV1.java'];
export async function buildWorkflowReaderPeerToolsV1(parent,tools){
 const base=await verifyWorkflowLifecycleToolsV1(tools);parent=await backupDirectory(parent);
 const work=join(parent,'reader-peer-tools-'+randomUUID());await mkdir(work,{mode:0o700});await privateDirectory(work);
 const source=join(work,'source'),classes=join(work,'classes');await mkdir(source);await mkdir(classes);const inputs=[];
 for(const path of workflowReaderPeerJavaSourcesV1){const bytes=await readFile(path),file=join(source,path.split('/').at(-1));await privateNewFile(file,bytes);inputs.push({path,file,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const suffix=process.platform==='win32'?'.exe':'',env=lifecycleJavaEnvV1();
 const compiled=await exec(join(base.javaBin,'javac'+suffix),['--release','21','--add-modules','jdk.attach','-d',classes,...inputs.map(v=>v.file)],{env,windowsHide:true,maxBuffer:1024**2,timeout:120000});
 await privateNewFile(join(work,'compile.log'),compiled.stdout+compiled.stderr);
 const manifest=join(work,'manifest.mf');await privateNewFile(manifest,'Manifest-Version: 1.0\nAgent-Class: com.idms.lifecycle.OwnedReaderPeerAgentV1\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n');
 const agentJar=join(work,'owned-reader-peer-v1.jar');await exec(join(base.javaBin,'jar'+suffix),['--create','--file',agentJar,'--manifest',manifest,'-C',classes,'.'],{env,windowsHide:true,maxBuffer:65536,timeout:120000});
 const classPins=[];for(const n of(await readdir(join(classes,'com/idms/lifecycle'))).sort()){need(/^[A-Za-z0-9$]+\.class$/.test(n),'READER_PEER_CLASS');const path=join(classes,'com/idms/lifecycle',n);classPins.push({path,...await coldFileHashV1(path)});}
 need(classPins.length===4,'READER_PEER_CLASSES');const agent=await coldFileHashV1(agentJar),record={tools,work,classes,agentJar,agent,inputs,classPins};
 for(const p of inputs)need((await coldFileHashV1(p.path)).sha256===p.sha256,'READER_PEER_TOOL_SOURCE_CHANGED');
 await privateNewFile(join(work,'verification.json'),canonical({format:'IDMS_WORKFLOW_READER_PEER_TOOLS_V1',work,classes,agentJar,agent,inputs,classPins,toolsVerificationFile:tools.verificationFile}));
 const handle=Object.freeze({work,verificationFile:join(work,'verification.json')});owned.set(handle,record);return handle;
}
export async function verifyWorkflowReaderPeerToolsV1(handle){
 const s=owned.get(handle);need(s,'READER_PEER_TOOLS_NOT_OWNED');const base=await verifyWorkflowLifecycleToolsV1(s.tools);await backupDirectory(s.work);
 for(const p of[...s.classPins,{path:s.agentJar,...s.agent}])need(canonical(await coldFileHashV1(p.path,512*1024**2))===canonical({bytes:p.bytes,sha256:p.sha256}),'READER_PEER_TOOL_CHANGED');
 return{...s,java:base.java};
}
export async function runWorkflowReaderPeerHelperV1(tools,pid,binding,{operation,leaseId,requestId,tenantId,configSha256}){
 const s=await verifyWorkflowReaderPeerToolsV1(tools),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
 need(Number.isInteger(pid)&&pid>0&&uuid(leaseId)&&uuid(requestId)&&['ACQUIRE','PROBE','CAPTURE','RELEASE'].includes(operation)&&typeof tenantId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(tenantId)&&/^[a-f0-9]{64}$/.test(configSha256),'READER_PEER_HELPER_INPUT');
 const bound={...binding,requestId,agentSha256:s.agent.sha256};
 await exec(s.java,['--add-modules','jdk.attach','-cp',s.classes,'com.idms.lifecycle.OwnedReaderPeerAttachV1',String(pid),lifecycleOptionsV1(bound),s.agentJar,operation,leaseId,tenantId,configSha256],{env:lifecycleJavaEnvV1(),windowsHide:true,maxBuffer:65536});
 await verifyWorkflowReaderPeerToolsV1(tools);return bound;
}
