import {readFile,realpath,lstat,open,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtimeBoundedFile} from '../server/runtime-file.ts';
import {validateRuntimeConfig} from '../server/postgres-security.ts';
import {authRegistryFile,businessBinding,validateAuthRuntime} from '../server/auth-store.ts';
import {validateKeyRing} from '../server/auth-state.ts';
import {readinessPolicy} from '../server/runtime-readiness.ts';
import {validateIdentityConfig} from './keycloak-runtime.mjs';
import {openExistingSqlite} from '../services/existing-sqlite.ts';

const exec=promisify(execFile);
export const bindingFile=resolve('.local/existing-platform.json');
export class StartupError extends Error {constructor(code){super(code);this.code=code;}}
export const need=(condition,code)=>{if(!condition)throw new StartupError(code);};
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function jsonFile(file,max=65536){try{return JSON.parse((await runtimeBoundedFile(file,max)).toString('utf8'));}catch{throw new StartupError('INPUT_MISSING_OR_INVALID');}}
export async function filePin(file,{max=64*1024**2}={}){
 const path=await realpath(resolve(file)),before=await lstat(path);
 need(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=max,'INPUT_SIZE_OR_TYPE');
 const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);
 const after=await lstat(path);need(before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'INPUT_CHANGED');
 return {path,bytes:before.size,sha256:hash.digest('hex')};
}
export async function verifyPin(pin){
 need(pin&&typeof pin.path==='string'&&resolve(pin.path)===pin.path&&/^[a-f0-9]{64}$/.test(pin.sha256)&&Number.isSafeInteger(pin.bytes),'BINDING_INVALID');
 need(await realpath(pin.path)===pin.path,'LINKED_INPUT_REFUSED');const actual=await filePin(pin.path,{max:Math.max(pin.bytes,1)});
 need(actual.bytes===pin.bytes&&actual.sha256===pin.sha256,'BOUND_INPUT_CHANGED');
}
export async function pgIdentity(runtimeRoot){
 const data=await realpath(join(runtimeRoot,'postgres-data')),s=await lstat(data);
 const output=await exec(join(runtimeRoot,'pgsql/bin/pg_controldata.exe'),[data],{windowsHide:true,timeout:5000,maxBuffer:32768,env:{...process.env,LC_ALL:'C'}});
 const id=output.stdout.match(/Database system identifier:\s*(\d+)/)?.[1];need(id,'PG_IDENTITY_UNCONFIRMED');
 return {data,device:s.dev,inode:s.ino,systemIdentifier:id};
}
export async function selectRuntime(candidates,{canonical=realpath,readIdentity=pgIdentity}={}){
 const found=[];
 for(const candidate of candidates){let runtime;try{runtime=await canonical(candidate);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const identity=await readIdentity(runtime);if(!found.some(f=>f.identity.data===identity.data&&f.identity.inode===identity.inode&&f.identity.device===identity.device))found.push({runtime,identity});
 }
 need(found.length===1,found.length?'MULTIPLE_DATABASE_DEPLOYMENTS':'EXISTING_RUNTIME_MISSING');return found[0];
}
export async function workflowSourceDigest(){
 const files=['services/workflow/src/main/java/com/idms/workflow/WorkflowStartup.java','services/workflow/src/main/java/com/idms/workflow/WorkflowController.java','services/workflow/src/main/java/com/idms/workflow/Application.java','services/workflow/src/main/resources/maintenance-v1.bpmn20.xml','services/workflow/pom.xml'];
 const values=[];for(const file of files)values.push({file,sha256:sha(await runtimeBoundedFile(resolve(file),512*1024))});return sha(JSON.stringify(values));
}
export async function runtimeSourceEvidence(){
 const files=[];let newestMtimeMs=0;
 const visit=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){
  need(!entry.isSymbolicLink(),'LINKED_SOURCE_REFUSED');const path=join(directory,entry.name);
  if(entry.isDirectory()){if(!['target','node_modules','build','dist'].includes(entry.name))await visit(path);}
  else if(/\.(ts|js|mjs|json|html|css)$/.test(entry.name)&&!entry.name.endsWith('.test.ts')){const s=await lstat(path);need(s.isFile()&&s.nlink===1&&s.size<=4*1024**2,'SOURCE_SIZE_OR_TYPE');files.push({name:path.replaceAll('\\','/'),sha256:sha(await runtimeBoundedFile(resolve(path),4*1024**2))});newestMtimeMs=Math.max(newestMtimeMs,s.mtimeMs);need(files.length<=4096,'SOURCE_COUNT_LIMIT');}
 }};
 for(const directory of ['server','integrations','public','services'])await visit(directory);
 for(const path of ['package.json','package-lock.json']){const s=await lstat(path);files.push({name:path,sha256:sha(await runtimeBoundedFile(resolve(path),4*1024**2))});newestMtimeMs=Math.max(newestMtimeMs,s.mtimeMs);}
 files.sort((a,b)=>a.name.localeCompare(b.name));return {digest:sha(JSON.stringify(files)),files:files.length,newestMtimeMs};
}
export async function collectExistingInputs({runtimeRoot,readinessFile}){
 const runtime=await realpath(runtimeRoot),identity=await pgIdentity(runtime);
 const business=validateRuntimeConfig(await jsonFile('.local/postgres-business.json'));
 need(business.host==='127.0.0.1','LOCAL_ENDPOINT_REQUIRED');
 const root=await jsonFile('.local/postgres-runtime.json'),id=validateIdentityConfig(await jsonFile('.local/keycloak-runtime.json'));
 need(root.host===business.host&&root.port===business.port&&JSON.stringify(Object.keys(root.tenants).sort())===JSON.stringify(Object.keys(business.tenants).sort()),'DEPLOYMENT_BINDING_MISMATCH');
 const authFile=authRegistryFile(business),auth=validateAuthRuntime(await jsonFile(authFile),businessBinding(business));
 need(auth.host===business.host&&auth.port===business.port,'SESSION_BINDING_MISMATCH');validateKeyRing(await jsonFile(auth.keyFile));
 const telemetry=await jsonFile('.local/mqtt/telemetry-runtime.json'),workflow=await jsonFile('.local/workflow/runtime.json'),workflowClient=await jsonFile('.local/workflow/client.json'),ai=await jsonFile('.local/ai/runtime.json'),aiClient=await jsonFile('.local/ai/client.json');
 const tenants=Object.keys(business.tenants).sort();
 for(const object of [workflow,workflowClient,ai,aiClient])need(JSON.stringify(Object.keys(object.tenants||{}).sort())===JSON.stringify(tenants),'TENANT_BINDING_MISMATCH');
 for(const t of tenants){
  const w=workflow.tenants[t],account=root.workflowTenants?.[t];
  need(account&&w.jdbcUrl===`jdbc:postgresql://${root.host}:${root.port}/${account.database}`&&w.user===account.user&&w.password===account.password&&typeof w.serviceToken==='string'&&w.serviceToken.length>=32&&w.serviceToken===workflowClient.tenants[t].serviceToken,'WORKFLOW_BINDING_MISMATCH');
  need(ai.tenants[t].serviceToken?.length>=32&&ai.tenants[t].serviceToken===aiClient.tenants[t].serviceToken,'AI_BINDING_MISMATCH');
 }
 need(workflowClient.baseUrl==='http://127.0.0.1:4016'&&aiClient.baseUrl==='http://127.0.0.1:4018'&&ai.modelUrl==='http://127.0.0.1:11435'&&ai.model.name==='qwen3:4b'&&ai.model.digest==='sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7'&&JSON.stringify(ai.model)===JSON.stringify(aiClient.model),'SERVICE_ENDPOINT_MISMATCH');
 need(telemetry.version===1&&telemetry.mqtt.url==='mqtt://127.0.0.1:1884'&&telemetry.sources?.length===1&&telemetry.sources[0].origin==='SIMULATOR'&&telemetry.sources[0].tenantId==='sandbox'&&telemetry.sources[0].statusUrl==='http://127.0.0.1:4014/status'&&telemetry.simulator.port===4841&&telemetry.simulator.statusPort===4015&&telemetry.edge.endpoint==='opc.tcp://127.0.0.1:4841','TELEMETRY_BINDING_MISMATCH');
 const broker=String(await runtimeBoundedFile(resolve('.local/mqtt/mosquitto.conf'),16384));
 const paths={password_file:resolve('.local/mqtt/mqtt-passwords'),acl_file:resolve('.local/mqtt/mqtt-acl')};
 need(/^listener 1884 127\.0\.0\.1\r?$/m.test(broker)&&/^allow_anonymous false\r?$/m.test(broker),'BROKER_CONFIG_MISMATCH');
 for(const [key,file]of Object.entries(paths))need(resolve(broker.match(new RegExp('^'+key+' (.+)$','m'))?.[1]?.trim()||'')===file,'BROKER_CONFIG_MISMATCH');
 const policy=readinessPolicy(await jsonFile(readinessFile));need(policy.enabled,'READINESS_DISABLED');
 const receipt=await jsonFile('.local/workflow/runtime-build.json'),jar=await filePin('services/workflow/target/idms-workflow-0.1.0.jar');
 need(receipt.contract==='IDMS_EXISTING_WORKFLOW_V1'&&receipt.jarSha256===jar.sha256&&receipt.sourceDigest===await workflowSourceDigest(),'WORKFLOW_BUILD_NOT_VERIFIED');
 const model=join(dirname(runtime),'models/manifests/registry.ollama.ai/library/qwen3/4b'),modelBytes=await runtimeBoundedFile(await realpath(model),65536);
 need('sha256:'+sha(modelBytes)===ai.model.digest,'MODEL_BINDING_MISMATCH');
 const manifest=JSON.parse(modelBytes),modelRoot=join(dirname(runtime),'models');
 for(const part of [manifest.config,...manifest.layers]){need(/^sha256:[a-f0-9]{64}$/.test(part.digest)&&Number.isSafeInteger(part.size)&&part.size>0,'MODEL_MANIFEST_INVALID');const p=await realpath(join(modelRoot,'blobs',part.digest.replace(':','-'))),s=await lstat(p);need(s.isFile()&&s.size===part.size,'MODEL_LAYER_MISSING');}
 const token=String(await runtimeBoundedFile(resolve('.local/service-token'),256)).trim();need(/^[\w-]{32,128}$/.test(token),'SERVICE_TOKEN_MISSING');
 const spool=openExistingSqlite(telemetry.edge.spool,'edge',telemetry.sources[0],{readOnly:true});spool.close();
 for(const tenant of tenants){const db=openExistingSqlite(join(ai.dataDirectory,tenant,'receipts.sqlite'),'ai',undefined,{readOnly:true});db.close();}
 const names={business:'.local/postgres-business.json',database:'.local/postgres-runtime.json',identity:'.local/keycloak-runtime.json',session:authFile,keyRing:auth.keyFile,telemetry:'.local/mqtt/telemetry-runtime.json',broker:'.local/mqtt/mosquitto.conf',brokerPasswords:paths.password_file,brokerAcl:paths.acl_file,workflow:'.local/workflow/runtime.json',workflowClient:'.local/workflow/client.json',workflowBuild:'.local/workflow/runtime-build.json',workflowJar:jar.path,ai:'.local/ai/runtime.json',aiClient:'.local/ai/client.json',serviceToken:'.local/service-token',readiness:readinessFile,modelManifest:model,java:join(runtime,'jdk-21/bin/java.exe'),pgCtl:join(runtime,'pgsql/bin/pg_ctl.exe'),postgres:join(runtime,'pgsql/bin/postgres.exe'),keycloak:join(runtime,'keycloak-26.8.1/lib/quarkus-run.jar'),brokerExe:join(runtime,'mosquitto-2.1.2/mosquitto.exe'),ollama:join(runtime,'ollama-0.40.4/ollama.exe')};
 const files={};for(const [name,path]of Object.entries(names))files[name]=await filePin(path);
 return {format:1,purpose:'EXISTING_PLATFORM_RUNTIME',project:await realpath(resolve('.')),runtime,identity,files};
}
export async function loadExistingBinding(file=bindingFile){
 const binding=await jsonFile(file,262144);need(binding.format===1&&binding.purpose==='EXISTING_PLATFORM_RUNTIME'&&binding.project===await realpath(resolve('.'))&&binding.files&&Object.keys(binding.files).length===24,'BINDING_INVALID');
 for(const pin of Object.values(binding.files))await verifyPin(pin);
 const pg=await pgIdentity(binding.runtime);need(JSON.stringify(pg)===JSON.stringify(binding.identity),'PG_DEPLOYMENT_CHANGED');
 const fresh=await collectExistingInputs({runtimeRoot:binding.runtime,readinessFile:binding.files.readiness.path});
 need(JSON.stringify(fresh)===JSON.stringify(binding),'BINDING_DRIFT');return binding;
}
