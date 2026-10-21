import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const workflowCancelBuildInputsV1=['pom.xml',...['Application','WorkflowController','RecoveryController','CancelReconciliationControllerV1'].map(n=>'src/main/java/com/idms/workflow/'+n+'.java'),...['application.properties','maintenance-v1.bpmn20.xml','workflow-cancel-reconcile-v1.sql','workflow-cancel-catalog-v1.sql'].map(n=>'src/main/resources/'+n)];
export async function buildWorkflowCancelV1(){
 const nonce=randomBytes(6).toString('hex'),work=resolve('work/workflow-cancel-build-v1-20261021',nonce),project=join(work,'source'),base=resolve('services/workflow'),original=join(base,'target/idms-workflow-0.1.0.jar'),originalSha=sha(await readFile(original));
 await mkdir(work,{recursive:true});await mkdir(project);const inputs=[];
 for(const path of workflowCancelBuildInputsV1){const bytes=await readFile(join(base,path)),to=join(project,path);await mkdir(dirname(to),{recursive:true});await copyFile(join(base,path),to);inputs.push({path:'services/workflow/'+path,sha256:sha(bytes)});}
 const runtime=join(process.env.LOCALAPPDATA,'IDMS/runtime'),maven=join(runtime,'apache-maven-3.9.11/bin/mvn.cmd');
 try{const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`& '${maven.replaceAll("'","''")}' -o -q -DskipTests package; exit $LASTEXITCODE`],{cwd:project,env:{...process.env,JAVA_HOME:join(runtime,'jdk-21')},windowsHide:true,timeout:300000,maxBuffer:2*1024*1024});await writeFile(join(work,'build.log'),r.stdout+'\n'+r.stderr);}
 catch(e){await writeFile(join(work,'build-failure.log'),String(e.stdout||'')+'\n'+String(e.stderr||''));throw Error('WORKFLOW_CANCEL_ISOLATED_BUILD_FAILED: '+work);}
 for(const row of inputs)if(sha(await readFile(row.path))!==row.sha256)throw Error('WORKFLOW_CANCEL_BUILD_INPUT_CHANGED');
 if(sha(await readFile(original))!==originalSha)throw Error('WORKFLOW_CANCEL_ORIGINAL_JAR_CHANGED');
 const jar=join(project,'target/idms-workflow-0.1.0.jar'),result={nonce,work,jar,jarSha256:sha(await readFile(jar)),originalJarSha256:originalSha,offline:true,inputs};
 await writeFile(join(work,'verification.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await buildWorkflowCancelV1()));
