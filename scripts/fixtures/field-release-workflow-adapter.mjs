import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,mkdir,access} from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname,basename,join} from 'node:path';
import {workflowJava} from '../workflow-local.mjs';
export {workflowReady} from '../workflow-local.mjs';
assert.equal(process.env.IDMS_FIELD_RELEASE_REGRESSION_QA,'1');
const directory=resolve('work/field-channel-20261017/workflow-release-build'),jar=join(directory,'idms-workflow-0.1.0.jar');
export async function buildWorkflow(){
 const base=await realpath(resolve('work/field-channel-20261017')),rel=relative(base,directory);assert.ok(!isAbsolute(rel)&&rel==='workflow-release-build');await mkdir(directory,{recursive:true});assert.equal(await realpath(directory),directory);
 const runtime=join(process.env.LOCALAPPDATA,'IDMS/runtime'),maven=join(runtime,'apache-maven-3.9.11/bin/mvn.cmd');await access(maven);await access(workflowJava);
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`& ${quote(maven)} -q -DskipTests ${quote('-Didms.build.directory='+directory)} package; exit $LASTEXITCODE`],{cwd:resolve('services/workflow'),env:{...process.env,JAVA_HOME:join(runtime,'jdk-21')},windowsHide:true,timeout:300000,maxBuffer:2*1024**2});await access(jar);
}
export function launchWorkflow(file,port=4047,options={}){
 assert.equal(port,4047);assert.equal(basename(file),'engine.json');assert.match(basename(dirname(resolve(file))),/^catalog-qa-[a-f0-9]{10}$/);assert.equal(Object.keys(options).length,0);
 return spawn(workflowJava,['-Xms64m','-Xmx384m','-Dfile.encoding=UTF-8','-jar',jar,'--server.address=127.0.0.1','--server.port='+port],{env:{...process.env,IDMS_WORKFLOW_CONFIG:file},windowsHide:true,stdio:['ignore','pipe','pipe']});
}
