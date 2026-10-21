import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,readdir,realpath} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory} from './field-backup-io.mjs';
import {coldFileHashV1} from './pg-cold-image-tools-v1.mjs';
import {canonical} from '../server/imports.ts';
const exec=promisify(execFile),registered=new WeakMap(),need=(v,c)=>{if(!v)throw Error(c);};
export const lifecycleJavaSourcesV1=['LifecycleWireV1.java','OwnedSpringAttachV1.java','OwnedSpringShutdownAgentV1.java'].map(n=>'scripts/lifecycle-java/'+n);
export function lifecycleJavaEnvV1(){const env={...process.env};for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH','SPRING_APPLICATION_JSON','SPRING_CONFIG_LOCATION','SPRING_CONFIG_ADDITIONAL_LOCATION'])delete env[key];return env;}
export async function buildWorkflowLifecycleToolsV1(parent){
 need(process.platform==='win32','LIFECYCLE_PLATFORM');parent=await backupDirectory(parent);const work=join(parent,'lifecycle-tools-'+randomUUID());await mkdir(work,{recursive:false,mode:0o700});await privateDirectory(work);const source=join(work,'source'),classes=join(work,'classes');await mkdir(source);await mkdir(classes);
 const javaBin=await backupDirectory(await realpath(join(process.env.LOCALAPPDATA,'IDMS/runtime/jdk-21/bin'))),programs=[];
 for(const name of ['java.exe','javac.exe','jar.exe','attach.dll','java.dll','jli.dll','server/jvm.dll']){const path=join(javaBin,...name.split('/'));programs.push({path,...await coldFileHashV1(path,512*1024**2)});}
 const inputs=[];for(const path of lifecycleJavaSourcesV1){const bytes=await readFile(path),file=join(source,path.split('/').at(-1));await privateNewFile(file,bytes);inputs.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),file});}
 const env=lifecycleJavaEnvV1(),version=await exec(join(javaBin,'java.exe'),['-version'],{env,windowsHide:true,maxBuffer:65536});need(/(?:openjdk|java) version "21\./.test(version.stderr),'LIFECYCLE_JDK_VERSION');
 const compiled=await exec(join(javaBin,'javac.exe'),['--release','21','--add-modules','jdk.attach','-d',classes,...inputs.map(v=>v.file)],{env,windowsHide:true,maxBuffer:1024**2,timeout:120000});await privateNewFile(join(work,'compile.log'),compiled.stdout+compiled.stderr);
 const manifest=join(work,'manifest.mf');await privateNewFile(manifest,'Manifest-Version: 1.0\nAgent-Class: com.idms.lifecycle.OwnedSpringShutdownAgentV1\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n');const agentJar=join(work,'owned-spring-shutdown-v1.jar');await exec(join(javaBin,'jar.exe'),['--create','--file',agentJar,'--manifest',manifest,'-C',classes,'.'],{env,windowsHide:true,maxBuffer:65536,timeout:120000});
 const classDirectory=join(classes,'com/idms/lifecycle'),classPins=[];for(const name of (await readdir(classDirectory)).sort()){need(/^[A-Za-z0-9$]+\.class$/.test(name),'LIFECYCLE_CLASS');const path=join(classDirectory,name);classPins.push({path,...await coldFileHashV1(path)});}need(classPins.length===4,'LIFECYCLE_CLASSES');
 const agent=await coldFileHashV1(agentJar),data={format:'IDMS_WORKFLOW_LIFECYCLE_TOOLS_V1',work,javaBin,java:join(javaBin,'java.exe'),classes,agentJar,agent,programs,classPins,inputs,jdkVersion:version.stderr.trim()};for(const p of inputs)need((await coldFileHashV1(p.path)).sha256===p.sha256,'LIFECYCLE_INPUT_CHANGED');await privateNewFile(join(work,'verification.json'),canonical(data));const handle=Object.freeze({work,java:data.java,classes,agentJar,agentSha256:agent.sha256,verificationFile:join(work,'verification.json')});registered.set(handle,data);return handle;
}
export async function verifyWorkflowLifecycleToolsV1(handle){const data=registered.get(handle);need(data,'LIFECYCLE_TOOLS_NOT_OWNED');await backupDirectory(data.work);for(const pin of [...data.programs,...data.classPins,{path:data.agentJar,...data.agent}])need(canonical(await coldFileHashV1(pin.path,512*1024**2))===canonical({bytes:pin.bytes,sha256:pin.sha256}),'LIFECYCLE_TOOL_CHANGED');return data;}
export function lifecycleOptionsV1(v){return [v.owner,v.deployment,v.jarSha256,Buffer.from(v.directory).toString('base64url'),v.start??'-',v.requestId??'-',v.agentSha256,Buffer.from(v.jar).toString('base64url')].join('|');}
export async function runWorkflowLifecycleHelperV1(tools,mode,pid,binding){const data=await verifyWorkflowLifecycleToolsV1(tools);need(['PROBE','STOP'].includes(mode)&&Number.isInteger(pid)&&pid>0,'LIFECYCLE_HELPER_INPUT');return exec(data.java,['--add-modules','jdk.attach','-cp',data.classes,'com.idms.lifecycle.OwnedSpringAttachV1',mode,String(pid),lifecycleOptionsV1(binding),data.agentJar],{env:lifecycleJavaEnvV1(),windowsHide:true,maxBuffer:1024**2});}
