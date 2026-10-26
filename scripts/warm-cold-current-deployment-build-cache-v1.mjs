import assert from 'node:assert/strict';
import {readFile,mkdir,realpath,lstat} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {buildWorkflowLifecycleToolsV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {buildWorkflowFencedPortableV1} from './build-workflow-fenced-portable-v1.mjs';
import {buildWorkflowReviewReaderV4} from './build-workflow-review-reader-v4.mjs';
const ownFile=fileURLToPath(import.meta.url),sha=b=>createHash('sha256').update(b).digest('hex');
async function directory(path){assert(typeof path==='string'&&isAbsolute(path)&&resolve(path)===path);for(let item=path;;item=dirname(item)){const stat=await lstat(item);assert(stat.isDirectory()&&!stat.isSymbolicLink());const actual=await realpath(item);assert.equal(process.platform==='win32'?actual.toLowerCase():actual,process.platform==='win32'?item.toLowerCase():item);if(dirname(item)===item)break;}}

/** Download and build the actual two Maven projects before any offline native case. */
export async function warmColdCurrentDeploymentBuildCacheV1({javaHome,mavenHome,workDirectory,localRepository}){
 assert([javaHome,mavenHome,workDirectory,localRepository].every(p=>typeof p==='string'&&isAbsolute(p)&&resolve(p)===p));assert.notEqual(workDirectory,localRepository);await directory(javaHome);await directory(mavenHome);await directory(localRepository);await mkdir(workDirectory,{recursive:false,mode:0o700});await privateDirectory(workDirectory);
 const sourceSha256=sha(await readFile(ownFile)),tools=await buildWorkflowLifecycleToolsV1(workDirectory,{javaHome});let stage='FENCED_WORKFLOW';
 try{
  const workflow=await buildWorkflowFencedPortableV1({tools,mavenHome,workDirectory,offline:false,localRepository});assert.equal(workflow.offline,false);assert.equal(workflow.repository,localRepository);
  stage='REVIEW_READER';const reader=await buildWorkflowReviewReaderV4({tools,mavenHome,workDirectory,offline:false,localRepository});assert.equal(reader.offline,false);assert.equal(reader.repository,localRepository);
  assert.equal(sha(await readFile(ownFile)),sourceSha256);for(const build of [workflow,reader]){assert.equal(sha(await readFile(build.jar)),build.jarSha256);for(const pin of build.inputs)assert.equal(sha(await readFile(pin.path)),pin.sha256);}
  const result={format:'COLD_CURRENT_DEPLOYMENT_ACTUAL_ONLINE_BUILD_CACHE_WARM_V1',platform:process.platform,nodeVersion:process.version,actualWorkflowAndReaderProjectsBuiltOnline:2,workflowJarSha256:workflow.jarSha256,readerJarSha256:reader.jarSha256,originalSourceInputsAndOriginalJarUnchanged:true,actualSourceInputsChecked:workflow.inputs.length+reader.inputs.length,noDatabaseIdentityBrokerOrBusinessServerStarted:true,offlineBuildsNotSubstitutedWithFakeResults:true,newHeldOrProgramApprovalProven:false,fullGoalComplete:false};await privateNewFile(join(workDirectory,'warm-result.private.json'),JSON.stringify({result,workflow,reader},null,2));return{result,tools,workflow,reader};
 }catch(error){await privateNewFile(join(workDirectory,'warm-failure.private.json'),JSON.stringify({stage,code:'ACTUAL_ONLINE_MAVEN_BUILD_FAILED',errorMessage:String(error.message),stack:String(error.stack),fullGoalComplete:false},null,2));throw Object.assign(Error('CURRENT_DEPLOYMENT_BUILD_CACHE_WARM_FAILED'),{safeStage:stage});}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(ownFile)){
 assert.equal(process.argv.length,6);warmColdCurrentDeploymentBuildCacheV1({javaHome:resolve(process.argv[2]),mavenHome:resolve(process.argv[3]),workDirectory:resolve(process.argv[4]),localRepository:resolve(process.argv[5])}).then(v=>console.log(JSON.stringify(v.result))).catch(error=>{console.error(JSON.stringify({format:'COLD_CURRENT_DEPLOYMENT_BUILD_CACHE_SAFE_FAILURE_V1',code:'CURRENT_DEPLOYMENT_BUILD_CACHE_WARM_FAILED',stage:/^[A-Z_]+$/.test(error.safeStage??'')?error.safeStage:'INPUT',rawPrivateLogsPrinted:false,fullGoalComplete:false}));process.exitCode=1;});
}
