import {workflowCancelBuildInputsV1} from './build-workflow-cancel-v1.mjs';
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const workflowReservationBuildInputsV1=[...workflowCancelBuildInputsV1,'src/main/java/com/idms/workflow/CancelReservationControllerV1.java','src/main/resources/workflow-cancel-reservation-v1.sql','src/main/resources/workflow-cancel-reservation-catalog-v1.sql'];
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
export async function buildWorkflowCancelReservationV1(){
 const nonce=randomBytes(6).toString('hex'),work=resolve('work/workflow-reservation-build-v1-20261021',nonce),project=join(work,'source'),base=resolve('services/workflow'),old=join(base,'target/idms-workflow-0.1.0.jar'),oldHash=sha(await readFile(old)),inputs=[];await mkdir(work,{recursive:true});await mkdir(project);
 for(const path of workflowReservationBuildInputsV1){const bytes=await readFile(join(base,path)),target=join(project,path);await mkdir(dirname(target),{recursive:true});await copyFile(join(base,path),target);inputs.push({path:'services/workflow/'+path,sha256:sha(bytes)});}
 const runtime=join(process.env.LOCALAPPDATA,'IDMS/runtime'),maven=join(runtime,'apache-maven-3.9.11/bin/mvn.cmd');
 try{const result=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`& '${maven.replaceAll("'","''")}' -o -q -DskipTests package; exit $LASTEXITCODE`],{cwd:project,env:{...process.env,JAVA_HOME:join(runtime,'jdk-21')},windowsHide:true,timeout:300000,maxBuffer:2*1024*1024});await writeFile(join(work,'build.log'),result.stdout+'\n'+result.stderr);}catch(e){await writeFile(join(work,'failure.log'),String(e.stdout||'')+'\n'+String(e.stderr||''));throw Error('WORKFLOW_RESERVATION_BUILD_FAILED: '+work);}
 for(const pin of inputs)if(sha(await readFile(pin.path))!==pin.sha256)throw Error('WORKFLOW_RESERVATION_BUILD_INPUT_CHANGED');if(sha(await readFile(old))!==oldHash)throw Error('WORKFLOW_RESERVATION_OLD_JAR_CHANGED');const jar=join(project,'target/idms-workflow-0.1.0.jar'),value={nonce,work,jar,jarSha256:sha(await readFile(jar)),originalJarSha256:oldHash,offline:true,inputs};await writeFile(join(work,'verification.json'),JSON.stringify(value,null,2)+'\n');return value;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await buildWorkflowCancelReservationV1()));
