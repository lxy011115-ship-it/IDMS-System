import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory} from './field-backup-io.mjs';
import {coldFileHashV1} from './pg-cold-image-tools-v1.mjs';
import {canonical} from '../server/imports.ts';
const exec=promisify(execFile),owned=new WeakMap(),need=(v,c)=>{if(!v)throw Error(c);};
export const identityJavaSourcesV1=['IdentityLifecycleWireV1.java','OwnedIdentityAttachV1.java','OwnedIdentityShutdownAgentV1.java'].map(v=>'scripts/lifecycle-java/'+v);
export function identityJavaEnvV1(){const env={...process.env};for(const key of Object.keys(env))if(/^(?:KC_|KCRAW_|QUARKUS_|JAVA_OPTS|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/i.test(key))delete env[key];return env;}
export async function buildIdentityLifecycleToolsV1(parent){
 need(process.platform==='win32','IDENTITY_PLATFORM');const work=join(await backupDirectory(parent),'identity-tools-'+randomUUID());await mkdir(work,{mode:0o700});await privateDirectory(work);const source=join(work,'source'),classes=join(work,'classes');await mkdir(source);await mkdir(classes);
 const javaBin=await realpath(join(process.env.LOCALAPPDATA,'IDMS/runtime/jdk-21/bin')),programs=[];for(const n of ['java.exe','javac.exe','jar.exe','attach.dll','java.dll','jli.dll','server/jvm.dll']){const path=join(javaBin,...n.split('/'));programs.push({path,...await coldFileHashV1(path,512*1024**2)});}
 const inputs=[];for(const path of identityJavaSourcesV1){const bytes=await readFile(path),file=join(source,path.split('/').at(-1));await privateNewFile(file,bytes);inputs.push({path,file,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const env=identityJavaEnvV1(),version=await exec(join(javaBin,'java.exe'),['-version'],{env,windowsHide:true});need(/version "21\./.test(version.stderr),'IDENTITY_JDK');
 const compiled=await exec(join(javaBin,'javac.exe'),['--release','21','--add-modules','jdk.attach','-d',classes,...inputs.map(p=>p.file)],{env,windowsHide:true,maxBuffer:1024**2});await privateNewFile(join(work,'compile.log'),compiled.stdout+compiled.stderr);
 const manifest=join(work,'manifest.mf');await privateNewFile(manifest,'Manifest-Version: 1.0\nAgent-Class: com.idms.identitylife.OwnedIdentityShutdownAgentV1\nCan-Redefine-Classes: false\nCan-Retransform-Classes: false\n\n');const agentJar=join(work,'owned-identity-shutdown-v1.jar');await exec(join(javaBin,'jar.exe'),['--create','--file',agentJar,'--manifest',manifest,'-C',classes,'.'],{env,windowsHide:true});
 const pins=[];for(const n of (await readdir(join(classes,'com/idms/identitylife'))).sort()){need(/^[A-Za-z0-9$]+\.class$/.test(n),'IDENTITY_CLASS');const path=join(classes,'com/idms/identitylife',n);pins.push({path,...await coldFileHashV1(path)});}need(pins.length===4,'IDENTITY_CLASSES');const agent=await coldFileHashV1(agentJar),data={work,java:join(javaBin,'java.exe'),javaBin,classes,agentJar,agent,inputs,programs,pins,jdkVersion:version.stderr.trim()};for(const p of inputs)need((await coldFileHashV1(p.path)).sha256===p.sha256,'IDENTITY_SOURCE_CHANGED');await privateNewFile(join(work,'verification.json'),canonical(data));const handle=Object.freeze({work,java:data.java,classes,agentJar,agentSha256:agent.sha256});owned.set(handle,data);return handle;
}
export async function verifyIdentityLifecycleToolsV1(handle){const d=owned.get(handle);need(d,'IDENTITY_TOOLS_NOT_OWNED');for(const p of [...d.programs,...d.pins,{path:d.agentJar,...d.agent}])need(canonical(await coldFileHashV1(p.path,512*1024**2))===canonical({bytes:p.bytes,sha256:p.sha256}),'IDENTITY_TOOLS_DRIFT');return d;}
export function identityLifecycleOptionsV1(b){return[b.owner,b.deployment,b.manifestSha256,Buffer.from(b.directory).toString('base64url'),b.start??'-',b.requestId??'-',b.agentSha256,Buffer.from(b.root).toString('base64url'),Buffer.from(b.manifest).toString('base64url')].join('|');}
export async function runIdentityLifecycleHelperV1(tools,mode,pid,binding){const d=await verifyIdentityLifecycleToolsV1(tools);need(['PROBE','STOP'].includes(mode)&&Number.isInteger(pid)&&pid>0,'IDENTITY_HELPER_INPUT');return exec(d.java,['--add-modules','jdk.attach','-cp',d.classes,'com.idms.identitylife.OwnedIdentityAttachV1',mode,String(pid),identityLifecycleOptionsV1(binding),d.agentJar],{env:identityJavaEnvV1(),windowsHide:true,maxBuffer:1024**2});}
