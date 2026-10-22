import {workflowReservationBuildInputsV1} from './build-workflow-cancel-reservation-v1.mjs';
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
function change(s,a,b){if(s.split(a).length!==2)throw Error('FENCED_WORKFLOW_PATCH_BOUNDARY');return s.replace(a,b);}
export async function buildWorkflowFencedV1(){
 const nonce=randomBytes(6).toString('hex'),work=resolve('work/workflow-fenced-build-v1-20261022',nonce),project=join(work,'source'),base=resolve('services/workflow'),original=join(base,'target/idms-workflow-0.1.0.jar'),originalJarSha256=hash(await readFile(original)),inputs=[];await mkdir(work,{recursive:true});await mkdir(project);
 for(const path of workflowReservationBuildInputsV1){const bytes=await readFile(join(base,path)),target=join(project,path);await mkdir(dirname(target),{recursive:true});await copyFile(join(base,path),target);inputs.push({path:'services/workflow/'+path,sha256:hash(bytes)});}
 const helper='services/workflow-fenced-v1/WorkflowRuntimeSchemaV1.java',bytes=await readFile(helper);await writeFile(join(project,'src/main/java/com/idms/workflow/WorkflowRuntimeSchemaV1.java'),bytes,{flag:'wx'});inputs.push({path:helper,sha256:hash(bytes)});
 const controller=join(project,'src/main/java/com/idms/workflow/WorkflowController.java');let s=await readFile(controller,'utf8');
 s=change(s,'record Account(String jdbcUrl,String user,String password,String serviceToken,String recoveryReadToken,String recoveryAuthorityId) {}','record Account(String jdbcUrl,String user,String password,String serviceToken,String recoveryReadToken,String recoveryAuthorityId,String schemaMode) {}');
 s=change(s,'            sql.execute("CREATE TABLE IF NOT EXISTS idms_workflow_cases', '            boolean runtime=WorkflowRuntimeSchemaV1.runtime(a.schemaMode());\n            if(runtime){WorkflowRuntimeSchemaV1.verifyTables(sql);}else{\n            sql.execute("CREATE TABLE IF NOT EXISTS idms_workflow_cases');
 s=change(s,'            var c=new SpringProcessEngineConfiguration();','            }\n            var c=new SpringProcessEngineConfiguration();');
 s=change(s,'c.setDatabaseSchemaUpdate("true")','c.setDatabaseSchemaUpdate(runtime?"false":"true")');
 s=change(s,'            engine.getRepositoryService().createDeployment().tenantId(tenantId)', '            if(!runtime)engine.getRepositoryService().createDeployment().tenantId(tenantId)');
 s=change(s,'ProcessDefinition definition=engine.getRepositoryService().createProcessDefinitionQuery()', 'ProcessDefinition definition=runtime?WorkflowRuntimeSchemaV1.definition(engine,tenantId):engine.getRepositoryService().createProcessDefinitionQuery()');await writeFile(controller,s);
 const runtime=join(process.env.LOCALAPPDATA,'IDMS/runtime'),maven=join(runtime,'apache-maven-3.9.11/bin/mvn.cmd');try{const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`& '${maven.replaceAll("'","''")}' -o -q -DskipTests package; exit $LASTEXITCODE`],{cwd:project,env:{...process.env,JAVA_HOME:join(runtime,'jdk-21')},windowsHide:true,timeout:300000,maxBuffer:2*1024**2});await writeFile(join(work,'build.log'),r.stdout+'\n'+r.stderr);}catch(e){await writeFile(join(work,'failure.log'),String(e.stdout||'')+'\n'+String(e.stderr||''));throw Error('FENCED_WORKFLOW_BUILD_FAILED '+work);}
 for(const p of inputs)if(hash(await readFile(p.path))!==p.sha256)throw Error('FENCED_WORKFLOW_INPUT_CHANGED');if(hash(await readFile(original))!==originalJarSha256)throw Error('FENCED_WORKFLOW_ORIGINAL_JAR_CHANGED');const jar=join(project,'target/idms-workflow-0.1.0.jar'),result={nonce,work,jar,jarSha256:hash(await readFile(jar)),originalJarSha256,offline:true,inputs,generatedControllerSha256:hash(await readFile(controller)),runtimeModeNoCreateOrDeployment:true};await writeFile(join(work,'verification.json'),JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await buildWorkflowFencedV1()));
