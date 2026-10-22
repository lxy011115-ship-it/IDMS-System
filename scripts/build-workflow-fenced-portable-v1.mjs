import {workflowReservationBuildInputsV1} from './build-workflow-cancel-reservation-v1.mjs';
import {readFile,mkdir,readdir,realpath,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {backupDirectory} from './field-backup-io.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {verifyWorkflowLifecycleToolsV1,lifecycleJavaEnvV1} from './workflow-lifecycle-portable-tools-v1.mjs';
import {canonical} from '../server/imports.ts';

function change(s,a,b){if(s.split(a).length!==2)throw Error('FENCED_WORKFLOW_PATCH_BOUNDARY');return s.replace(a,b);}
const exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex'),need=(v,c)=>{if(!v)throw Error(c);};
const originalJar=resolve('services/workflow/target/idms-workflow-0.1.0.jar');
async function original(){try{return await coldFileHashV1(originalJar,256*1024**2);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function verifyOriginalWorkflowJarPortableV1(build){need(canonical(await original())===canonical(build.originalJar),'WORKFLOW_PORTABLE_ORIGINAL_JAR_CHANGED');}

/** Build a new private source copy through Maven's Java entry point, never a shell. */
export async function buildWorkflowFencedPortableV1({tools,mavenHome,workDirectory,offline=false,localRepository=null}){
 need(typeof offline==='boolean'&&(!offline||localRepository),'WORKFLOW_PORTABLE_BUILD_OPTIONS');
 const java=await verifyWorkflowLifecycleToolsV1(tools),parent=await backupDirectory(workDirectory),home=await backupDirectory(await realpath(mavenHome));
 const nonce=randomBytes(6).toString('hex'),work=join(parent,'wb-'+nonce),project=join(work,'source');await mkdir(work,{mode:0o700});await privateDirectory(work);await mkdir(project,{mode:0o700});
 const old=await original(),inputs=[],mavenPins=[];
 for(const path of workflowReservationBuildInputsV1){need(/^[A-Za-z0-9_./-]+$/.test(path)&&!path.split('/').includes('..'),'WORKFLOW_PORTABLE_SOURCE_PATH');const from=resolve('services/workflow',path),pin=await coldFileHashV1(from,1024**2),bytes=await readFile(from);need(hash(bytes)===pin.sha256,'WORKFLOW_PORTABLE_INPUT_READ');const target=join(project,path);await mkdir(dirname(target),{recursive:true,mode:0o700});await privateNewFile(target,bytes);inputs.push({path:'services/workflow/'+path,sha256:pin.sha256});}
 const helper='services/workflow-fenced-v1/WorkflowRuntimeSchemaV1.java',helperPin=await coldFileHashV1(helper,1024**2),bytes=await readFile(helper);need(hash(bytes)===helperPin.sha256,'WORKFLOW_FENCED_HELPER_READ');await privateNewFile(join(project,'src/main/java/com/idms/workflow/WorkflowRuntimeSchemaV1.java'),bytes);inputs.push({path:helper,sha256:hash(bytes)});
 const controller=join(project,'src/main/java/com/idms/workflow/WorkflowController.java');let s=await readFile(controller,'utf8');
 s=change(s,'record Account(String jdbcUrl,String user,String password,String serviceToken,String recoveryReadToken,String recoveryAuthorityId) {}','record Account(String jdbcUrl,String user,String password,String serviceToken,String recoveryReadToken,String recoveryAuthorityId,String schemaMode) {}');
 s=change(s,'            sql.execute("CREATE TABLE IF NOT EXISTS idms_workflow_cases', '            boolean runtime=WorkflowRuntimeSchemaV1.runtime(a.schemaMode());\n            if(runtime){WorkflowRuntimeSchemaV1.verifyTables(sql);}else{\n            sql.execute("CREATE TABLE IF NOT EXISTS idms_workflow_cases');
 s=change(s,'            var c=new SpringProcessEngineConfiguration();','            }\n            var c=new SpringProcessEngineConfiguration();');
 s=change(s,'c.setDatabaseSchemaUpdate("true")','c.setDatabaseSchemaUpdate(runtime?"false":"true")');
 s=change(s,'            engine.getRepositoryService().createDeployment().tenantId(tenantId)', '            if(!runtime)engine.getRepositoryService().createDeployment().tenantId(tenantId)');
 s=change(s,'ProcessDefinition definition=engine.getRepositoryService().createProcessDefinitionQuery()', 'ProcessDefinition definition=runtime?WorkflowRuntimeSchemaV1.definition(engine,tenantId):engine.getRepositoryService().createProcessDefinitionQuery()');await writeFile(controller,s);
 const boot=await backupDirectory(join(home,'boot')),lib=await backupDirectory(join(home,'lib')),conf=join(home,'bin/m2.conf');
 const boots=(await readdir(boot)).filter(n=>/^plexus-classworlds-[A-Za-z0-9_.-]+\.jar$/.test(n));need(boots.length===1,'WORKFLOW_PORTABLE_MAVEN_BOOT');
 for(const file of [conf,...boots.map(n=>join(boot,n)),...(await readdir(lib)).filter(n=>n.endsWith('.jar')).sort().map(n=>join(lib,n))])mavenPins.push({path:file,...await coldFileHashV1(file,64*1024**2)});
 need(mavenPins.length>=10,'WORKFLOW_PORTABLE_MAVEN_LIBRARIES');
 const settings=join(work,'settings.xml');await privateNewFile(settings,'<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><interactiveMode>false</interactiveMode></settings>\n');
 const repository=localRepository?await backupDirectory(await realpath(localRepository)):join(work,'repository');if(!localRepository)await mkdir(repository,{mode:0o700});
 const env=lifecycleJavaEnvV1();for(const k of Object.keys(env))if(/^(?:MAVEN_|M2_HOME$|MAVEN_ARGS$|MAVEN_OPTS$)/i.test(k))delete env[k];env.JAVA_HOME=java.javaHome;
 const launcher=['-Xms64m','-Xmx512m','-Dfile.encoding=UTF-8','-Dstyle.color=never','-Dmaven.home='+home,'-Dmaven.multiModuleProjectDirectory='+project,'-Dclassworlds.conf='+conf,'-cp',join(boot,boots[0]),'org.codehaus.plexus.classworlds.launcher.Launcher'];
 const version=await exec(java.java,[...launcher,'-B','-ntp','--version'],{cwd:project,env,windowsHide:true,maxBuffer:65536,timeout:30000}),versionLine=version.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().split(/\r?\n/)[0];
 if(process.env.GITHUB_ACTIONS==='true')console.log('::notice::Maven startup version: '+JSON.stringify(versionLine).replaceAll('%','%25').slice(0,240));
 need(/^Apache Maven 3\.9\.\d+(?:\s|$)/.test(versionLine),'WORKFLOW_PORTABLE_MAVEN_VERSION');
 await privateNewFile(join(work,'version.log'),version.stdout+version.stderr);
 try{const result=await exec(java.java,[...launcher,'-B','-ntp','--settings',settings,'--global-settings',settings,'-Dmaven.repo.local='+repository,...(offline?['--offline']:[]),'-DskipTests','package'],{cwd:project,env,windowsHide:true,maxBuffer:8*1024**2,timeout:900000});await privateNewFile(join(work,'build.log'),result.stdout+'\n'+result.stderr);}
 catch(e){await privateNewFile(join(work,'failure.private.log'),String(e.stdout||'')+'\n'+String(e.stderr||''));throw Error('WORKFLOW_PORTABLE_BUILD_FAILED: '+work);}
 for(const pin of inputs)need((await coldFileHashV1(pin.path,1024**2)).sha256===pin.sha256,'WORKFLOW_PORTABLE_INPUT_CHANGED');
 for(const pin of mavenPins)need(canonical(await coldFileHashV1(pin.path,64*1024**2))===canonical({bytes:pin.bytes,sha256:pin.sha256}),'WORKFLOW_PORTABLE_MAVEN_CHANGED');
 await verifyWorkflowLifecycleToolsV1(tools);const jar=join(project,'target/idms-workflow-0.1.0.jar'),result={format:'IDMS_WORKFLOW_FENCED_PORTABLE_BUILD_V1',nonce,work,jar,...await coldFileHashV1(jar,256*1024**2),generatedControllerSha256:hash(await readFile(controller)),runtimeModeNoCreateOrDeployment:true,originalJar:old,originalJarSha256:old?.sha256??null,offline,inputs,mavenHome:home,mavenVersion:version.stdout.trim(),mavenPins,repository};result.jarSha256=result.sha256;
 await verifyOriginalWorkflowJarPortableV1(result);await privateNewFile(join(work,'verification.json'),canonical(result));return result;
}
