import {lstat,readdir,realpath} from 'node:fs/promises';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {verifyWorkflowLifecycleToolsV1} from './workflow-lifecycle-portable-tools-v1.mjs';
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});},same=(a,b)=>canonical(a)===canonical(b),sha=v=>createHash('sha256').update(canonical(v)).digest('hex');
const id=s=>Object.fromEntries(['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])])),normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p),portable=p=>p.split(String.fromCharCode(92)).join('/');
async function tree(root){
 const directories=[],files=[];let total=0;
 async function visit(directory){
  const stat=await lstat(directory,{bigint:true});need(stat.isDirectory()&&!stat.isSymbolicLink()&&normal(await realpath(directory))===normal(directory),'CURRENT_JAVA_RUNTIME_DIRECTORY');directories.push({path:portable(relative(root,directory)),identity:id(stat)});need(directories.length<=1024,'CURRENT_JAVA_RUNTIME_DIRECTORY_LIMIT');
  const names=(await readdir(directory)).sort();for(const name of names){need(name!=='.'&&name!=='..'&&!/[/\\\u0000-\u001f\u007f]/.test(name),'CURRENT_JAVA_RUNTIME_FILE_NAME');const path=join(directory,name),part=relative(root,path);need(part&&!part.startsWith('..')&&!isAbsolute(part),'CURRENT_JAVA_RUNTIME_OUTSIDE_ROOT');const s=await lstat(path,{bigint:true});need(!s.isSymbolicLink(),'CURRENT_JAVA_RUNTIME_LINK');if(s.isDirectory())await visit(path);else{need(s.isFile()&&s.nlink===1n&&s.size>=0n&&s.size<=512n*1024n**2n,'CURRENT_JAVA_RUNTIME_FILE');total+=Number(s.size);need(total<=2*1024**3&&files.length<8192,'CURRENT_JAVA_RUNTIME_BYTE_OR_FILE_LIMIT');files.push({path:portable(part),identity:id(s),bytes:Number(s.size)});}}
  need(same(id(stat),id(await lstat(directory,{bigint:true}))),'CURRENT_JAVA_RUNTIME_DIRECTORY_CHANGED');
 }
 await visit(root);return{directories,files,totalBytes:total};
}
/** Complete self-contained JDK file description. This function creates no runtime or authorization capability. */
export async function snapshotColdCurrentDeploymentJavaRuntimeV1(lifecycleTools,...unexpected){
 need(unexpected.length===0,'CURRENT_JAVA_RUNTIME_ARGUMENTS');const tools=await verifyWorkflowLifecycleToolsV1(lifecycleTools),root=tools.javaHome;need(typeof root==='string'&&isAbsolute(root)&&resolve(root)===root,'CURRENT_JAVA_RUNTIME_ROOT');const before=await tree(root),files=[];
 for(const entry of before.files){const file=join(root,...entry.path.split('/'));need(same(id(await lstat(file,{bigint:true})),entry.identity),'CURRENT_JAVA_RUNTIME_FILE_CHANGED');const actual=await coldFileHashV1(file,512*1024**2);need(actual.bytes===entry.bytes&&same(id(await lstat(file,{bigint:true})),entry.identity),'CURRENT_JAVA_RUNTIME_FILE_CHANGED');files.push({...entry,sha256:actual.sha256});}
 same(before,await tree(root))||need(false,'CURRENT_JAVA_RUNTIME_TREE_CHANGED');need(files.length>7,'CURRENT_JAVA_RUNTIME_COVERAGE');for(const path of ['release','lib/modules','conf/security/java.security'])need(files.some(f=>f.path===path&&f.bytes>0),'CURRENT_JAVA_RUNTIME_REQUIRED_FILE');for(const program of tools.programs){const part=portable(relative(root,program.path)),entry=files.find(f=>f.path===part);need(entry&&entry.bytes===program.bytes&&entry.sha256===program.sha256,'CURRENT_JAVA_RUNTIME_ORIGINAL_TOOL_CHANGED');}need(await verifyWorkflowLifecycleToolsV1(lifecycleTools)===tools,'CURRENT_JAVA_RUNTIME_ORIGINAL_TOOL_CHANGED');
 const body={format:'CURRENT_DEPLOYMENT_SELF_CONTAINED_JAVA_RUNTIME_FILES_V1',javaHome:root,directories:before.directories,files,totalBytes:before.totalBytes,requiredRuntimeFiles:['release','lib/modules','conf/security/java.security'],originalDeclaredToolFilesVerified:tools.programs.length,descriptiveDataOnly:true,sourceAndCurrentUserAuthenticated:false,argumentsAndApplicationConfigurationBound:false,operatingSystemTrustedBaseIncluded:false,startupAuthorizationGranted:false,programStarted:false,fullGoalComplete:false};return{...body,sha256:sha(body)};
}
